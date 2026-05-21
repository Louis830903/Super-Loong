/**
 * CrewExecutor — CrewAI 风格任务编排执行器（B3 上帝文件拆分 — 从 orchestrator.ts 提取）。
 *
 * 支持顺序执行、异步并行分组、层次化执行（含 LLM 智能 Agent 分配）、
 * 子代理委托（E-2）和 Code Node（P0-D）四种执行策略。
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import type { AgentManager } from "../agent/manager.js";
import { EventEmitter } from "eventemitter3";
import type { SubagentManager } from "./subagent-spawn.js";
import type { SubagentAnnouncer } from "./subagent-announce.js";
import { AgentMatcher, type MatchResult } from "./agent-matcher.js";
import {
  createWorkspace,
  saveTaskOutput as wsSaveTaskOutput,
  collectExternalAttachments,
  generateReadme,
  getWorkspacePath,
} from "./workspace.js";
import type { WorkspaceInfo } from "./workspace.js";
import { withTimeout, extractJsonArray, deduplicateAttachments } from "./collab-utils.js";
import type {
  ProcessType, CodeTaskContext, CodeTaskResult,
  CrewTask, CrewConfig, TaskOutput, CrewResult, LLMProviderConfig,
} from "./crew-types.js";

const logger = pino({ name: "collaboration" });

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
      if (signal?.aborted) throw new Error("Execution cancelled by user");

      const task = tasks[i];
      const canParallel = task.async === true && (
        !task.context || task.context.length === 0 ||
        task.context.every(tid => outputMap.has(tid))
      );

      if (!canParallel) {
        const output = await this.executeTask(task, config, crewId, outputMap, signal);
        taskOutputs.push(output);
        outputMap.set(task.id, output.output);
        i++;
        continue;
      }

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

      logger.info({ crewId, groupSize: asyncGroup.length, taskIds: asyncGroup.map(t => t.id) },
        "Executing parallel async task group");
      const settled = await Promise.allSettled(
        asyncGroup.map((t) => this.executeTask(t, config, crewId, outputMap, signal)),
      );

      for (let j = 0; j < settled.length; j++) {
        const result = settled[j];
        if (result.status === "fulfilled") {
          taskOutputs.push(result.value);
          outputMap.set(asyncGroup[j].id, result.value.output);
        } else {
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

    const missingAgent = config.tasks.filter((t) => !t.agentId);
    if (missingAgent.length > 0) {
      throw new Error(
        `Tasks without agentId after assignment phase: ${missingAgent.map((t) => t.id).join(", ")}`,
      );
    }

    const taskList = config.tasks
      .map((t, i) => `Task ${i + 1} [${t.id}]: ${t.description}\n  Assigned to: ${t.agentId}\n  Expected: ${t.expectedOutput}`)
      .join("\n\n");

    const managerPrompt = `You are a project manager coordinating a crew of agents.\n\nCrew: ${config.name}\n${config.description ?? ""}\n\nTasks to coordinate:\n${taskList}\n\nAnalyze task dependencies and determine the optimal execution order. Respond with a JSON array of task IDs in the order they should be executed. Example: ["task1", "task2"]\n\nOnly output the JSON array, nothing else.`;

    let orderedTasks = [...config.tasks];
    try {
      const planResult = await withTimeout(
        manager.chat(managerPrompt),
        30_000,
        "Manager planning",
      );
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
      if (signal?.aborted) throw new Error("Execution cancelled by user");
      const output = await this.executeTask(task, config, crewId, outputMap, signal);
      taskOutputs.push(output);
      outputMap.set(task.id, output.output);
      logger.info({ crewId, taskId: task.id, agentId: task.agentId }, "Task delegated and completed");
    }
  }

  /**
   * 应用 AgentMatcher 的匹配结果：填充现有 agentId 或动态创建新 Agent。
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
        task.agentId = result.matchedAgentId;
        matchedCount++;
        logger.info(
          { crewId, taskId: task.id, agentId: result.matchedAgentId, reason: result.reason },
          "Task auto-assigned to existing agent",
        );
      } else if (result.newAgentConfig) {
        if (!this.globalLlmConfig) {
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
          llmProvider: this.globalLlmConfig,
          systemPrompt: `你是 ${result.newAgentConfig.role}。\n目标：${result.newAgentConfig.goal}\n背景：${result.newAgentConfig.backstory}`,
          metadata: {
            source: "crew-dynamic",
            createdByCrew: crewId,
            createdAt: new Date().toISOString(),
          },
        });
        task.agentId = newAgent.id;
        dynamicCount++;
        const list = this.dynamicAgentIds.get(crewId) ?? [];
        list.push(newAgent.id);
        this.dynamicAgentIds.set(crewId, list);
        logger.info(
          { crewId, taskId: task.id, newAgentId: newAgent.id, name: result.newAgentConfig.name },
          "Task auto-assigned to newly created dynamic agent",
        );
      } else {
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
    if (task.executor === "code" && task.codeHandler) {
      return this.executeCodeTask(task, config, crewId, outputMap, signal);
    }

    if (!task.agentId) {
      throw new Error(`Task '${task.id}' has no agentId (auto-assign may have failed)`);
    }
    const taskAgentId = task.agentId;
    const agent = this.agentManager.getAgent(taskAgentId);
    if (!agent) throw new Error(`Agent '${taskAgentId}' not found for task '${task.id}'`);

    const maxRetries = config.maxRetries ?? 2;
    let retries = 0;
    const taskStart = Date.now();

    let contextStr = "";
    if (task.context?.length) {
      const parts = task.context
        .map((tid) => outputMap.get(tid))
        .filter(Boolean);
      if (parts.length > 0) {
        contextStr = `\n\nContext from previous tasks:\n${parts.join("\n---\n")}`;
      }
    }

    let description = task.description;
    if (config.inputs) {
      for (const [key, value] of Object.entries(config.inputs)) {
        description = description.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
      }
    }

    const wsDir = this.getWorkspaceDir?.(crewId);
    const workspaceHint = wsDir
      ? `\n\n## 📁 文件输出要求\n你的工作空间目录是: ${wsDir}\n请将所有产出文件保存到此目录。\n\n文件产出规范：\n- 文本报告/代码文件 → 使用 write_file 工具直接写入工作空间目录\n- 如需生成二进制文件（PPT/Word/Excel/PDF/图片），请使用 run_python 执行 Python 代码生成后在最终回复中输出 MEDIA:/path/to/file 让系统自动收集为附件`
      : "";

    let prompt = `${description}${contextStr}\n\nExpected output: ${task.expectedOutput}${workspaceHint}`;

    this.emit("task:start", { crewId, taskId: task.id, agentId: task.agentId });
    logger.info(
      { crewId, taskId: task.id, agentId: taskAgentId, phase: "start", executor: "agent" },
      "Task started (agent.chat executor)",
    );

    if (task.useSubagent && this.subagentManager) {
      const parentSessionId = `crew_${crewId}`;
      const subagentTimeoutMs = task.subagentTimeout ?? config.taskTimeoutMs ?? 3_600_000;

      const record = await this.subagentManager.spawn({
        parentSessionId,
        task: prompt,
        label: `crew-task-${task.id}`,
        timeout: subagentTimeoutMs,
        availableTools: [],
      });

      logger.info({ crewId, taskId: task.id, subagentId: record.id }, "Task delegated to sub-agent");

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
        { crewId, taskId: task.id, agentId: taskAgentId, phase: "complete", executor: "subagent", durationMs: output.durationMs, retries: 0 },
        "Task completed (subagent executor)",
      );
      return output;
    }

    while (retries <= maxRetries) {
      if (signal?.aborted) throw new Error("Execution cancelled by user");
      const timeoutMs = config.taskTimeoutMs ?? 3_600_000;
      const { response, attachments } = await withTimeout(
        agent.chat(prompt, `crew_${crewId}_${task.id}`),
        timeoutMs,
        `Task '${task.id}' agent.chat`,
      );

      if (task.guardrail) {
        const validation = task.guardrail(response);
        if (!validation.valid) {
          retries++;
          if (retries > maxRetries) {
            throw new Error(`Task '${task.id}' failed guardrail after ${maxRetries} retries: ${validation.feedback}`);
          }
          prompt += `\n\n[GUARDRAIL FEEDBACK] 你的上一次输出未通过校验：${validation.feedback}。请严格按照要求的 JSON 格式重新输出，修正上述问题。`;
          logger.warn(
            { crewId, taskId: task.id, agentId: taskAgentId, phase: "guardrail_failed", executor: "agent", retries, feedback: validation.feedback },
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
        { crewId, taskId: task.id, agentId: taskAgentId, phase: "complete", executor: "agent", durationMs: output.durationMs, retries, hasAttachments: !!attachments?.length },
        "Task completed (agent.chat executor)",
      );
      return output;
    }

    throw new Error(`Task '${task.id}' exhausted all retries`);
  }

  /**
   * P0-D: 执行 Code Node 任务（确定性代码路径，不经过 LLM）。
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
    const agentIdForOutput = task.agentId ?? `code-node:${task.id}`;
    const taskStart = Date.now();

    const wsDir = this.getWorkspaceDir?.(crewId);
    const ctx: CodeTaskContext = {
      taskId: task.id,
      crewId,
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
            { crewId, taskId: task.id, agentId: agentIdForOutput, phase: "failed", executor: "code", retries: retries - 1, error: msg },
            "Code task exhausted retries",
          );
          throw new Error(`Task '${task.id}' code handler failed after ${maxRetries} retries: ${msg}`);
        }
        logger.warn(
          { crewId, taskId: task.id, agentId: agentIdForOutput, phase: "code_retry", executor: "code", retries, error: msg },
          "Code handler threw, retrying",
        );
        continue;
      }

      if (task.guardrail) {
        const validation = task.guardrail(result.output);
        if (!validation.valid) {
          retries++;
          if (retries > maxRetries) {
            throw new Error(`Task '${task.id}' failed guardrail after ${maxRetries} retries: ${validation.feedback}`);
          }
          logger.warn(
            { crewId, taskId: task.id, agentId: agentIdForOutput, phase: "guardrail_failed", executor: "code", retries, feedback: validation.feedback },
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
        { crewId, taskId: task.id, agentId: agentIdForOutput, phase: "complete", executor: "code", durationMs: output.durationMs, retries, hasAttachments: !!result.attachments?.length },
        "Task completed (code executor)",
      );
      return output;
    }

    throw new Error(`Task '${task.id}' exhausted all retries`);
  }

  /**
   * E-2/M4: 等待子代理完成。优先使用 SubagentAnnouncer 事件，无则轮询。
   */
  private waitForSubagent(subagentId: string, parentSessionId: string, timeoutMs: number): Promise<string> {
    return withTimeout(
      new Promise<string>((resolve, reject) => {
        const mgr = this.subagentManager!;

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

        const poll = setInterval(() => {
          if (check()) clearInterval(poll);
        }, 500);
      }),
      timeoutMs,
      `waitForSubagent(${subagentId})`,
    );
  }
}
