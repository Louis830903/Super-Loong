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
import { saveCollabHistory, loadCollabHistory } from "../persistence/sqlite.js";

const logger = pino({ name: "collaboration" });

// ─── 超时防护工具函数（参考 sandbox.ts Promise.race 模式） ────

/** 为异步操作添加超时保护，防止 LLM 无响应时协作永久挂起 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

// ─── Shared Types ────────────────────────────────────────────

export interface CollabMessage {
  id: string;
  agentId: string;
  agentName: string;
  content: string;
  role: "task_output" | "chat" | "system" | "handoff";
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// PART 1: Task Orchestration (CrewAI-style)
// ═══════════════════════════════════════════════════════════════

export type ProcessType = "sequential" | "hierarchical";

export interface CrewTask {
  id: string;
  description: string;
  expectedOutput: string;
  agentId: string;
  /** IDs of prerequisite tasks whose output feeds as context */
  context?: string[];
  /** If true, can run in parallel with other async tasks */
  async?: boolean;
  /** Optional guardrail validation for the output */
  guardrail?: (output: string) => { valid: boolean; feedback?: string };
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
  /** 单个任务的超时时间（毫秒），默认 120000（2分钟） */
  taskTimeoutMs?: number;
}

export interface TaskOutput {
  taskId: string;
  agentId: string;
  output: string;
  retries: number;
  durationMs: number;
  timestamp: Date;
}

export interface CrewResult {
  crewId: string;
  name: string;
  process: ProcessType;
  status: "completed" | "failed" | "partial";
  taskOutputs: TaskOutput[];
  finalOutput: string;
  totalDurationMs: number;
  error?: string;
}

// ─── Crew Executor ───────────────────────────────────────────

export class CrewExecutor extends EventEmitter {
  private agentManager: AgentManager;

  constructor(agentManager: AgentManager) {
    super();
    this.agentManager = agentManager;
  }

  /** Execute a crew with the given config */
  async run(config: CrewConfig): Promise<CrewResult> {
    const crewId = config.id ?? `crew_${uuid().slice(0, 8)}`;
    const startTime = Date.now();
    const taskOutputs: TaskOutput[] = [];
    const outputMap = new Map<string, string>(); // taskId -> output

    logger.info({ crewId, name: config.name, process: config.process, tasks: config.tasks.length },
      "Crew started");
    this.emit("crew:start", { crewId, name: config.name });

    try {
      let hasSoftFailure = false;
      if (config.process === "sequential") {
        hasSoftFailure = await this.runSequential(config, crewId, taskOutputs, outputMap);
      } else {
        await this.runHierarchical(config, crewId, taskOutputs, outputMap);
      }

      const result: CrewResult = {
        crewId,
        name: config.name,
        process: config.process,
        status: hasSoftFailure ? "partial" : "completed",
        taskOutputs,
        finalOutput: taskOutputs.length > 0 ? taskOutputs[taskOutputs.length - 1].output : "",
        totalDurationMs: Date.now() - startTime,
      };

      logger.info({ crewId, tasks: taskOutputs.length, durationMs: result.totalDurationMs },
        "Crew completed");
      this.emit("crew:complete", result);
      return result;
    } catch (err: any) {
      const result: CrewResult = {
        crewId,
        name: config.name,
        process: config.process,
        status: "failed",
        taskOutputs,
        finalOutput: "",
        totalDurationMs: Date.now() - startTime,
        error: err.message,
      };
      logger.error({ crewId, err: err.message }, "Crew failed");
      this.emit("crew:error", { crewId, error: err.message });
      return result;
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
  ): Promise<boolean> {
    const tasks = config.tasks;
    let i = 0;
    let hasSoftFailure = false;

    while (i < tasks.length) {
      const task = tasks[i];
      // 判断是否可并行：async===true 且无 context 依赖
      const canParallel = task.async === true && (!task.context || task.context.length === 0);

      if (!canParallel) {
        // 同步屏障：单独执行
        const output = await this.executeTask(task, config, crewId, outputMap);
        taskOutputs.push(output);
        outputMap.set(task.id, output.output);
        i++;
        continue;
      }

      // 收集连续的可并行任务组
      const asyncGroup: CrewTask[] = [];
      while (i < tasks.length) {
        const t = tasks[i];
        if (t.async === true && (!t.context || t.context.length === 0)) {
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
        asyncGroup.map((t) => this.executeTask(t, config, crewId, outputMap)),
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
            agentId: asyncGroup[j].agentId,
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
  ): Promise<void> {
    const managerId = config.managerAgentId;
    if (!managerId) throw new Error("Hierarchical process requires managerAgentId");

    const manager = this.agentManager.getAgent(managerId);
    if (!manager) throw new Error(`Manager agent '${managerId}' not found`);

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
      const jsonMatch = planResult.response.match(/\[([\s\S]*?)\]/);
      if (jsonMatch) {
        const orderedIds: string[] = JSON.parse(jsonMatch[0]);
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
      const output = await this.executeTask(task, config, crewId, outputMap);
      taskOutputs.push(output);
      outputMap.set(task.id, output.output);
      logger.info({ crewId, taskId: task.id, agentId: task.agentId }, "Task delegated and completed");
    }
  }

  /** Execute a single task with retry support */
  private async executeTask(
    task: CrewTask,
    config: CrewConfig,
    crewId: string,
    outputMap: Map<string, string>,
  ): Promise<TaskOutput> {
    const agent = this.agentManager.getAgent(task.agentId);
    if (!agent) throw new Error(`Agent '${task.agentId}' not found for task '${task.id}'`);

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

    const prompt = `${description}${contextStr}\n\nExpected output: ${task.expectedOutput}`;

    this.emit("task:start", { crewId, taskId: task.id, agentId: task.agentId });

    while (retries <= maxRetries) {
      const timeoutMs = config.taskTimeoutMs ?? 120_000;
      const { response } = await withTimeout(
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
          logger.warn({ taskId: task.id, retries, feedback: validation.feedback }, "Task guardrail failed, retrying");
          continue;
        }
      }

      const output: TaskOutput = {
        taskId: task.id,
        agentId: task.agentId,
        output: response,
        retries,
        durationMs: Date.now() - taskStart,
        timestamp: new Date(),
      };

      this.emit("task:complete", { crewId, ...output });
      return output;
    }

    throw new Error(`Task '${task.id}' exhausted all retries`);
  }
}

// ═══════════════════════════════════════════════════════════════
// PART 2: Conversation Negotiation (AutoGen-style)
// ═══════════════════════════════════════════════════════════════

export type SpeakerSelectionMethod = "round_robin" | "random" | "manual" | "auto";

export interface GroupChatConfig {
  id?: string;
  name: string;
  description?: string;
  participantIds: string[];
  /** How to select the next speaker */
  speakerSelection: SpeakerSelectionMethod;
  /** Maximum conversation turns before stopping */
  maxTurns: number;
  /** Stop when any agent says this keyword */
  terminationKeyword?: string;
  /** Custom termination condition */
  terminationCondition?: (messages: CollabMessage[]) => boolean;
  /** System message to provide conversation context */
  systemMessage?: string;
  /** If "auto", which agent decides the next speaker */
  moderatorAgentId?: string;
  /** 每轮对话的超时时间（毫秒），默认 60000（1分钟） */
  turnTimeoutMs?: number;
  /** C-3: 上下文窗口大小（最近N条消息），默认 20 */
  contextWindowSize?: number;
}

export interface GroupChatResult {
  chatId: string;
  name: string;
  status: "completed" | "terminated" | "max_turns" | "error";
  messages: CollabMessage[];
  turns: number;
  totalDurationMs: number;
  summary?: string;
  error?: string;
}

// ─── GroupChat Executor ──────────────────────────────────────

export class GroupChatExecutor extends EventEmitter {
  private agentManager: AgentManager;

  constructor(agentManager: AgentManager) {
    super();
    this.agentManager = agentManager;
  }

  /** Run a group chat session */
  async run(config: GroupChatConfig, initialMessage: string): Promise<GroupChatResult> {
    const chatId = config.id ?? `gchat_${uuid().slice(0, 8)}`;
    const startTime = Date.now();
    const messages: CollabMessage[] = [];
    const participants = this.resolveParticipants(config.participantIds);

    logger.info({ chatId, name: config.name, participants: participants.length, maxTurns: config.maxTurns },
      "GroupChat started");
    this.emit("groupchat:start", { chatId, name: config.name });

    // Add system context
    if (config.systemMessage) {
      messages.push({
        id: uuid(),
        agentId: "system",
        agentName: "System",
        content: config.systemMessage,
        role: "system",
        timestamp: new Date(),
      });
    }

    // Add initial user message
    messages.push({
      id: uuid(),
      agentId: "user",
      agentName: "User",
      content: initialMessage,
      role: "chat",
      timestamp: new Date(),
    });

    let turn = 0;
    let speakerIndex = 0;
    let status: GroupChatResult["status"] = "max_turns";

    try {
      while (turn < config.maxTurns) {
        turn++;

        // Select next speaker
        const speaker = await this.selectSpeaker(
          config,
          participants,
          messages,
          speakerIndex,
        );

        if (!speaker) {
          status = "error";
          break;
        }

        // Build conversation context for the speaker
        const conversationContext = this.buildConversationContext(config, messages, speaker);

        // Get speaker's response
        const sessionId = `gchat_${chatId}_${speaker.id}`;
        const turnTimeoutMs = config.turnTimeoutMs ?? 60_000;
        const { response } = await withTimeout(
          speaker.chat(conversationContext, sessionId),
          turnTimeoutMs,
          `GroupChat turn ${turn}`,
        );

        const msg: CollabMessage = {
          id: uuid(),
          agentId: speaker.id,
          agentName: speaker.state.config.name,
          content: response,
          role: "chat",
          timestamp: new Date(),
        };
        messages.push(msg);

        this.emit("groupchat:message", { chatId, message: msg, turn });

        // Check termination conditions
        if (config.terminationKeyword && response.includes(config.terminationKeyword)) {
          status = "terminated";
          logger.info({ chatId, turn, keyword: config.terminationKeyword }, "GroupChat terminated by keyword");
          break;
        }

        if (config.terminationCondition?.(messages)) {
          status = "terminated";
          logger.info({ chatId, turn }, "GroupChat terminated by custom condition");
          break;
        }

        // Advance speaker index for round-robin
        speakerIndex = (participants.indexOf(speaker) + 1) % participants.length;
      }

      if (turn >= config.maxTurns && status === "max_turns") {
        logger.info({ chatId, turn }, "GroupChat reached max turns");
      }

      const result: GroupChatResult = {
        chatId,
        name: config.name,
        status,
        messages,
        turns: turn,
        totalDurationMs: Date.now() - startTime,
        summary: messages.length > 0 ? messages[messages.length - 1].content : "",
      };

      this.emit("groupchat:complete", result);
      return result;
    } catch (err: any) {
      return {
        chatId,
        name: config.name,
        status: "error",
        messages,
        turns: turn,
        totalDurationMs: Date.now() - startTime,
        error: err.message,
      };
    }
  }

  /** Resolve participant agent IDs to AgentRuntime instances */
  private resolveParticipants(ids: string[]): AgentRuntime[] {
    return ids.map((id) => {
      const agent = this.agentManager.getAgent(id);
      if (!agent) throw new Error(`Participant agent '${id}' not found`);
      return agent;
    });
  }

  /** Select the next speaker based on the configured method */
  private async selectSpeaker(
    config: GroupChatConfig,
    participants: AgentRuntime[],
    messages: CollabMessage[],
    currentIndex: number,
  ): Promise<AgentRuntime | null> {
    switch (config.speakerSelection) {
      case "round_robin":
        return participants[currentIndex % participants.length];

      case "random":
        return participants[Math.floor(Math.random() * participants.length)];

      case "auto": {
        // LLM-based speaker selection via moderator agent
        return this.autoSelectSpeaker(config, participants, messages);
      }

      case "manual":
        // In manual mode, return first participant (caller should set via handoff)
        return participants[currentIndex % participants.length];

      default:
        return participants[0];
    }
  }

  /**
   * LLM-based speaker selection (AutoGen-style) — C-2 优化版.
   * 改进匹配逻辑：完全匹配 > id匹配 > 模糊匹配 > round_robin fallback。
   * 避免同一 agent 连续发言（除非只有2个参与者）。
   * lastSpeakerByChat 按 chatId 隔离，防止多会话并发时状态污染。
   */
  private lastSpeakerByChat = new Map<string, string | null>();

  private async autoSelectSpeaker(
    config: GroupChatConfig,
    participants: AgentRuntime[],
    messages: CollabMessage[],
  ): Promise<AgentRuntime | null> {
    const chatKey = config.id ?? "default";
    const moderatorId = config.moderatorAgentId ?? config.participantIds[0];
    const moderator = this.agentManager.getAgent(moderatorId);
    if (!moderator) return participants[0]; // fallback

    const participantList = participants
      .map((p) => `- ${p.state.config.name} (${p.id}): ${p.state.config.description ?? p.state.config.role ?? "agent"}`)
      .join("\n");

    const recentMessages = messages.slice(-10)
      .map((m) => `[${m.agentName}]: ${m.content.slice(0, 200)}`)
      .join("\n");

    const selectionPrompt = `You are selecting the next speaker in a group conversation.

Participants:
${participantList}

Recent conversation:
${recentMessages}

Based on the conversation flow, who should speak next? Respond with ONLY the exact agent name. Do not explain your choice.`;

    const { response } = await withTimeout(
      moderator.chat(selectionPrompt, `speaker_select_${config.id}`),
      30_000,
      "Speaker selection",
    );

    const normalized = response.trim().toLowerCase();

    // C-2: 优先完全匹配 agent name
    let match = participants.find((p) => p.state.config.name.toLowerCase() === normalized);
    // 其次匹配 agent id
    if (!match) match = participants.find((p) => p.id.toLowerCase() === normalized);
    // 再次模糊匹配（包含关系）
    if (!match) match = participants.find((p) => normalized.includes(p.state.config.name.toLowerCase()));

    // C-2: 避免同一 agent 连续发言（>2 参与者时），按 chatId 隔离
    const lastSpeakerId = this.lastSpeakerByChat.get(chatKey) ?? null;
    if (match && lastSpeakerId === match.id && participants.length > 2) {
      const others = participants.filter((p) => p.id !== match!.id);
      match = others[Math.floor(Math.random() * others.length)];
    }

    const selected = match ?? participants[0];
    this.lastSpeakerByChat.set(chatKey, selected.id);
    return selected;
  }

  /** Build the conversation context string for a speaker (C-3: 可配置上下文窗口) */
  private buildConversationContext(
    config: GroupChatConfig,
    messages: CollabMessage[],
    speaker: AgentRuntime,
  ): string {
    const windowSize = config.contextWindowSize ?? 20;
    const recentMessages = messages.slice(-windowSize)
      .map((m) => {
        const prefix = m.agentId === speaker.id ? "[You]" : `[${m.agentName}]`;
        return `${prefix}: ${m.content}`;
      })
      .join("\n\n");

    const otherParticipants = config.participantIds
      .filter((id) => id !== speaker.id)
      .map((id) => {
        const agent = this.agentManager.getAgent(id);
        return agent ? agent.state.config.name : id;
      })
      .join(", ");

    return `You are participating in a group conversation "${config.name}".
Other participants: ${otherParticipants}

Conversation so far:
${recentMessages}

Please contribute your perspective. Be concise and relevant.${
      config.terminationKeyword
        ? `\n\nWhen the group has reached consensus or the task is complete, include "${config.terminationKeyword}" in your response.`
        : ""
    }`;
  }
}

// ═══════════════════════════════════════════════════════════════
// PART 3: Unified Collaboration Orchestrator
// ═══════════════════════════════════════════════════════════════

export class CollaborationOrchestrator extends EventEmitter {
  readonly crew: CrewExecutor;
  readonly groupChat: GroupChatExecutor;
  private runHistory: Array<CrewResult | GroupChatResult> = [];
  // C-5: 历史记录最大容量，超出时删除最旧条目
  private maxHistorySize = 100;

  constructor(agentManager: AgentManager) {
    super();
    this.crew = new CrewExecutor(agentManager);
    this.groupChat = new GroupChatExecutor(agentManager);

    // Forward events
    this.crew.on("crew:start", (e) => this.emit("collab:event", { type: "crew:start", ...e }));
    this.crew.on("crew:complete", (e) => this.emit("collab:event", { type: "crew:complete", ...e }));
    this.crew.on("crew:error", (e) => this.emit("collab:event", { type: "crew:error", ...e }));
    this.crew.on("task:start", (e) => this.emit("collab:event", { type: "task:start", ...e }));
    this.crew.on("task:complete", (e) => this.emit("collab:event", { type: "task:complete", ...e }));
    this.groupChat.on("groupchat:start", (e) => this.emit("collab:event", { type: "groupchat:start", ...e }));
    this.groupChat.on("groupchat:complete", (e) => this.emit("collab:event", { type: "groupchat:complete", ...e }));
    this.groupChat.on("groupchat:message", (e) => this.emit("collab:event", { type: "groupchat:message", ...e }));

    // Restore persisted history on startup
    this.loadHistoryFromDB();
  }

  /** Load persisted collaboration history from SQLite */
  private loadHistoryFromDB(): void {
    try {
      const rows = loadCollabHistory(200);
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.result as string);
          this.runHistory.push(parsed);
        } catch {
          logger.warn({ id: row.id }, "Failed to parse collab history entry");
        }
      }
      if (rows.length > 0) {
        logger.info({ count: rows.length }, "Collaboration history restored from database");
      }
    } catch {
      // DB not initialized yet or first run
    }
  }

  /** Persist a result to SQLite */
  private persistResult(result: CrewResult | GroupChatResult): void {
    try {
      const isCrew = "process" in result;
      const id = isCrew ? (result as CrewResult).crewId : (result as GroupChatResult).chatId;
      saveCollabHistory({
        id,
        type: isCrew ? "crew" : "groupchat",
        name: result.name,
        status: result.status,
        result: JSON.stringify(result),
        durationMs: result.totalDurationMs,
      });
    } catch (err) {
      logger.warn({ error: err }, "Failed to persist collaboration result");
    }
  }

  /** Run a task-orchestrated crew */
  async runCrew(config: CrewConfig): Promise<CrewResult> {
    const result = await this.crew.run(config);
    this.runHistory.push(result);
    this.pruneHistory(); // C-5: 容量限制
    this.persistResult(result);
    return result;
  }

  /** Run a group chat conversation */
  async runGroupChat(config: GroupChatConfig, initialMessage: string): Promise<GroupChatResult> {
    const result = await this.groupChat.run(config, initialMessage);
    this.runHistory.push(result);
    this.pruneHistory(); // C-5: 容量限制
    this.persistResult(result);
    return result;
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

  /** C-4: 分页查询执行历史，支持按类型过滤 */
  getHistoryPaginated(
    page: number,
    pageSize: number,
    type?: "crew" | "groupchat",
  ): { results: Array<CrewResult | GroupChatResult>; total: number } {
    let filtered = this.runHistory;
    if (type === "crew") {
      filtered = filtered.filter((r) => "process" in r);
    } else if (type === "groupchat") {
      filtered = filtered.filter((r) => !("process" in r));
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
      if ("process" in r) crewRuns++;
      else chatRuns++;
    }
    return { totalRuns: this.runHistory.length, crewRuns, chatRuns };
  }
}
