/**
 * SubagentManager — 子代理生命周期管理（学 OpenClaw Sub-Agent Spawn）
 *
 * 对标 OpenClaw:
 * - src/agents/subagent-spawn.ts (策略检查 + 会话创建 + 注册跟踪)
 * - src/agents/subagent-depth.ts (maxSpawnDepth + childDepth 追踪)
 * - src/agents/tools/sessions-spawn-tool.ts (spawn 工具定义)
 *
 * 核心职责：
 * 1. spawn() — 创建隔离会话 + 注入子代理提示词 + 启动执行
 * 2. announce() — 子代理完成后推送通报给父代理
 * 3. kill() — 终止子代理 + 级联终止其子代理
 * 4. 并发/深度/数量限制
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import { buildSubagentSystemPrompt, filterToolsForDepth } from "./subagent-prompt.js";
import type { SubagentPromptOptions } from "./subagent-prompt.js";

const logger = pino({ name: "subagent-manager" });

// ─── 配置 ──────────────────────────────────────────────────

export interface SpawnConfig {
  /** 全局并发子代理上限（默认 8） */
  maxConcurrent: number;
  /** 每个父代理最大子代理数（默认 5） */
  maxChildrenPerAgent: number;
  /** 最大嵌套深度（默认 2，范围 1-5） */
  maxSpawnDepth: number;
  /** 默认超时（毫秒，0 = 无超时） */
  defaultTimeout: number;
  /** 完成后自动归档延迟（默认 60min） */
  archiveAfterMs: number;
}

export const DEFAULT_SPAWN_CONFIG: SpawnConfig = {
  maxConcurrent: 8,
  maxChildrenPerAgent: 5,
  maxSpawnDepth: 2,
  defaultTimeout: 0,
  archiveAfterMs: 60 * 60 * 1000,
};

// ─── 子代理记录 ────────────────────────────────────────────

export type SubagentStatus = "running" | "success" | "error" | "timeout" | "killed";

export interface SubagentRecord {
  id: string;
  sessionId: string;
  parentSessionId: string;
  task: string;
  label?: string;
  depth: number;
  status: SubagentStatus;
  createdAt: Date;
  completedAt?: Date;
  result?: string;
  error?: string;
  /** 该子代理的子代理 ID 列表 */
  childIds: string[];
  /** 超时计时器句柄 */
  timeoutHandle?: ReturnType<typeof setTimeout>;
  /** 归档计时器句柄 */
  archiveHandle?: ReturnType<typeof setTimeout>;
}

// ─── Spawn 请求 ─────────────────────────────────────────────

export interface SpawnRequest {
  /** 父代理会话 ID */
  parentSessionId: string;
  /** 任务描述 */
  task: string;
  /** 可选标签 */
  label?: string;
  /** 覆盖超时（毫秒） */
  timeout?: number;
  /** 父代理所在渠道 */
  parentChannel?: string;
  /** 父代理名称 */
  parentAgentName?: string;
  /** 所有可用工具名（将按深度过滤） */
  availableTools?: string[];
}

// ─── 执行回调 ───────────────────────────────────────────────

/**
 * 子代理执行回调：由上层 API 注入。
 * 接受系统提示 + 用户消息 + 工具列表，返回最终响应。
 */
export type SubagentExecuteFn = (
  systemPrompt: string,
  userMessage: string,
  allowedTools: string[],
  sessionId: string,
) => Promise<string>;

// ─── SubagentManager 类 ────────────────────────────────────

export class SubagentManager {
  private config: SpawnConfig;
  private registry = new Map<string, SubagentRecord>();
  /** parentSessionId → Set<subagentId> 的反向索引 */
  private parentIndex = new Map<string, Set<string>>();
  /** sessionId → subagentId 的映射 */
  private sessionIndex = new Map<string, string>();
  /** 执行回调（由 API 层注入） */
  private executeFn?: SubagentExecuteFn;

  constructor(config?: Partial<SpawnConfig>) {
    this.config = { ...DEFAULT_SPAWN_CONFIG, ...config };
    // 约束深度范围
    this.config.maxSpawnDepth = Math.max(1, Math.min(5, this.config.maxSpawnDepth));
  }

  /** 注入执行回调 */
  setExecuteFn(fn: SubagentExecuteFn): void {
    this.executeFn = fn;
  }

  // ─── 核心：Spawn ──────────────────────────────────────────

  /**
   * Spawn 一个新的子代理。
   * 对标 OpenClaw subagent-spawn.ts 的策略检查 + 会话创建 + 注册跟踪。
   */
  async spawn(request: SpawnRequest): Promise<SubagentRecord> {
    // 1. 策略检查
    this.validateSpawnPolicy(request.parentSessionId);

    // 2. 计算嵌套深度
    const parentDepth = this.getDepth(request.parentSessionId);
    const childDepth = parentDepth + 1;

    if (childDepth > this.config.maxSpawnDepth) {
      throw new Error(
        `[SubagentManager] Max spawn depth exceeded: ${childDepth} > ${this.config.maxSpawnDepth}`
      );
    }

    // 3. 创建子代理记录
    const subagentId = uuid();
    const sessionId = `sub-${uuid()}`;
    const canSpawn = childDepth < this.config.maxSpawnDepth;

    // 4. 过滤工具列表
    const allowedTools = request.availableTools
      ? filterToolsForDepth(request.availableTools, childDepth)
      : [];

    // 5. 构建子代理系统提示词（7段式）
    const promptOpts: SubagentPromptOptions = {
      parentSessionId: request.parentSessionId,
      childSessionId: sessionId,
      task: request.task,
      label: request.label,
      childDepth,
      maxSpawnDepth: this.config.maxSpawnDepth,
      canSpawn,
      parentChannel: request.parentChannel,
      parentAgentName: request.parentAgentName,
      allowedTools,
    };
    const systemPrompt = buildSubagentSystemPrompt(promptOpts);

    // 6. 注册
    const record: SubagentRecord = {
      id: subagentId,
      sessionId,
      parentSessionId: request.parentSessionId,
      task: request.task,
      label: request.label,
      depth: childDepth,
      status: "running",
      createdAt: new Date(),
      childIds: [],
    };

    this.registry.set(subagentId, record);
    this.sessionIndex.set(sessionId, subagentId);

    // 更新父代理索引
    if (!this.parentIndex.has(request.parentSessionId)) {
      this.parentIndex.set(request.parentSessionId, new Set());
    }
    this.parentIndex.get(request.parentSessionId)!.add(subagentId);

    // 如果父本身也是子代理，追加到其 childIds
    const parentSubId = this.sessionIndex.get(request.parentSessionId);
    if (parentSubId) {
      const parentRecord = this.registry.get(parentSubId);
      if (parentRecord) parentRecord.childIds.push(subagentId);
    }

    logger.info(
      { subagentId, sessionId, depth: childDepth, task: request.task.slice(0, 80) },
      "Sub-agent spawned"
    );

    // 7. 设置超时
    const timeout = request.timeout ?? this.config.defaultTimeout;
    if (timeout > 0) {
      record.timeoutHandle = setTimeout(() => {
        this.handleTimeout(subagentId);
      }, timeout);
    }

    // 8. 异步执行（不阻塞 spawn 返回）
    if (this.executeFn) {
      const execFn = this.executeFn;
      // 使用 microtask 避免阻塞
      Promise.resolve().then(async () => {
        try {
          const result = await execFn(systemPrompt, request.task, allowedTools, sessionId);
          this.complete(subagentId, "success", result);
        } catch (err: any) {
          this.complete(subagentId, "error", undefined, err.message ?? String(err));
        }
      });
    }

    return record;
  }

  // ─── 完成处理 ─────────────────────────────────────────────

  /**
   * 标记子代理完成（内部调用）。
   */
  private complete(
    subagentId: string,
    status: "success" | "error" | "timeout",
    result?: string,
    error?: string,
  ): void {
    const record = this.registry.get(subagentId);
    if (!record || record.status !== "running") return;

    record.status = status;
    record.completedAt = new Date();
    record.result = result;
    record.error = error;

    // 清除超时计时器
    if (record.timeoutHandle) {
      clearTimeout(record.timeoutHandle);
      record.timeoutHandle = undefined;
    }

    logger.info(
      { subagentId, status, durationMs: record.completedAt.getTime() - record.createdAt.getTime() },
      "Sub-agent completed"
    );

    // 设置自动归档
    if (this.config.archiveAfterMs > 0) {
      record.archiveHandle = setTimeout(() => {
        this.archive(subagentId);
      }, this.config.archiveAfterMs);
    }
  }

  /** 超时处理 */
  private handleTimeout(subagentId: string): void {
    const record = this.registry.get(subagentId);
    if (!record || record.status !== "running") return;

    logger.warn({ subagentId }, "Sub-agent timed out");
    this.complete(subagentId, "timeout", undefined, "Execution timed out");
    // 级联终止其子代理
    this.killChildren(subagentId);
  }

  /** 归档子代理（从注册表清理） */
  private archive(subagentId: string): void {
    const record = this.registry.get(subagentId);
    if (!record) return;

    this.registry.delete(subagentId);
    this.sessionIndex.delete(record.sessionId);

    const parentSet = this.parentIndex.get(record.parentSessionId);
    if (parentSet) {
      parentSet.delete(subagentId);
      if (parentSet.size === 0) this.parentIndex.delete(record.parentSessionId);
    }

    logger.debug({ subagentId }, "Sub-agent archived");
  }

  // ─── 终止 ─────────────────────────────────────────────────

  /**
   * 终止指定子代理 + 级联终止其所有子代理。
   * 对标 OpenClaw 的级联终止策略。
   */
  kill(subagentId: string): boolean {
    const record = this.registry.get(subagentId);
    if (!record) return false;

    if (record.status === "running") {
      record.status = "killed";
      record.completedAt = new Date();
      if (record.timeoutHandle) {
        clearTimeout(record.timeoutHandle);
        record.timeoutHandle = undefined;
      }
      logger.info({ subagentId }, "Sub-agent killed");
    }

    // 级联终止子代理
    this.killChildren(subagentId);
    return true;
  }

  /** 级联终止某子代理的所有子代理 */
  private killChildren(subagentId: string): void {
    const record = this.registry.get(subagentId);
    if (!record) return;

    for (const childId of record.childIds) {
      this.kill(childId);
    }
  }

  /**
   * 终止某父代理的所有子代理。
   */
  killAll(parentSessionId: string): number {
    const childSet = this.parentIndex.get(parentSessionId);
    if (!childSet) return 0;

    let count = 0;
    for (const subId of childSet) {
      if (this.kill(subId)) count++;
    }
    return count;
  }

  // ─── 查询 ─────────────────────────────────────────────────

  /** 列出某父代理的所有子代理 */
  list(parentSessionId: string): SubagentRecord[] {
    const childSet = this.parentIndex.get(parentSessionId);
    if (!childSet) return [];

    return Array.from(childSet)
      .map((id) => this.registry.get(id))
      .filter((r): r is SubagentRecord => r !== undefined);
  }

  /** 获取子代理记录 */
  get(subagentId: string): SubagentRecord | undefined {
    return this.registry.get(subagentId);
  }

  /** 通过 sessionId 获取子代理记录 */
  getBySession(sessionId: string): SubagentRecord | undefined {
    const subId = this.sessionIndex.get(sessionId);
    return subId ? this.registry.get(subId) : undefined;
  }

  /** 获取当前 session 的嵌套深度（非子代理返回 0） */
  getDepth(sessionId: string): number {
    const subId = this.sessionIndex.get(sessionId);
    if (!subId) return 0;
    const record = this.registry.get(subId);
    return record?.depth ?? 0;
  }

  /** 获取当前活跃子代理总数 */
  getActiveCount(): number {
    let count = 0;
    for (const record of this.registry.values()) {
      if (record.status === "running") count++;
    }
    return count;
  }

  /** 获取配置（只读） */
  getConfig(): Readonly<SpawnConfig> {
    return { ...this.config };
  }

  // ─── 策略检查 ─────────────────────────────────────────────

  private validateSpawnPolicy(parentSessionId: string): void {
    // 全局并发检查
    const activeCount = this.getActiveCount();
    if (activeCount >= this.config.maxConcurrent) {
      throw new Error(
        `[SubagentManager] Max concurrent sub-agents reached: ${activeCount}/${this.config.maxConcurrent}`
      );
    }

    // 每个父代理子代理数检查
    const childSet = this.parentIndex.get(parentSessionId);
    const childCount = childSet ? childSet.size : 0;
    if (childCount >= this.config.maxChildrenPerAgent) {
      throw new Error(
        `[SubagentManager] Max children per agent reached: ${childCount}/${this.config.maxChildrenPerAgent}`
      );
    }
  }

  /** 清理所有资源（用于测试或关闭时） */
  destroy(): void {
    for (const record of this.registry.values()) {
      if (record.timeoutHandle) clearTimeout(record.timeoutHandle);
      if (record.archiveHandle) clearTimeout(record.archiveHandle);
    }
    this.registry.clear();
    this.parentIndex.clear();
    this.sessionIndex.clear();
  }
}
