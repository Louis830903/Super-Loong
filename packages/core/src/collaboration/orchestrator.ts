/**
 * Multi-Agent Collaboration Orchestrator.
 *
 * Supports two collaboration modes:
 *
 * 1. **Task Orchestration** (CrewAI-style):
 *    - Define a Crew with tasks and assigned agents
 *    - Sequential: tasks run one-by-one, output feeds into next
 *    - Hierarchical: a manager agent coordinates task execution
 *
 * 2. **Conversation Negotiation** (AutoGen-style):
 *    - GroupChat with multiple agents
 *    - Dynamic speaker selection (round-robin, LLM-based, or manual)
 *    - Termination conditions (max turns, keyword, custom)
 *
 * Both modes integrate with the existing AgentRuntime and AgentManager.
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import type { AgentManager } from "../agent/manager.js";
import type { AgentRuntime } from "../agent/runtime.js";
import { EventEmitter } from "eventemitter3";
import { saveCollabHistory, loadCollabHistory, loadCollabHistoryById } from "../persistence/sqlite.js";
import type { SubagentManager } from "./subagent-spawn.js";
import type { SubagentAnnouncer } from "./subagent-announce.js";
import type { EvolutionEngine } from "../evolution/engine.js";
import type { Attachment, LLMProviderConfig } from "../types/index.js";
import type { IAgentRegistry } from "./agent-registry.js";
import { AgentMatcher, type MatchResult } from "./agent-matcher.js";
import type { A2AClient } from "./a2a-client.js";
import { isPrivateOrReservedHost, isIPAddress } from "./ssrf-guard.js";
import type { IAgentLike } from "./a2a-types.js";
import { RemoteAgentProxy } from "./remote-agent-proxy.js";
import {
  createWorkspace,
  saveTaskOutput as wsSaveTaskOutput,
  collectExternalAttachments,
  generateReadme,
  startWorkspaceCleanupTimer,
  getWorkspacePath,
} from "./workspace.js";
import type { WorkspaceInfo } from "./workspace.js";

const logger = pino({ name: "collaboration" });

// ─── 超时防护工具函数（参考 sandbox.ts Promise.race 模式） ────

/** 为异步操作添加超时保护，防止 LLM 无响应时协作永久挂起 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`[Timeout] ${label} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── F-4: JSON 数组多级提取（替代单一正则，更鲁棒地处理 LLM 输出） ───

/** 从 LLM 输出中提取 JSON 字符串数组。策略：直接解析 > 贪婪匹配最后一个数组 */
function extractJsonArray(text: string): string[] | null {
  // 策略1：直接 JSON.parse 整个响应
  try {
    const arr = JSON.parse(text.trim());
    if (Array.isArray(arr) && arr.every((v) => typeof v === "string")) return arr;
  } catch { /* 继续下一策略 */ }

  // 策略2：提取所有 JSON 数组，优先取最后一个（通常是最终答案）
  const matches = [...text.matchAll(/\[[\s\S]*?\]/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const arr = JSON.parse(matches[i][0]);
      if (Array.isArray(arr) && arr.every((v) => typeof v === "string")) return arr;
    } catch { /* 跳过无效匹配 */ }
  }

  return null;
}

// ─── 附件辅助纯函数 ─────────────────────────────────────────

/**
 * S-2 修复：按 path/url/filename 去重附件列表（同一文件只保留第一次出现）。
 * 无标识附件（path/url/filename 全为空，如纯 base64）无法判定重复，一律保留。
 */
function deduplicateAttachments(attachments: Attachment[]): Attachment[] {
  const seen = new Set<string>();
  return attachments.filter(att => {
    const key = att.path ?? att.url ?? att.filename ?? "";
    if (!key) return true;  // 无标识的附件一律保留（如纯 base64）
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 从附件中剥离 base64 数据，只保留元数据。
 * 用于持久化和 SSE 事件传输，避免载荷膨胀。
 * 返回新数组（不修改原始对象），符合低耦合纯函数原则。
 */
function stripBase64FromAttachments(attachments?: Attachment[]): Attachment[] | undefined {
  if (!attachments?.length) return undefined;
  return attachments.map(({ base64, ...rest }) => rest);
}

// ─── Shared Types ────────────────────────────────────────────

export interface CollabMessage {
  id: string;
  agentId: string;
  agentName: string;
  content: string;
  role: "task_output" | "chat" | "system" | "handoff";
  timestamp: Date;
  metadata?: Record<string, unknown>;
  /** 消息携带的文件附件列表（可选） */
  attachments?: Attachment[];
}

// ═══════════════════════════════════════════════════════════════
// PART 1: Task Orchestration (CrewAI-style)
// ═══════════════════════════════════════════════════════════════

export type ProcessType = "sequential" | "hierarchical";

/**
 * P0-D: Code Node 上下文。
 * Code Task 执行时 orchestrator 注入的只读上下文，避免 handler 直接访问内部状态。
 */
export interface CodeTaskContext {
  /** 当前任务 ID */
  taskId: string;
  /** 所属 Crew ID */
  crewId: string;
  /** 上游 task 输出只读视图（key = taskId, value = output 字符串） */
  outputMap: ReadonlyMap<string, string>;
  /** 当前协作的工作空间目录（可能不存在） */
  workspaceDir: string | undefined;
  /** Crew 配置中的变量注入（对应 {{key}} 占位符的原值） */
  inputs: Record<string, string> | undefined;
  /** 中止信号，handler 在长任务中应当定期检查 */
  signal: AbortSignal | undefined;
}

/** P0-D: Code Node 执行结果 */
export interface CodeTaskResult {
  /** 输出字符串（建议为 JSON），会经过 guardrail 校验并注入下游 outputMap */
  output: string;
  /** 可选的文件附件（图片、音频、视频等） */
  attachments?: Attachment[];
}

export interface CrewTask {
  id: string;
  description: string;
  expectedOutput: string;
  /** 执行该任务的 Agent ID（hierarchical + autoAssign 模式下可省略，由 Manager 自动分配） */
  agentId?: string;
  /** 任务所需能力的提示词（辅助 Manager 匹配，可选） */
  requiredCapabilities?: string[];
  /** IDs of prerequisite tasks whose output feeds as context */
  context?: string[];
  /** If true, can run in parallel with other async tasks */
  async?: boolean;
  /** Optional guardrail validation for the output */
  guardrail?: (output: string) => { valid: boolean; feedback?: string };
  /** E-2: 是否通过子代理执行（而非直接 agent.chat） */
  useSubagent?: boolean;
  /** E-2: 子代理超时（毫秒），默认等于 taskTimeoutMs */
  subagentTimeout?: number;
  /**
   * P0-D: 执行模式。"llm"（默认）走 agent.chat 由 LLM 执行；
   * "code" 走 codeHandler 由确定性代码执行，适合循环调工具等机械任务。
   */
  executor?: "llm" | "code";
  /**
   * P0-D: Code Node 处理函数。executor === "code" 时必须提供。
   * handler 内部应自行处理并发/重试等细节；抛错会被 orchestrator 按 maxRetries 重试。
   */
  codeHandler?: (ctx: CodeTaskContext) => Promise<CodeTaskResult>;
}

export interface CrewConfig {
  id?: string;
  name: string;
  description?: string;
  process: ProcessType;
  tasks: CrewTask[];
  /** For hierarchical mode: the agent that manages task delegation */
  managerAgentId?: string;
  /** Maximum retry attempts per task on guardrail failure */
  maxRetries?: number;
  /** Variables to inject into task descriptions via {{key}} */
  inputs?: Record<string, string>;
  /** Verbose logging */
  verbose?: boolean;
  /** 单个任务的超时时间（毫秒），默认 3600000（1小时） */
  taskTimeoutMs?: number;
  /** 允许 Manager 自动分配 Agent（仅 hierarchical 模式生效，默认 false） */
  autoAssign?: boolean;
  /** 单次 Crew 最多动态创建 Agent 数（默认 30） */
  maxDynamicAgents?: number;
}

export interface TaskOutput {
  taskId: string;
  agentId: string;
  output: string;
  retries: number;
  durationMs: number;
  timestamp: Date;
  /** 任务产出的文件附件列表（可选） */
  attachments?: Attachment[];
}

export interface CrewResult {
  /** G-1: Discriminated Union 标识 */
  type: "crew";
  crewId: string;
  name: string;
  process: ProcessType;
  status: "completed" | "failed" | "partial" | "cancelled";
  taskOutputs: TaskOutput[];
  finalOutput: string;
  totalDurationMs: number;
  error?: string;
  /** 所有任务产出的去重文件聚合（可选） */
  allAttachments?: Attachment[];
  /** 协作工作空间目录路径（成功和失败都有） */
  workspaceDir?: string;
}

// ─── Crew Executor ───────────────────────────────────────────

export class CrewExecutor extends EventEmitter {
  private agentManager: AgentManager;
  /** E-2: 可选的子代理管理器（由 Orchestrator 注入） */
  private subagentManager?: SubagentManager;
  /** E-2: 可选的子代理通报器（用于事件监听替代轮询，M4 修正） */
  private announcer?: SubagentAnnouncer;
  /** 获取当前协作的工作空间目录（由 Orchestrator 注入回调） */
  private getWorkspaceDir?: (collabId: string) => string | undefined;
  /** 全局 LLM 配置（由 Orchestrator 延迟注入，动态创建 Agent 时继承此配置） */
  private globalLlmConfig?: LLMProviderConfig;

  /**
   * P0-1：动态 Agent 生命周期追踪表。
   * key = crewId，value = 本次 crew 中动态创建的 Agent ID 列表。
   * run() 的 finally 块会按 crewId 清理，避免长期运行积累内存/Core Block 泄漏。
   */
  private dynamicAgentIds = new Map<string, string[]>();

  /**
   * 延迟注入全局 LLM 配置（由 Orchestrator.setGlobalLlmConfig 触发）。
   * 动态创建 Agent 时，继承此配置以使用用户当前激活的模型，无需单独配置。
   */
  setGlobalLlmConfig(config: LLMProviderConfig): void {
    this.globalLlmConfig = config;
  }

  /**
   * P0-1：清理某个 crew 创建的所有动态 Agent。
   * 严格按 metadata.source === "crew-dynamic" 过滤，避免误删正式 Agent。
   * 在 run() 的 finally 块调用，无论成功/失败/取消都会执行。
   */
  private cleanupDynamicAgents(crewId: string): void {
    const ids = this.dynamicAgentIds.get(crewId);
    if (!ids || ids.length === 0) return;
    let cleaned = 0;
    for (const id of ids) {
      const agent = this.agentManager.getAgent(id);
      // 防御：若 Agent 已被手动删除或 metadata 被篡改则跳过，避免误删
      if (!agent) continue;
      const src = (agent.state.config.metadata as Record<string, unknown> | undefined)?.source;
      if (src !== "crew-dynamic") {
        logger.warn({ crewId, agentId: id, src }, "Skip cleanup: metadata.source is not crew-dynamic");
        continue;
      }
      if (this.agentManager.deleteAgent(id)) cleaned++;
    }
    this.dynamicAgentIds.delete(crewId);
    logger.info({ crewId, cleaned, total: ids.length }, "Dynamic agents cleaned up");
  }

  constructor(
    agentManager: AgentManager,
    subagentManager?: SubagentManager,
    announcer?: SubagentAnnouncer,
    getWorkspaceDir?: (collabId: string) => string | undefined,
  ) {
    super();
    this.agentManager = agentManager;
    this.subagentManager = subagentManager;
    this.announcer = announcer;
    this.getWorkspaceDir = getWorkspaceDir;
  }

  /** Execute a crew with the given config
   * @param signal E-3: 可选的中止信号，由 Orchestrator 传入
   */
  async run(config: CrewConfig, signal?: AbortSignal): Promise<CrewResult> {
    const crewId = config.id ?? `crew_${uuid().slice(0, 8)}`;
    const startTime = Date.now();
    const taskOutputs: TaskOutput[] = [];
    const outputMap = new Map<string, string>(); // taskId -> output

    logger.info({ crewId, name: config.name, process: config.process, tasks: config.tasks.length },
      "Crew started");
    this.emit("crew:start", { crewId, name: config.name });

    try {
      // E-3: 启动前检查是否已中止
      if (signal?.aborted) throw new Error("Execution cancelled by user");

      let hasSoftFailure = false;
      if (config.process === "sequential") {
        hasSoftFailure = await this.runSequential(config, crewId, taskOutputs, outputMap, signal);
      } else {
        await this.runHierarchical(config, crewId, taskOutputs, outputMap, signal);
      }

      // 聚合所有任务产出的附件（去重），无附件时不设置字段
      const collectedAttachments = deduplicateAttachments(
        taskOutputs.flatMap(t => t.attachments ?? [])
      );

      const result: CrewResult = {
        type: "crew",
        crewId,
        name: config.name,
        process: config.process,
        status: hasSoftFailure ? "partial" : "completed",
        taskOutputs,
        finalOutput: taskOutputs.length > 0 ? taskOutputs[taskOutputs.length - 1].output : "",
        totalDurationMs: Date.now() - startTime,
        allAttachments: collectedAttachments.length ? collectedAttachments : undefined,
      };

      logger.info({ crewId, tasks: taskOutputs.length, durationMs: result.totalDurationMs },
        "Crew completed");
      this.emit("crew:complete", result);
      return result;
    } catch (err: any) {
      // E-3: 区分取消和真正的失败
      const isCancelled = signal?.aborted === true;
      const result: CrewResult = {
        type: "crew",
        crewId,
        name: config.name,
        process: config.process,
        status: isCancelled ? "cancelled" : "failed",
        taskOutputs,
        finalOutput: "",
        totalDurationMs: Date.now() - startTime,
        error: err.message,
      };
      if (isCancelled) {
        logger.info({ crewId }, "Crew cancelled by user");
      } else {
        logger.error({ crewId, err: err.message }, "Crew failed");
      }
      this.emit("crew:error", { crewId, error: err.message });
      return result;
    } finally {
      // P0-1：无论成功/失败/取消都清理本次 crew 的动态 Agent，防泄漏
      this.cleanupDynamicAgents(crewId);
    }
  }

  /**
   * Sequential execution with async parallel support (C-1).
   * 连续的 async===true 且无 context 依赖的任务归为并行组，
   * 非 async 或有依赖的任务作为同步屏障单独执行。
   * @returns 是否存在部分任务软失败（用于标记 partial 状态）
   */
  private async runSequential(
    config: CrewConfig,
    crewId: string,
    taskOutputs: TaskOutput[],
    outputMap: Map<string, string>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const tasks = config.tasks;
    let i = 0;
    let hasSoftFailure = false;

    while (i < tasks.length) {
      // E-3: 每轮检查中止信号
      if (signal?.aborted) throw new Error("Execution cancelled by user");

      const task = tasks[i];
      // 判断是否可并行：async===true 且无 context 依赖，或所有 context 依赖已在 outputMap 中解析完毕
      const canParallel = task.async === true && (
        !task.context || task.context.length === 0 ||
        task.context.every(tid => outputMap.has(tid))
      );

      if (!canParallel) {
        // 同步屏障：单独执行
        const output = await this.executeTask(task, config, crewId, outputMap, signal);
        taskOutputs.push(output);
        outputMap.set(task.id, output.output);
        i++;
        continue;
      }

      // 收集连续的可并行任务组
      const asyncGroup: CrewTask[] = [];
      while (i < tasks.length) {
        const t = tasks[i];
        if (t.async === true && (
          !t.context || t.context.length === 0 ||
          t.context.every(tid => outputMap.has(tid))
        )) {
          asyncGroup.push(t);
          i++;
        } else {
          break;
        }
      }

      // 并行执行组内任务
      logger.info({ crewId, groupSize: asyncGroup.length, taskIds: asyncGroup.map(t => t.id) },
        "Executing parallel async task group");
      const settled = await Promise.allSettled(
        asyncGroup.map((t) => this.executeTask(t, config, crewId, outputMap, signal)),
      );

      // 按原始顺序推入结果
      for (let j = 0; j < settled.length; j++) {
        const result = settled[j];
        if (result.status === "fulfilled") {
          taskOutputs.push(result.value);
          outputMap.set(asyncGroup[j].id, result.value.output);
        } else {
          // 部分失败：记录错误但继续，标记 hasSoftFailure
          hasSoftFailure = true;
          logger.error({ crewId, taskId: asyncGroup[j].id, error: result.reason?.message },
            "Async task failed");
          taskOutputs.push({
            taskId: asyncGroup[j].id,
            agentId: asyncGroup[j].agentId ?? "unknown",
            output: `[ERROR] ${result.reason?.message ?? "Unknown error"}`,
            retries: 0,
            durationMs: 0,
            timestamp: new Date(),
          });
          outputMap.set(asyncGroup[j].id, "");
        }
      }
    }
    return hasSoftFailure;
  }

  /** Hierarchical execution: manager agent delegates tasks */
  private async runHierarchical(
    config: CrewConfig,
    crewId: string,
    taskOutputs: TaskOutput[],
    outputMap: Map<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    const managerId = config.managerAgentId;
    if (!managerId) throw new Error("Hierarchical process requires managerAgentId");

    const manager = this.agentManager.getAgent(managerId);
    if (!manager) throw new Error(`Manager agent '${managerId}' not found`);

    // ─── 新增：智能 Agent 分配阶段（仅 autoAssign 开启时触发） ───────
    // 对无 agentId 的任务由 Manager 通过两阶段筛选（关键词粗筛 + LLM 精选）进行匹配或动态创建
    if (config.autoAssign) {
      const unassigned = config.tasks.filter((t) => !t.agentId);
      if (unassigned.length > 0) {
        if (!this.globalLlmConfig) {
          throw new Error(
            `autoAssign 需要全局 LLM 配置，请先调用 CollaborationOrchestrator.setGlobalLlmConfig()`,
          );
        }
        logger.info(
          { crewId, unassignedCount: unassigned.length, model: this.globalLlmConfig.model },
          "Hierarchical auto-assign phase started",
        );
        const matcher = new AgentMatcher(this.agentManager, manager, this.globalLlmConfig);
        const requests = unassigned.map((t) => ({
          taskId: t.id,
          taskDescription: t.description,
          expectedOutput: t.expectedOutput,
          requiredCapabilities: t.requiredCapabilities,
        }));
        const results = await matcher.matchAll(requests, config.maxDynamicAgents ?? 30);
        await this.applyMatchResults(config.tasks, results, crewId);
      }
    }

    // ─── 校验：所有任务必须有 agentId（autoAssign 关闭时拒绝缺 agentId 的输入）───
    const missingAgent = config.tasks.filter((t) => !t.agentId);
    if (missingAgent.length > 0) {
      throw new Error(
        `Tasks without agentId after assignment phase: ${missingAgent.map((t) => t.id).join(", ")}`,
      );
    }

    // Build task summary for the manager
    const taskList = config.tasks
      .map((t, i) => `Task ${i + 1} [${t.id}]: ${t.description}\n  Assigned to: ${t.agentId}\n  Expected: ${t.expectedOutput}`)
      .join("\n\n");

    const managerPrompt = `You are a project manager coordinating a crew of agents.\n\nCrew: ${config.name}\n${config.description ?? ""}\n\nTasks to coordinate:\n${taskList}\n\nAnalyze task dependencies and determine the optimal execution order. Respond with a JSON array of task IDs in the order they should be executed. Example: ["task1", "task2"]\n\nOnly output the JSON array, nothing else.`;

    // Ask manager to determine execution order
    let orderedTasks = [...config.tasks]; // fallback: listed order
    try {
      const planResult = await withTimeout(
        manager.chat(managerPrompt),
        30_000,
        "Manager planning",
      );
      // F-4: 多级 JSON 提取策略（替代单一正则）
      const orderedIds = extractJsonArray(planResult.response);
      if (orderedIds) {
        const taskMap = new Map(config.tasks.map((t) => [t.id, t]));
        const reordered = orderedIds
          .map((id) => taskMap.get(id))
          .filter((t): t is CrewTask => t !== undefined);
        if (reordered.length === config.tasks.length) {
          orderedTasks = reordered;
          logger.info({ crewId, order: orderedIds }, "Manager determined task order");
        }
      }
    } catch (e) {
      logger.warn({ crewId, error: e }, "Manager planning failed, using listed order");
    }

    for (const task of orderedTasks) {
      // E-3: 每个任务执行前检查中止信号
      if (signal?.aborted) throw new Error("Execution cancelled by user");
      const output = await this.executeTask(task, config, crewId, outputMap, signal);
      taskOutputs.push(output);
      outputMap.set(task.id, output.output);
      logger.info({ crewId, taskId: task.id, agentId: task.agentId }, "Task delegated and completed");
    }
  }

  /**
   * 应用 AgentMatcher 的匹配结果：填充现有 agentId 或动态创建新 Agent。
   *
   * 动态 Agent 的持久化语义说明（P2-3）：
   *   1. 仅存在于内存（AgentManager.agents Map），不进入任何磁盘存储 / DB。
   *   2. metadata.source 固定为 "crew-dynamic"，是下游过滤的唯一正式标记。
   *      - CrewExecutor.cleanupDynamicAgents 在 run() 的 finally 块严格按此标记回收，避免误删正式 Agent。
   *   3. 不参与 AgentRegistry 持久化 / 导出列表：
   *      - UI /agents 列表不会展示（需过滤 source != "crew-dynamic"）；
   *      - 进程重启后自然丢失，无需额外清理。
   *   4. 不共享多个 crew：每次 crew 运行完成 / 取消 / 失败后即被销毁，
   *      下次同样的任务会重新生成新的实例（不做缓存）。
   *
   * 若未来需要“离线复用”或“交由用户确认后持久化”，需在此处引入新的
   * source（如 "crew-dynamic-persist"）或针对性调用 AgentRegistry.save()，
   * 并同步修订 cleanupDynamicAgents 的过滤规则。
   */
  private async applyMatchResults(
    tasks: CrewTask[],
    results: MatchResult[],
    crewId: string,
  ): Promise<void> {
    let dynamicCount = 0;
    let matchedCount = 0;
    for (const result of results) {
      const task = tasks.find((t) => t.id === result.taskId);
      if (!task) continue;

      if (result.matchedAgentId) {
        // 匹配到现有 Agent
        task.agentId = result.matchedAgentId;
        matchedCount++;
        logger.info(
          { crewId, taskId: task.id, agentId: result.matchedAgentId, reason: result.reason },
          "Task auto-assigned to existing agent",
        );
      } else if (result.newAgentConfig) {
        // 动态创建新 Agent（显式传入 globalLlmConfig 避免 fallback 到 gpt-4o-mini）
        if (!this.globalLlmConfig) {
          // 理论上不可达：runHierarchical 入口已校验；此处仅作为类型收敛和防御性兑底
          throw new Error(
            `Cannot create dynamic agent for task '${task.id}': globalLlmConfig not set`,
          );
        }
        const newAgent = this.agentManager.createAgent({
          name: result.newAgentConfig.name,
          role: result.newAgentConfig.role,
          goal: result.newAgentConfig.goal,
          backstory: result.newAgentConfig.backstory,
          tools: result.newAgentConfig.tools,
          skills: result.newAgentConfig.skills,
          // 继承全局 LLM 配置，动态 Agent 与用户当前模型能力完全对齐
          llmProvider: this.globalLlmConfig,
          systemPrompt: `你是 ${result.newAgentConfig.role}。\n目标：${result.newAgentConfig.goal}\n背景：${result.newAgentConfig.backstory}`,
          metadata: {
            // P2-3：source="crew-dynamic" 是下游生命周期回收 / UI 过滤 / 持久化策略的唯一正式标记。
            // 修改该值必须同步更新 cleanupDynamicAgents 与前端 agents 列表过滤逻辑。
            source: "crew-dynamic",
            createdByCrew: crewId,
            createdAt: new Date().toISOString(),
          },
        });
        task.agentId = newAgent.id;
        dynamicCount++;
        // P0-1：记录到生命周期追踪表，crew 结束后由 cleanupDynamicAgents 统一回收
        const list = this.dynamicAgentIds.get(crewId) ?? [];
        list.push(newAgent.id);
        this.dynamicAgentIds.set(crewId, list);
        logger.info(
          { crewId, taskId: task.id, newAgentId: newAgent.id, name: result.newAgentConfig.name },
          "Task auto-assigned to newly created dynamic agent",
        );
      } else {
        // matcher 未返回有效结果，后续校验将抛错
        logger.warn(
          { crewId, taskId: result.taskId, reason: result.reason },
          "AgentMatcher returned no matched agent nor new spec",
        );
      }
    }
    logger.info(
      { crewId, matchedCount, dynamicCount, total: results.length },
      "Auto-assign phase completed",
    );
  }

  /** Execute a single task with retry support */
  private async executeTask(
    task: CrewTask,
    config: CrewConfig,
    crewId: string,
    outputMap: Map<string, string>,
    signal?: AbortSignal,
  ): Promise<TaskOutput> {
    // ─── P0-D: Code Node 执行分支 ─────────────────────────────────
    // 当 task.executor === "code" 时，绕过 agent.chat 直接调用 codeHandler。
    // 适用于循环调工具、数据拼接等机械任务（如短视频 T4~T7 的 TTS/图生/拼接）。
    // 彻底消除 LLM 的不确定性（路径幻觉、遗漏调用、JSON 解析失败）。
    if (task.executor === "code" && task.codeHandler) {
      return this.executeCodeTask(task, config, crewId, outputMap, signal);
    }

    // 防御性校验：agentId 可选后需先确认非空（正常情况下经过 autoAssign 后 agentId 已填充）
    if (!task.agentId) {
      throw new Error(`Task '${task.id}' has no agentId (auto-assign may have failed)`);
    }
    const taskAgentId = task.agentId;
    const agent = this.agentManager.getAgent(taskAgentId);
    if (!agent) throw new Error(`Agent '${taskAgentId}' not found for task '${task.id}'`);

    const maxRetries = config.maxRetries ?? 2;
    let retries = 0;
    const taskStart = Date.now();

    // Build context from prerequisite task outputs
    let contextStr = "";
    if (task.context?.length) {
      const parts = task.context
        .map((tid) => outputMap.get(tid))
        .filter(Boolean);
      if (parts.length > 0) {
        contextStr = `\n\nContext from previous tasks:\n${parts.join("\n---\n")}`;
      }
    }

    // Interpolate variables in description
    let description = task.description;
    if (config.inputs) {
      for (const [key, value] of Object.entries(config.inputs)) {
        description = description.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
      }
    }

    // 从内部映射获取工作空间路径，注入文件产出指令
    const wsDir = this.getWorkspaceDir?.(crewId);
    const workspaceHint = wsDir
      ? `\n\n## 📁 文件输出要求\n你的工作空间目录是: ${wsDir}\n请将所有产出文件保存到此目录。\n\n文件产出规范：\n- 文本报告/代码文件 → 使用 write_file 工具直接写入工作空间目录\n- 如需生成二进制文件（PPT/Word/Excel/PDF/图片），请使用 run_python 执行 Python 代码：\n  - PPT: python-pptx 库\n  - Word: python-docx 库\n  - Excel: openpyxl 库\n  - PDF: fpdf2 库\n  - 图片: pillow 库\n  生成后在最终回复中输出 MEDIA:/path/to/file 让系统自动收集为附件（无需再调 write_file）\n- 也可使用 image_generate 工具生成图片`
      : "";

    let prompt = `${description}${contextStr}\n\nExpected output: ${task.expectedOutput}${workspaceHint}`;

    this.emit("task:start", { crewId, taskId: task.id, agentId: task.agentId });

    // P1-LOG: 统一 task 级结构化日志 — 便于失败时秒级定位
    // 字段约定 {crewId, taskId, agentId, phase, executor, durationMs?, retries?, error?}
    logger.info(
      { crewId, taskId: task.id, agentId: taskAgentId, phase: "start", executor: "agent" },
      "Task started (agent.chat executor)",
    );

    // E-2: 子代理分支 — 当 task.useSubagent 且有 subagentManager 时，
    // 通过 spawn 子代理执行任务，而非直接 agent.chat()
    if (task.useSubagent && this.subagentManager) {
      const parentSessionId = `crew_${crewId}`;
      const subagentTimeoutMs = task.subagentTimeout ?? config.taskTimeoutMs ?? 3_600_000;

      const record = await this.subagentManager.spawn({
        parentSessionId,
        task: prompt,
        label: `crew-task-${task.id}`,
        timeout: subagentTimeoutMs,
        availableTools: [],  // 由上层按需注入
      });

      logger.info({ crewId, taskId: task.id, subagentId: record.id }, "Task delegated to sub-agent");

      // M4: 等待子代理完成（事件监听 > 轮询，withTimeout 保护）
      const result = await this.waitForSubagent(record.id, parentSessionId, subagentTimeoutMs);

      const output: TaskOutput = {
        taskId: task.id,
        agentId: taskAgentId,
        output: result,
        retries: 0,
        durationMs: Date.now() - taskStart,
        timestamp: new Date(),
      };

      this.emit("task:complete", { crewId, ...output });
      logger.info(
        {
          crewId,
          taskId: task.id,
          agentId: taskAgentId,
          phase: "complete",
          executor: "subagent",
          durationMs: output.durationMs,
          retries: 0,
        },
        "Task completed (subagent executor)",
      );
      return output;
    }

    // 原有路径：直接 agent.chat() 执行

    while (retries <= maxRetries) {
      // E-3: 每次重试前检查中止信号
      if (signal?.aborted) throw new Error("Execution cancelled by user");
      const timeoutMs = config.taskTimeoutMs ?? 3_600_000;
      const { response, attachments } = await withTimeout(
        agent.chat(prompt, `crew_${crewId}_${task.id}`),
        timeoutMs,
        `Task '${task.id}' agent.chat`,
      );

      // Validate with guardrail if provided
      if (task.guardrail) {
        const validation = task.guardrail(response);
        if (!validation.valid) {
          retries++;
          if (retries > maxRetries) {
            throw new Error(`Task '${task.id}' failed guardrail after ${maxRetries} retries: ${validation.feedback}`);
          }
          // 将 guardrail 反馈注入下次 prompt，让 LLM 知道哪里出错并修正
          prompt += `\n\n[GUARDRAIL FEEDBACK] 你的上一次输出未通过校验：${validation.feedback}。请严格按照要求的 JSON 格式重新输出，修正上述问题。`;
          logger.warn(
            {
              crewId,
              taskId: task.id,
              agentId: taskAgentId,
              phase: "guardrail_failed",
              executor: "agent",
              retries,
              feedback: validation.feedback,
            },
            "Task guardrail failed, retrying with feedback",
          );
          continue;
        }
      }

      const output: TaskOutput = {
        taskId: task.id,
        agentId: taskAgentId,
        output: response,
        retries,
        durationMs: Date.now() - taskStart,
        timestamp: new Date(),
        attachments: attachments?.length ? attachments : undefined,
      };

      this.emit("task:complete", { crewId, ...output });
      logger.info(
        {
          crewId,
          taskId: task.id,
          agentId: taskAgentId,
          phase: "complete",
          executor: "agent",
          durationMs: output.durationMs,
          retries,
          hasAttachments: !!attachments?.length,
        },
        "Task completed (agent.chat executor)",
      );
      return output;
    }

    throw new Error(`Task '${task.id}' exhausted all retries`);
  }

  /**
   * P0-D: 执行 Code Node 任务。
   *
   * 与 agent.chat 分支的核心区别：
   * - 不经过 LLM，直接调用 task.codeHandler 完成工作
   * - handler 抛错 → 按 maxRetries 重试（用于吸收网络抖动）
   * - 仍复用 task.guardrail 做最终产出校验（双保险）
   *
   * 设计要点（低耦合）：
   * - ctx 是只读视图，handler 不能改 outputMap
   * - handler 自行处理内部并发（如 Promise.all 调 forge_tts）
   * - attachments 交给 orchestrator 常规路径聚合，不重复实现
   */
  private async executeCodeTask(
    task: CrewTask,
    config: CrewConfig,
    crewId: string,
    outputMap: Map<string, string>,
    signal?: AbortSignal,
  ): Promise<TaskOutput> {
    if (!task.codeHandler) {
      throw new Error(`Task '${task.id}' is declared as code executor but codeHandler is missing`);
    }

    const maxRetries = config.maxRetries ?? 2;
    // Code 任务不强制 agentId，但 TaskOutput 必填；未提供时用占位 ID 便于追踪
    const agentIdForOutput = task.agentId ?? `code-node:${task.id}`;
    const taskStart = Date.now();

    const wsDir = this.getWorkspaceDir?.(crewId);
    const ctx: CodeTaskContext = {
      taskId: task.id,
      crewId,
      // 暴露只读视图，handler 无法污染编排器内部状态
      outputMap: outputMap as ReadonlyMap<string, string>,
      workspaceDir: wsDir,
      inputs: config.inputs,
      signal,
    };

    this.emit("task:start", { crewId, taskId: task.id, agentId: agentIdForOutput });
    logger.info(
      { crewId, taskId: task.id, agentId: agentIdForOutput, phase: "start", executor: "code" },
      "Task started (code executor)",
    );

    let retries = 0;
    while (retries <= maxRetries) {
      if (signal?.aborted) throw new Error("Execution cancelled by user");

      let result: CodeTaskResult;
      try {
        // handler 可能抛异常（网络错误、上游 JSON 解析失败等），
        // 统一走下方重试逻辑，无需区分错误类型
        const timeoutMs = config.taskTimeoutMs ?? 3_600_000;
        result = await withTimeout(
          task.codeHandler(ctx),
          timeoutMs,
          `Code task '${task.id}' handler`,
        );
      } catch (err) {
        retries++;
        const msg = err instanceof Error ? err.message : String(err);
        if (retries > maxRetries) {
          logger.error(
            {
              crewId,
              taskId: task.id,
              agentId: agentIdForOutput,
              phase: "failed",
              executor: "code",
              retries: retries - 1,
              error: msg,
            },
            "Code task exhausted retries",
          );
          throw new Error(`Task '${task.id}' code handler failed after ${maxRetries} retries: ${msg}`);
        }
        logger.warn(
          {
            crewId,
            taskId: task.id,
            agentId: agentIdForOutput,
            phase: "code_retry",
            executor: "code",
            retries,
            error: msg,
          },
          "Code handler threw, retrying",
        );
        continue;
      }

      // guardrail 作为最后一道防线（即便 handler 是确定性代码，依然保留二次校验以防上游污染）
      if (task.guardrail) {
        const validation = task.guardrail(result.output);
        if (!validation.valid) {
          retries++;
          if (retries > maxRetries) {
            throw new Error(`Task '${task.id}' failed guardrail after ${maxRetries} retries: ${validation.feedback}`);
          }
          logger.warn(
            {
              crewId,
              taskId: task.id,
              agentId: agentIdForOutput,
              phase: "guardrail_failed",
              executor: "code",
              retries,
              feedback: validation.feedback,
            },
            "Code task guardrail failed, retrying",
          );
          continue;
        }
      }

      const output: TaskOutput = {
        taskId: task.id,
        agentId: agentIdForOutput,
        output: result.output,
        retries,
        durationMs: Date.now() - taskStart,
        timestamp: new Date(),
        attachments: result.attachments?.length ? result.attachments : undefined,
      };

      this.emit("task:complete", { crewId, ...output });
      logger.info(
        {
          crewId,
          taskId: task.id,
          agentId: agentIdForOutput,
          phase: "complete",
          executor: "code",
          durationMs: output.durationMs,
          retries,
          hasAttachments: !!result.attachments?.length,
        },
        "Task completed (code executor)",
      );
      return output;
    }

    throw new Error(`Task '${task.id}' exhausted all retries`);
  }

  /**
   * E-2/M4: 等待子代理完成。
   * 优先使用 SubagentAnnouncer 事件监听（零 CPU 开销），
   * 无 announcer 时回退到 500ms 轮询。由 withTimeout 保护总超时。
   */
  private waitForSubagent(subagentId: string, parentSessionId: string, timeoutMs: number): Promise<string> {
    return withTimeout(
      new Promise<string>((resolve, reject) => {
        const mgr = this.subagentManager!;

        // 检查是否已完成（spawn 后可能快速结束）
        const check = () => {
          const rec = mgr.get(subagentId);
          if (!rec) { reject(new Error(`Subagent '${subagentId}' not found`)); return true; }
          if (rec.status === "success") { resolve(rec.result ?? ""); return true; }
          if (rec.status !== "running") {
            reject(new Error(`Subagent '${subagentId}' ended with status: ${rec.status}${rec.error ? ` — ${rec.error}` : ""}`));
            return true;
          }
          return false;
        };

        if (check()) return;

        // M4: 优先使用事件监听
        if (this.announcer) {
          const unsubscribe = this.announcer.onAnnounce(parentSessionId, (payload) => {
            if (payload.subagentId === subagentId) {
              unsubscribe();
              if (payload.status === "success") resolve(payload.result ?? "");
              else reject(new Error(`Subagent ${payload.status}: ${payload.error ?? "unknown"}`));
            }
          });
          return;
        }

        // 回退：500ms 轮询
        const poll = setInterval(() => {
          if (check()) clearInterval(poll);
        }, 500);
      }),
      timeoutMs,
      `waitForSubagent(${subagentId})`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// PART 2: Conversation Negotiation (AutoGen-style)
// ═══════════════════════════════════════════════════════════════

export type SpeakerSelectionMethod = "round_robin" | "random" | "manual" | "auto" | "graph" | "handoff";

// ─── I-3: 可插拔终止条件接口（学 AutoGen TerminationCondition 抽象基类） ───

/**
 * I-3: 终止检查结果 — 不终止返回 shouldTerminate: false，终止时附带原因。
 */
export type TerminationResult =
  | { shouldTerminate: false }
  | { shouldTerminate: true; reason: string };

/**
 * I-3: 可插拔终止条件接口。
 * 支持 MaxTurns / MaxTime / Keyword / 自定义回调等实现。
 * GroupChat 每轮末尾遍历所有条件，任一满足即终止。
 */
export interface TerminationCondition {
  /** 检查是否应终止 */
  check(messages: CollabMessage[], turn: number, elapsedMs: number): TerminationResult;
  /** 重置状态（GroupChat 重新开始时调用） */
  reset(): void;
}

/** I-3: 最大轮次终止 */
export class MaxTurnsTermination implements TerminationCondition {
  constructor(private maxTurns: number) {}
  check(_messages: CollabMessage[], turn: number): TerminationResult {
    if (turn >= this.maxTurns) {
      return { shouldTerminate: true, reason: `Max turns (${this.maxTurns}) reached` };
    }
    return { shouldTerminate: false };
  }
  reset(): void { /* stateless */ }
}

/** I-3: 最大时间终止 */
export class MaxTimeTermination implements TerminationCondition {
  constructor(private maxTimeMs: number) {}
  check(_messages: CollabMessage[], _turn: number, elapsedMs: number): TerminationResult {
    if (elapsedMs >= this.maxTimeMs) {
      return { shouldTerminate: true, reason: `Max time (${this.maxTimeMs}ms) exceeded` };
    }
    return { shouldTerminate: false };
  }
  reset(): void { /* stateless */ }
}

/** I-3: 关键词终止 — 最后一条消息包含任一关键词即终止 */
export class KeywordTermination implements TerminationCondition {
  constructor(private keywords: string[]) {}
  check(messages: CollabMessage[]): TerminationResult {
    const last = messages.at(-1);
    if (last) {
      const matched = this.keywords.find((kw) => last.content.includes(kw));
      if (matched) {
        return { shouldTerminate: true, reason: `Keyword "${matched}" detected` };
      }
    }
    return { shouldTerminate: false };
  }
  reset(): void { /* stateless */ }
}

/**
 * I-3/R1: 旧版回调适配器 — 将 `terminationCondition: (msgs) => boolean`
 * 包装为新的 TerminationCondition 接口，实现向后兼容。
 */
export class LegacyCallbackTermination implements TerminationCondition {
  constructor(private callback: (messages: CollabMessage[]) => boolean) {}
  check(messages: CollabMessage[]): TerminationResult {
    if (this.callback(messages)) {
      return { shouldTerminate: true, reason: "Legacy callback condition met" };
    }
    return { shouldTerminate: false };
  }
  reset(): void { /* stateless */ }
}

export interface GroupChatConfig {
  id?: string;
  name: string;
  description?: string;
  participantIds: string[];
  /** How to select the next speaker */
  speakerSelection: SpeakerSelectionMethod;
  /** Maximum conversation turns before stopping */
  maxTurns: number;
  /** @deprecated I-3/R1: 使用 terminationConditions 替代。旧格式自动转换为 KeywordTermination */
  terminationKeyword?: string;
  /** @deprecated I-3/R1: 使用 terminationConditions 替代。旧格式自动转换为 LegacyCallbackTermination */
  terminationCondition?: (messages: CollabMessage[]) => boolean;
  /** I-3: 可插拔终止条件列表（任一满足即终止），与 maxTurns 并存作为安全阀 */
  terminationConditions?: TerminationCondition[];
  /** System message to provide conversation context */
  systemMessage?: string;
  /** If "auto", which agent decides the next speaker */
  moderatorAgentId?: string;
  /** 每轮对话的超时时间（毫秒），默认 60000（1分钟） */
  turnTimeoutMs?: number;
  /** C-3: 上下文窗口大小（最近N条消息），默认 20 */
  contextWindowSize?: number;
  /** F-3: 每轮发言失败时的最大重试次数（默认 1） */
  maxRetryPerTurn?: number;
  /** H-2: manual 模式下的发言顺序列表（agentId 数组），不指定时等同 round_robin */
  manualSpeakerOrder?: string[];
  /** I-4: graph 模式的邻接表配置 */
  graphConfig?: GraphSpeakerConfig;
}

/**
 * I-4: Graph 模式发言转移配置（状态机邻接表）。
 */
export interface GraphSpeakerConfig {
  /** 邻接表：key=agentId, value=可转移到的agentId列表 */
  transitions: Record<string, string[]>;
  /** 起始发言者 agentId */
  startAgent: string;
}

export interface GroupChatResult {
  /** G-1: Discriminated Union 标识 */
  type: "groupchat";
  chatId: string;
  name: string;
  status: "completed" | "terminated" | "max_turns" | "error" | "cancelled";
  messages: CollabMessage[];
  turns: number;
  totalDurationMs: number;
  summary?: string;
  error?: string;
  /** 所有消息产出的去重文件聚合（可选） */
  allAttachments?: Attachment[];
  /** 协作工作空间目录路径（成功和失败都有） */
  workspaceDir?: string;
}

// B3: GroupChatExecutor 已提取到独立模块 groupchat-executor.ts
import { GroupChatExecutor } from "./groupchat-executor.js";
export { GroupChatExecutor };

// ═══════════════════════════════════════════════════════════════
// PART 3: Unified Collaboration Orchestrator
// ═══════════════════════════════════════════════════════════════

/** E-3: 运行中的任务信息 */
export interface RunningTaskInfo {
  id: string;
  type: "crew" | "groupchat";
  name: string;
  startTime: Date;
}

/**
 * Orchestrator 依赖选项 — 使用 Options 对象模式避免构造函数参数膨胀。
 * 仅 agentManager 必填，其余均为可选注入（不传时不启用对应能力）。
 */
export interface OrchestratorDeps {
  agentManager: AgentManager;
  /** 子代理生命周期管理（传入后 Crew 可使用 subagent spawn 能力） */
  subagentManager?: SubagentManager;
  /** 子代理完成通报（传入后支持 announce 投递） */
  announcer?: SubagentAnnouncer;
  /** H-1: 进化引擎（传入后协作完成时自动反馈交互数据） */
  evolutionEngine?: EvolutionEngine;
  /** A2A: Agent 注册表（传入后启用四级回退发现） */
  registry?: IAgentRegistry;
  /** A2A: 客户端工厂（传入后可调用远端 Agent） */
  a2aClientFactory?: (endpoint: string) => A2AClient;
}

export class CollaborationOrchestrator extends EventEmitter {
  readonly crew: CrewExecutor;
  readonly groupChat: GroupChatExecutor;
  /** AgentManager 引用（用于四级回退 Level 1 查找） */
  private readonly agentManagerRef: AgentManager;
  /** 子代理管理器（可选，E-1 注入） */
  readonly subagentManager?: SubagentManager;
  /** 子代理通报器（可选，E-1 注入） */
  readonly announcer?: SubagentAnnouncer;
  /** 进化引擎（可选，H-1 注入 — 协作完成后反馈交互数据） */
  private evolutionEngine?: EvolutionEngine;
  /** A2A: Agent 注册表（可选，启用后支持四级回退发现） */
  private readonly registry?: IAgentRegistry;
  /** A2A: 客户端工厂（可选，启用后可调用远端 Agent） */
  private readonly a2aClientFactory?: (endpoint: string) => A2AClient;
  private runHistory: Array<CrewResult | GroupChatResult> = [];
  // C-5: 历史记录最大容量，超出时删除最旧条目
  private maxHistorySize = 100;
  /** E-3: 运行中任务的 AbortController 映射 */
  private runningTasks = new Map<string, { info: RunningTaskInfo; abortController: AbortController }>();
  /** 工作空间目录映射：collabId → workspaceDir（替代 _workspaceDir 反模式） */
  private workspaceDirs = new Map<string, string>();

  /**
   * 统一协作编排器。
   * 支持两种构造方式（向后兼容）：
   * - new CollaborationOrchestrator({ agentManager, subagentManager?, announcer? })
   * - new CollaborationOrchestrator(agentManager)  // 旧签名
   */
  constructor(deps: OrchestratorDeps);
  constructor(agentManager: AgentManager);
  constructor(depsOrAgent: OrchestratorDeps | AgentManager) {
    super();

    // 向后兼容：支持旧签名 new CollaborationOrchestrator(agentManager)
    const options: OrchestratorDeps =
      typeof (depsOrAgent as any).getAgent === "function"
        ? { agentManager: depsOrAgent as AgentManager }
        : depsOrAgent as OrchestratorDeps;

    this.crew = new CrewExecutor(
      options.agentManager,
      options.subagentManager,
      options.announcer,
      // 注入工作空间目录查询回调，让 CrewExecutor 能在 executeTask() 中获取 workspaceDir
      (collabId: string) => this.workspaceDirs.get(collabId),
    );
    this.groupChat = new GroupChatExecutor(options.agentManager);
    this.agentManagerRef = options.agentManager;

    // E-1: 保存可选的子代理管理器和通报器引用
    this.subagentManager = options.subagentManager;
    this.announcer = options.announcer;
    // H-1: 保存可选的进化引擎引用
    this.evolutionEngine = options.evolutionEngine;
    // A2A: 保存注册表和客户端工厂
    this.registry = options.registry;
    this.a2aClientFactory = options.a2aClientFactory;
    if (this.subagentManager) {
      logger.info("SubagentManager integrated into CollaborationOrchestrator");
    }

    // Forward events（SSE 高频事件对 attachments 做 base64 瘦身，低耦合原则 2）
    this.crew.on("crew:start", (e) => this.emit("collab:event", { type: "crew:start", ...e }));
    this.crew.on("crew:complete", (e) => this.emit("collab:event", { type: "crew:complete", ...e }));
    this.crew.on("crew:error", (e) => this.emit("collab:event", { type: "crew:error", ...e }));
    this.crew.on("task:start", (e) => this.emit("collab:event", { type: "task:start", ...e }));
    this.crew.on("task:complete", (e) => {
      const clean = { ...e };
      if (clean.attachments) clean.attachments = stripBase64FromAttachments(clean.attachments);
      this.emit("collab:event", { type: "task:complete", ...clean });
    });
    this.groupChat.on("groupchat:start", (e) => this.emit("collab:event", { type: "groupchat:start", ...e }));
    this.groupChat.on("groupchat:complete", (e) => this.emit("collab:event", { type: "groupchat:complete", ...e }));
    this.groupChat.on("groupchat:message", (e) => {
      const clean = { ...e };
      if (clean.message?.attachments) {
        clean.message = { ...clean.message, attachments: stripBase64FromAttachments(clean.message.attachments) };
      }
      this.emit("collab:event", { type: "groupchat:message", ...clean });
    });

    // Restore persisted history on startup
    this.loadHistoryFromDB();

    // 启动工作空间清理定时器（30天TTL，24小时间隔）
    startWorkspaceCleanupTimer();
  }

  // ─── A2A 四级回退 Agent 发现 ───────────────────────────

  /**
   * 四级回退解析 Agent：
   * 1. 进程内 localAgents（agentManager）
   * 2. Direct Config（config.directAgents?.[agentId]）— 预留扩展
   * 3. Curated Registry（registry.resolve(agentId)）
   * 4. Well-Known URI（isDomain(agentId) 时直连）
   *
   * @returns IAgentLike 或 null（四级均未命中）
   */
  async resolveAgent(agentId: string): Promise<IAgentLike | null> {
    // Level 1: 进程内本地 Agent
    const localAgent = this.agentManagerRef.getAgent(agentId);
    if (localAgent) {
      logger.info({ agentId }, "resolveAgent: Level 1 命中（本地 Agent）");
      return localAgent as unknown as IAgentLike;
    }

    // Level 2: Direct Config（预留扩展点，当前跳过）

    // Level 3: Curated Registry
    if (this.registry) {
      const card = await this.registry.resolve(agentId);
      if (card) {
        logger.info({ agentId, endpoint: card.url }, "resolveAgent: Level 3 命中（Registry）");
        return new RemoteAgentProxy(card);
      }
    }

    // Level 4: Well-Known URI（当 agentId 看起来是域名时直连）
    if (this.a2aClientFactory && this.isDomain(agentId)) {
      try {
        const endpoint = `https://${agentId}`;
        const client = this.a2aClientFactory(endpoint);
        const card = await client.fetchAgentCard();
        logger.info({ agentId, endpoint }, "resolveAgent: Level 4 命中（Well-Known URI）");
        return new RemoteAgentProxy(card);
      } catch (err) {
        logger.warn({ agentId, error: err instanceof Error ? err.message : String(err) },
          "resolveAgent: Level 4 Well-Known URI 失败");
      }
    }

    logger.warn({ agentId }, "resolveAgent: 四级回退均未命中");
    return null;
  }

  /**
   * 域名检测（P0-2 加固）：包含点且不是文件后缀、不是 IP 地址、不是私网/保留地址。
   * 复用 ssrf-guard.ts 共享函数避免逻辑重复。
   */
  private isDomain(id: string): boolean {
    // 排除常见文件后缀
    if (id.endsWith(".js") || id.endsWith(".ts") || id.endsWith(".json")) return false;
    // 必须包含点才可能是域名
    if (!id.includes(".")) return false;
    // 拒绝纯 IP 地址
    if (isIPAddress(id)) return false;
    // 拒绝 localhost 及私网/保留地址
    if (isPrivateOrReservedHost(id)) return false;
    return true;
  }

  /** Load persisted collaboration history from SQLite */
  private loadHistoryFromDB(): void {
    try {
      // F-2: 加载数量与 maxHistorySize 一致，防止超限
      const rows = loadCollabHistory(this.maxHistorySize);
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.result as string);
          // G-1/C1: 旧数据无 type 字段 — 在内存层自动补充，无需 DB migration
          if (!parsed.type) {
            parsed.type = "process" in parsed ? "crew" : "groupchat";
          }
          this.runHistory.push(parsed);
        } catch {
          logger.warn({ id: row.id }, "Failed to parse collab history entry");
        }
      }
      // F-2: 加载后立即修剪，确保不超限
      this.pruneHistory();
      if (rows.length > 0) {
        logger.info({ count: rows.length }, "Collaboration history restored from database");
      }
    } catch {
      // DB not initialized yet or first run
    }
  }

  /** Persist a result to SQLite（附件剥离 base64 防止存储膨胀） */
  private persistResult(result: CrewResult | GroupChatResult): void {
    try {
      // G-1: 使用 type 字段判断，fallback 兼容无 type 的旧数据
      const isCrew = result.type === "crew" || ("process" in result);
      const id = isCrew ? (result as CrewResult).crewId : (result as GroupChatResult).chatId;

      // M-1: 使用 replacer 在序列化过程中直接跳过 base64 字段，
      // 零额外内存分配，自动覆盖所有嵌套层级（替代深拷贝+手动遍历）
      const resultJson = JSON.stringify(result, (key, value) => {
        if (key === "base64" || key === "base64Data") return undefined;
        return value;
      });

      saveCollabHistory({
        id,
        type: isCrew ? "crew" : "groupchat",
        name: result.name,
        status: result.status,
        result: resultJson,
        durationMs: result.totalDurationMs,
      });
    } catch (err) {
      logger.warn({ error: err }, "Failed to persist collaboration result");
    }
  }

  /** E-1: 获取子代理管理器（未注入时返回 undefined） */
  getSubagentManager(): SubagentManager | undefined {
    return this.subagentManager;
  }

  /** E-1: 获取子代理通报器（未注入时返回 undefined） */
  getAnnouncer(): SubagentAnnouncer | undefined {
    return this.announcer;
  }

  /**
   * H-1: 延迟注入进化引擎（因 EvolutionEngine 在 context 中晚于 Orchestrator 创建）。
   * 注入后协作完成时自动记录交互数据到进化系统，使 Agent 能从协作经验中学习。
   */
  setEvolutionEngine(engine: EvolutionEngine): void {
    this.evolutionEngine = engine;
    logger.info("EvolutionEngine integrated into CollaborationOrchestrator (H-1)");
  }

  /**
   * 延迟注入全局 LLM 配置（解决 llmConfig 在 api/index.ts 构建、Orchestrator 在 context.ts 早创建的时序问题）。
   * 注入后，Hierarchical autoAssign 模式下动态创建的 Agent 会继承此配置，
   * 无需用户为每个动态 Agent 单独配置模型。
   */
  setGlobalLlmConfig(config: LLMProviderConfig): void {
    this.crew.setGlobalLlmConfig(config);
    logger.info({ model: config.model }, "Global LLM config injected into CollaborationOrchestrator");
  }

  /**
   * H-1: 协作完成后，为每位参与 Agent 向进化引擎记录一条交互数据。
   * 进化引擎据此统计 Agent 在协作场景的成功率，触发 nudge review 优化协作能力。
   */
  private feedEvolution(
    agentIds: string[],
    result: CrewResult | GroupChatResult,
  ): void {
    if (!this.evolutionEngine) return;

    const isCrew = result.type === "crew";
    const collabType = isCrew ? "crew" : "groupchat";
    const sessionId = isCrew
      ? (result as CrewResult).crewId
      : (result as GroupChatResult).chatId;

    // 根据状态映射成功/分数
    const success = result.status === "completed" || result.status === "terminated";
    const score =
      result.status === "completed" ? 1.0
      : result.status === "terminated" ? 0.8
      : result.status === "partial" ? 0.5
      : 0.0; // failed / error / cancelled

    // 为去重，收集唯一 agentId
    const uniqueIds = [...new Set(agentIds)];

    for (const agentId of uniqueIds) {
      try {
        this.evolutionEngine.recordInteraction({
          agentId,
          sessionId,
          userMessage: `[collab:${collabType}] ${result.name}`,
          agentResponse: isCrew
            ? (result as CrewResult).finalOutput?.slice(0, 500) ?? ""
            : (result as GroupChatResult).summary?.slice(0, 500) ?? "",
          success,
          score,
          failureReason: success ? undefined : result.error,
          failureCategory: success ? undefined : "other",
        });
      } catch (err) {
        logger.warn({ agentId, error: err }, "H-1: Failed to record collab interaction to evolution engine");
      }
    }

    if (uniqueIds.length > 0) {
      logger.debug(
        { collabType, sessionId, agents: uniqueIds.length, success, score },
        "H-1: Collaboration interaction recorded to evolution engine",
      );
    }
  }

  /** Run a task-orchestrated crew（E-3: 注册到 runningTasks，支持中止） */
  async runCrew(config: CrewConfig): Promise<CrewResult> {
    const taskId = config.id ?? `crew_${uuid().slice(0, 8)}`;
    const ac = new AbortController();

    // 1. 创建工作空间（P2-1：降级策略，创建失败不阻塞协作执行，仅禁用归档）
    let ws: WorkspaceInfo | undefined;
    try {
      ws = await createWorkspace({ collabId: taskId, name: config.name, type: "crew" });
      this.workspaceDirs.set(taskId, ws.rootDir);
    } catch (wsErr: any) {
      logger.warn({ taskId, err: wsErr.message }, "工作空间创建失败，协作继续执行但不归档");
    }

    // 2. result 声明在 try 之前，确保 finally 中可访问（v2.1 P1-A 修复）
    let result: CrewResult | undefined;

    // E-3: 注册到运行中任务表
    this.runningTasks.set(taskId, {
      info: { id: taskId, type: "crew", name: config.name, startTime: new Date() },
      abortController: ac,
    });

    // E-2/R3: 注册虚拟根，使子代理 spawn 时 parentSessionId 可在 registry 中找到
    const crewSessionId = `crew_${taskId}`;
    this.subagentManager?.registerVirtualRoot(crewSessionId, `crew:${config.name}`);

    try {
      result = await this.crew.run({ ...config, id: taskId }, ac.signal);
      this.runHistory.push(result);
      this.pruneHistory();
      this.persistResult(result);
      // H-1: 协作完成后向进化引擎反馈每位参与 Agent 的交互数据
      // agentId 变可选后需 filter 掉 undefined（正常流程中 autoAssign 后已填充）
      this.feedEvolution(
        config.tasks.map((t) => t.agentId).filter((id): id is string => !!id),
        result,
      );
      return result;
    } finally {
      // 3. 工作空间归档（v2.2: 包 try-catch，归档失败不影响协作结果）
      try {
        if (result && ws) {
          // 保存纯文本输出为 .md（无附件的任务输出也有文件记录）
          for (const [i, to] of result.taskOutputs.entries()) {
            if (!to.attachments?.length) {
              await wsSaveTaskOutput(ws, to.taskId, to.agentId, to.output, i + 1);
            }
          }
          // 收集不在工作空间内的外部附件
          const attList = (result.allAttachments ?? []).map(a => ({ path: a.path, filename: a.filename }));
          await collectExternalAttachments(ws, attList);
          // 生成 README（含状态标注）
          const taskOutputsForReadme = result.taskOutputs.map(to => ({
            taskId: to.taskId, agentId: to.agentId, output: to.output,
            attachments: to.attachments?.map(a => ({ path: a.path, filename: a.filename })),
          }));
          await generateReadme(ws, taskOutputsForReadme, config.name, result.status);
          // 写入 workspaceDir 到结果对象（内存中的引用，runHistory 中的也会更新）
          result.workspaceDir = ws.rootDir;
          // v2.2: 补一次含 workspaceDir 的持久化（修复 P2-B 重启后 ZIP 下载失效）
          this.persistResult(result);
        }
      } catch (archiveErr: any) {
        // v2.2 关键：归档失败仅 log，不 rethrow，让 try 块的 return result 正常返回
        logger.error({ taskId, err: archiveErr.message }, "工作空间归档失败，不影响协作结果");
        // 即使归档失败，仍尝试写入 workspaceDir（目录可能已创建）
        if (result && ws) result.workspaceDir = ws.rootDir;
      }
      // 4. 清理（必须执行，不受归档 try-catch 影响）
      this.workspaceDirs.delete(taskId);
      this.runningTasks.delete(taskId);
      // E-2/R3: 标记虚拟根完成
      this.subagentManager?.completeVirtualRoot(crewSessionId);
    }
  }

  /** Run a group chat conversation（E-3: 注册到 runningTasks，支持中止） */
  async runGroupChat(config: GroupChatConfig, initialMessage: string): Promise<GroupChatResult> {
    const taskId = config.id ?? `gchat_${uuid().slice(0, 8)}`;
    const ac = new AbortController();

    // 1. 创建工作空间（P2-1：降级策略，创建失败不阻塞协作执行）
    let ws: WorkspaceInfo | undefined;
    try {
      ws = await createWorkspace({ collabId: taskId, name: config.name, type: "groupchat" });
      this.workspaceDirs.set(taskId, ws.rootDir);
    } catch (wsErr: any) {
      logger.warn({ taskId, err: wsErr.message }, "工作空间创建失败，协作继续执行但不归档");
    }

    // 2. 构建 GroupChat 专用的工作空间系统提示（仅在 ws 存在时注入）
    const workspaceSystemPrompt = ws
      ? `\n\n## 📁 工作空间\n所有参与者共享工作空间目录: ${ws.rootDir}\n请将产出文件保存到此目录。\n\n文件产出规范：\n- 文本/代码文件 → 使用 write_file 写入工作空间\n- 二进制文件（PPT/Word/Excel/PDF/图片） → 在 run_python 中保存到工作空间后，在回复中输出 MEDIA:/path/to/file`
      : "";

    // 3. 注入到 systemMessage（GroupChat 已有字段，每轮对话可见）
    const augmentedConfig = workspaceSystemPrompt
      ? { ...config, systemMessage: (config.systemMessage ?? "") + workspaceSystemPrompt }
      : config;

    let result: GroupChatResult | undefined;

    // E-3: 注册到运行中任务表
    this.runningTasks.set(taskId, {
      info: { id: taskId, type: "groupchat", name: config.name, startTime: new Date() },
      abortController: ac,
    });

    try {
      result = await this.groupChat.run({ ...augmentedConfig, id: taskId }, initialMessage, ac.signal);
      this.runHistory.push(result);
      this.pruneHistory();
      this.persistResult(result);
      // H-1: 协作完成后向进化引擎反馈每位参与 Agent 的交互数据
      this.feedEvolution(config.participantIds, result);
      return result;
    } finally {
      // v2.2: 归档操作包 try-catch，与 runCrew 保持一致
      try {
        if (result && ws) {
          // 保存非 system 消息为 .md
          const nonSystemMsgs = result.messages.filter(m => m.role !== "system");
          for (const [i, msg] of nonSystemMsgs.entries()) {
            await wsSaveTaskOutput(ws, `msg_${msg.id}`, msg.agentId, msg.content, i + 1);
          }
          const attList = (result.allAttachments ?? []).map(a => ({ path: a.path, filename: a.filename }));
          await collectExternalAttachments(ws, attList);
          const messagesForReadme = nonSystemMsgs.map(m => ({
            id: m.id, agentId: m.agentId, agentName: m.agentName, content: m.content, role: m.role,
          }));
          await generateReadme(ws, null, config.name, result.status, messagesForReadme);
          result.workspaceDir = ws.rootDir;
          this.persistResult(result);  // v2.2: 补一次含 workspaceDir 的持久化
        }
      } catch (archiveErr: any) {
        logger.error({ taskId, err: archiveErr.message }, "工作空间归档失败，不影响协作结果");
        if (result && ws) result.workspaceDir = ws.rootDir;
      }
      this.workspaceDirs.delete(taskId);
      this.runningTasks.delete(taskId);
    }
  }

  /**
   * E-3: 中止正在运行的任务。
   * 触发 AbortController.abort()，级联终止子代理（如有）。
   */
  abort(taskId: string): boolean {
    const entry = this.runningTasks.get(taskId);
    if (!entry) return false;

    entry.abortController.abort();

    // 级联终止子代理（R4: 同步更新 DB 状态，防止 reconcileOrphans 误判）
    if (this.subagentManager) {
      this.subagentManager.killAll(taskId);
      // I-2/R4: DB 中也同步标记为 killed
      this.subagentManager.markAllCancelled(taskId);
      logger.info({ taskId }, "Cascaded killAll to SubagentManager (+ DB sync)");
    }

    logger.info({ taskId, type: entry.info.type }, "Task abort requested");
    return true;
  }

  /** E-3: 获取当前运行中的任务列表 */
  getRunningTasks(): RunningTaskInfo[] {
    return Array.from(this.runningTasks.values()).map((e) => e.info);
  }

  /** C-5: 历史记录容量限制，超出时删除最旧条目 */
  private pruneHistory(): void {
    if (this.runHistory.length > this.maxHistorySize) {
      this.runHistory.splice(0, this.runHistory.length - this.maxHistorySize);
    }
  }

  /** Get execution history */
  getHistory(): Array<CrewResult | GroupChatResult> {
    return [...this.runHistory];
  }

  /** 按 crewId 或 chatId 查找协作结果（用于 deliver API 和结果查询） */
  getResultById(id: string): (CrewResult | GroupChatResult) | undefined {
    // 1. 先查内存热数据
    const memHit = this.runHistory.find(r =>
      (r.type === "crew" && (r as CrewResult).crewId === id) ||
      (r.type === "groupchat" && (r as GroupChatResult).chatId === id)
    );
    if (memHit) return memHit;

    // 2. M-2: 内存未命中时 fallback 到 DB
    try {
      const row = loadCollabHistoryById(id);
      if (!row || typeof row.result !== "string") return undefined;
      const parsed = JSON.parse(row.result) as CrewResult | GroupChatResult;
      // R-2: 旧数据可能无 type 字段，按 DB 记录的 type 列补全
      if (!parsed.type && typeof row.type === "string") {
        (parsed as Record<string, unknown>).type = row.type;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  /** C-4: 分页查询执行历史，支持按类型过滤 */
  getHistoryPaginated(
    page: number,
    pageSize: number,
    type?: "crew" | "groupchat",
  ): { results: Array<CrewResult | GroupChatResult>; total: number } {
    let filtered = this.runHistory;
    if (type === "crew") {
      // G-1: 使用 Discriminated Union type 字段（旧数据已在 loadHistoryFromDB 中补齐）
      filtered = filtered.filter((r) => r.type === "crew");
    } else if (type === "groupchat") {
      filtered = filtered.filter((r) => r.type === "groupchat");
    }
    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const results = filtered.slice(start, start + pageSize);
    return { results, total };
  }

  /** Get stats */
  getStats(): { totalRuns: number; crewRuns: number; chatRuns: number } {
    let crewRuns = 0, chatRuns = 0;
    for (const r of this.runHistory) {
      // G-1: 使用 type 字段替代鸭子类型判断
      if (r.type === "crew") crewRuns++;
      else chatRuns++;
    }
    return { totalRuns: this.runHistory.length, crewRuns, chatRuns };
  }
}
