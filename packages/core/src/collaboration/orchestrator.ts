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
import { EventEmitter } from "eventemitter3";
import { saveCollabHistory, loadCollabHistory, loadCollabHistoryById } from "../persistence/sqlite.js";
import type { SubagentManager } from "./subagent-spawn.js";
import type { SubagentAnnouncer } from "./subagent-announce.js";
import type { EvolutionEngine } from "../evolution/engine.js";
import type { Attachment, LLMProviderConfig } from "../types/index.js";
import type { IAgentRegistry } from "./agent-registry.js";
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
} from "./workspace.js";
import type { WorkspaceInfo } from "./workspace.js";

// B3: 从子文件导入（CollaborationOrchestrator 本文件所需）
import { CrewExecutor } from "./crew-executor.js";
import { stripBase64FromAttachments } from "./collab-utils.js";
import type { CollabMessage, CrewConfig, CrewResult } from "./crew-types.js";

// B3: 已提取到子文件的符号，re-export 保持 `import { ... } from "./orchestrator.js"` 向后兼容
export { CrewExecutor };
export { withTimeout } from "./collab-utils.js";
export type {
  CollabMessage, ProcessType, CodeTaskContext, CodeTaskResult,
  CrewTask, CrewConfig, TaskOutput, CrewResult,
} from "./crew-types.js";

const logger = pino({ name: "collaboration" });

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
