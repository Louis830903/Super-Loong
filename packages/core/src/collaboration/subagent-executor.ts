/**
 * SubagentExecutor — 子代理执行器工厂
 *
 * 为 SubagentManager 注入 executeFn（路 A：CrewExecutor 自动调用），
 * 并创建 spawn_subagent 全局工具（路 B：Agent 主动调用）。
 *
 * 学 OpenClaw sessions-spawn-tool.ts + subagent-spawn.ts 的分离模式：
 * - executeFn: fire-and-forget 回调，给 SubagentManager.spawn() 使用
 * - spawn 工具: 同步等待语义，给 Agent 工具调用使用
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import { AgentRuntime } from "../agent/runtime.js";
import type { AgentManager } from "../agent/manager.js";
import type { SecurityManager } from "../security/sandbox.js";
import type { MemoryManager } from "../memory/manager.js";
import type { SkillLoader } from "../skills/loader.js";
import type { SubagentManager } from "./subagent-spawn.js";
import type { SubagentExecuteFn } from "./subagent-spawn.js";
import type { SubagentAnnouncer } from "./subagent-announce.js";
import type {
  AgentConfig,
  ToolDefinition,
  ToolContext,
  ToolResult,
  LLMProviderConfig,
} from "../types/index.js";
import { z } from "zod";

const logger = pino({ name: "subagent-executor" });

// ─── 默认兜底 LLM 配置（风险 #3 缓解：无默认 Agent 时使用） ──
const FALLBACK_LLM: LLMProviderConfig = {
  type: "openai",
  model: "gpt-4o-mini",
};

// ─── spawn_subagent 工具参数 schema ─────────────────────────
const SpawnSubagentParams = z.object({
  task: z.string().describe("子代理的任务描述"),
  label: z.string().optional().describe("可读标签，如 'code-reviewer'"),
  timeout: z.number().optional().describe("超时毫秒数，默认使用全局配置"),
});

// ─── SubagentExecutor 类 ────────────────────────────────────

export class SubagentExecutor {
  constructor(
    private agentManager: AgentManager,
    private subagentManager: SubagentManager,
    private announcer: SubagentAnnouncer,
    private securityManager: SecurityManager,
    private memoryManager: MemoryManager,
    private skillLoader: SkillLoader,
    private platform: string,
    /** 闭包解耦 MessageRouter：返回默认 Agent ID 或 null */
    private getDefaultAgentId: () => string | null,
  ) {}

  // ─── 路 A：executeFn（fire-and-forget，供 CrewExecutor 使用）─

  /**
   * 创建符合 SubagentExecuteFn 签名的执行回调。
   * 由 SubagentManager.spawn() 在 Promise.resolve().then(...) 中异步调用。
   */
  createExecuteFn(): SubagentExecuteFn {
    return async (
      systemPrompt: string,
      userMessage: string,
      _allowedTools: string[],
      sessionId: string,
    ): Promise<string> => {
      // 1. 取默认 Agent 的 LLM 配置（决策 1：继承父 Agent LLM）
      const parentLlm = this.resolveParentLlm();

      // 2. 取全局工具定义（决策 2：共享全部全局工具）
      const globalTools = this.agentManager.getGlobalTools();

      // 3. 创建临时 AgentRuntime — 不注册到 AgentManager（决策 3）
      const subConfig: AgentConfig = {
        id: `sub_${uuid()}`,
        name: "Sub-Agent",
        systemPrompt, // 7 段式子代理提示词，覆盖 PromptEngine L1 身份层
        llmProvider: parentLlm,
        tools: [], // 工具由 AgentRuntimeOptions.tools 注入，不走 config.tools
        skills: [],
        channels: [],
        memoryEnabled: false, // 子代理不启用记忆，避免污染全局记忆
        maxToolIterations: 25,
        metadata: { source: "subagent-spawn" },
      };

      const runtime = new AgentRuntime({
        config: subConfig,
        tools: globalTools,
        promptMode: "minimal",
        securityManager: this.securityManager,
        memoryManager: this.memoryManager,
        skillLoader: this.skillLoader,
        platform: this.platform,
        enablePersistence: false, // 子代理对话不持久化到 DB
        // 不传 manager — 决策 3：不注册到 AgentManager，防止污染进化引擎/Agent 列表
      });

      try {
        const result = await runtime.chat(userMessage, sessionId);
        return result.response;
      } finally {
        // 决策 3：执行完立即销毁，释放内存
        runtime.destroy();
      }
    };
  }

  // ─── 路 B：spawn_subagent 全局工具（同步等待，供 Agent 主动调用）─

  /**
   * 创建 spawn_subagent 工具定义。
   * Agent 可主动调用此工具派生子代理，工具会同步等待子代理完成并返回结果。
   */
  createSpawnTool(): ToolDefinition {
    return {
      name: "spawn_subagent",
      description:
        "Spawn an isolated sub-agent to handle a delegated task. " +
        "The sub-agent has its own session, shares global tools, " +
        "and returns results upon completion. " +
        "Use this for complex multi-step tasks that benefit from independent execution.",
      parameters: SpawnSubagentParams,
      execute: async (params: unknown, context: ToolContext): Promise<ToolResult> => {
        const parsed = SpawnSubagentParams.safeParse(params);
        if (!parsed.success) {
          return {
            success: false,
            output: `Invalid spawn_subagent parameters: ${parsed.error.message}`,
            error: parsed.error.message,
          };
        }

        const { task, label, timeout } = parsed.data;

        try {
          // 1. 从 ToolContext 取 sessionId 作为 parentSessionId
          const parentSessionId = context.sessionId;

          // 2. 调 spawn() — availableTools: [] 表示全部全局工具（决策 2）
          const record = await this.subagentManager.spawn({
            parentSessionId,
            task,
            label,
            timeout,
            availableTools: [], // 空数组 = 全部全局工具，SubagentManager L211-213 已有此逻辑
          });

          logger.info(
            { subagentId: record.id, parentSessionId, task: task.slice(0, 80) },
            "spawn_subagent tool: sub-agent spawned, waiting for completion",
          );

          // 3. 同步等待子代理完成
          const effectiveTimeout = timeout ?? this.subagentManager.getConfig().defaultTimeout;
          const waitTimeoutMs = effectiveTimeout > 0 ? effectiveTimeout : 3_600_000; // 默认 60min
          const result = await this.wait(record.id, parentSessionId, waitTimeoutMs);

          return {
            success: true,
            output: result,
          };
        } catch (err: any) {
          logger.warn(
            { error: err.message, task: task.slice(0, 80) },
            "spawn_subagent tool: sub-agent failed",
          );
          return {
            success: false,
            output: `Sub-agent failed: ${err.message}`,
            error: err.message,
          };
        }
      },
    };
  }

  // ─── 等待子代理完成 ───────────────────────────────────────

  /**
   * 同步等待子代理执行完成。
   * 优先使用 SubagentAnnouncer 事件监听（零 CPU 开销），
   * 无 announcer 时回退到 500ms 轮询。
   * 学 Orchestrator.waitForSubagent（orchestrator.ts L968-1007）。
   */
  private wait(
    subagentId: string,
    parentSessionId: string,
    timeoutMs: number,
  ): Promise<string> {
    // 优先事件监听
    if (this.announcer) {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error(`Subagent '${subagentId}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const unsubscribe = this.announcer.onAnnounce(
          parentSessionId,
          (payload) => {
            if (payload.subagentId === subagentId) {
              clearTimeout(timer);
              unsubscribe();
              if (payload.status === "success") {
                resolve(payload.result ?? "");
              } else {
                reject(
                  new Error(
                    `Subagent ${payload.status}: ${payload.error ?? "unknown error"}`,
                  ),
                );
              }
            }
          },
        );
      });
    }

    // 回退：500ms 轮询
    return new Promise<string>((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = setInterval(() => {
        const rec = this.subagentManager.get(subagentId);
        if (!rec) {
          clearInterval(poll);
          reject(new Error(`Subagent '${subagentId}' not found`));
          return;
        }
        if (rec.status === "success") {
          clearInterval(poll);
          resolve(rec.result ?? "");
          return;
        }
        if (rec.status !== "running") {
          clearInterval(poll);
          reject(
            new Error(
              `Subagent '${subagentId}' ended with status: ${rec.status}${rec.error ? ` — ${rec.error}` : ""}`,
            ),
          );
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(poll);
          reject(new Error(`Subagent '${subagentId}' timed out`));
        }
      }, 500);
    });
  }

  // ─── 解析父 Agent LLM 配置 ─────────────────────────────────

  /**
   * 获取默认 Agent 的 LLM 配置作为子代理模型。
   * 若无默认 Agent（系统刚启动），回退到兜底配置（风险 #3 缓解）。
   */
  private resolveParentLlm(): LLMProviderConfig {
    const defaultId = this.getDefaultAgentId();
    if (!defaultId) {
      logger.warn("No default agent, using fallback LLM config for sub-agent");
      return FALLBACK_LLM;
    }
    const parent = this.agentManager.getAgent(defaultId);
    if (!parent?.config?.llmProvider) {
      logger.warn("Default agent has no LLM config, using fallback for sub-agent");
      return FALLBACK_LLM;
    }
    return parent.config.llmProvider;
  }
}
