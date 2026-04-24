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
import {
  saveSubagentRun,
  updateSubagentRunStatus,
  findOrphanSubagentRuns,
  archiveSubagentRun,
  markSubagentRunsCancelled,
} from "../persistence/sqlite.js";

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
  // G-4: archiveHandle 已移除 — 改为 cleanupExpired() 惰性清理
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
  /** I-1: 调用方可覆盖最大深度（默认使用全局 config.maxSpawnDepth） */
  maxDepth?: number;
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

// ─── I-5: 子代理生命周期 Hook 接口 ─────────────────────────────

/**
 * I-5: 子代理生命周期 Hook（学 OpenClaw subagent-registry-lifecycle 的 spawning/delivery/ended hooks）。
 * 允许外部插件参与 spawn/complete/kill 过程（如日志审计、通知、资源预分配）。
 */
export interface SubagentLifecycleHook {
  name: string;
  /** spawn 前调用，可修改 spawn 选项或返回 "reject" 拒绝 spawn */
  onSpawning?(record: SubagentRecord, request: SpawnRequest): Promise<void | "reject">;
  /** 子代理完成/失败/被杀时调用 */
  onEnded?(record: SubagentRecord, result: { status: string; output?: string; error?: string }): Promise<void>;
}

/**
 * I-5/M6: 为 Hook 执行添加超时保护，防止某个 hook 实现耗时过长阻塞核心流程。
 */
const withHookTimeout = <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`[HookTimeout] ${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
};

/** I-5: 每个 hook 的最大执行时间（毫秒） */
const HOOK_TIMEOUT_MS = 5_000;

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
  /** I-5: 已注册的生命周期 Hook 列表 */
  private hooks: SubagentLifecycleHook[] = [];

  constructor(config?: Partial<SpawnConfig>) {
    this.config = { ...DEFAULT_SPAWN_CONFIG, ...config };
    // 约束深度范围
    this.config.maxSpawnDepth = Math.max(1, Math.min(5, this.config.maxSpawnDepth));
  }

  /** 注入执行回调 */
  setExecuteFn(fn: SubagentExecuteFn): void {
    this.executeFn = fn;
  }

  /** I-5: 注册生命周期 Hook */
  registerHook(hook: SubagentLifecycleHook): void {
    this.hooks.push(hook);
    logger.info({ hookName: hook.name }, "I-5: Lifecycle hook registered");
  }

  /** I-5: 移除生命周期 Hook */
  removeHook(name: string): void {
    this.hooks = this.hooks.filter((h) => h.name !== name);
    logger.info({ hookName: name }, "I-5: Lifecycle hook removed");
  }

  // ─── 核心：Spawn ──────────────────────────────────────────

  /**
   * Spawn 一个新的子代理。
   * 对标 OpenClaw subagent-spawn.ts 的策略检查 + 会话创建 + 注册跟踪。
   */
  async spawn(request: SpawnRequest): Promise<SubagentRecord> {
    // G-4: 惰性清理 — 每次 spawn 时顺带清理过期的记录
    this.cleanupExpired();

    // 1. 策略检查
    this.validateSpawnPolicy(request.parentSessionId);

    // 2. 计算嵌套深度
    const parentDepth = this.getDepth(request.parentSessionId);
    const childDepth = parentDepth + 1;

    // I-1: 调用方可覆盖最大深度（约束 1-5 范围），否则使用全局配置
    const effectiveMaxDepth = request.maxDepth
      ? Math.max(1, Math.min(5, request.maxDepth))
      : this.config.maxSpawnDepth;

    if (childDepth > effectiveMaxDepth) {
      throw new Error(
        `[SubagentManager] Max spawn depth exceeded: ${childDepth} > ${effectiveMaxDepth}`
      );
    }

    // 3. 创建子代理记录
    const subagentId = uuid();
    const sessionId = `sub-${uuid()}`;
    const canSpawn = childDepth < effectiveMaxDepth;

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
      maxSpawnDepth: effectiveMaxDepth,
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

    // I-2/P1: 异步写入 DB（fire-and-forget，不阻塞 spawn 返回）
    try {
      saveSubagentRun({
        id: subagentId,
        sessionId,
        parentSessionId: request.parentSessionId,
        task: request.task.slice(0, 500),
        label: request.label,
        depth: childDepth,
        status: "running",
        createdAt: record.createdAt.toISOString(),
      });
    } catch (err) {
      logger.warn({ subagentId, error: err }, "I-2: Failed to persist subagent run to DB (non-fatal)");
    }

    // I-5: 触发 onSpawning hooks（M6: 每个 hook 有 5s 超时保护）
    for (const hook of this.hooks) {
      if (hook.onSpawning) {
        try {
          const hookResult = await withHookTimeout(
            hook.onSpawning(record, request),
            HOOK_TIMEOUT_MS,
            `Hook "${hook.name}" onSpawning`,
          );
          if (hookResult === "reject") {
            // Hook 拒绝 spawn → 清理已注册的记录
            this.registry.delete(subagentId);
            this.sessionIndex.delete(sessionId);
            const parentSet = this.parentIndex.get(request.parentSessionId);
            if (parentSet) parentSet.delete(subagentId);
            throw new Error(`Spawn rejected by lifecycle hook: ${hook.name}`);
          }
        } catch (err: any) {
          if (err.message?.includes("rejected by lifecycle hook")) throw err;
          logger.warn({ hookName: hook.name, error: err.message }, "I-5: onSpawning hook failed (non-fatal, continuing)");
        }
      }
    }

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

    // I-2: 同步更新 DB 状态
    try {
      updateSubagentRunStatus(
        subagentId,
        status,
        record.completedAt.toISOString(),
        result,
        error,
      );
    } catch (err) {
      logger.warn({ subagentId, error: err }, "I-2: Failed to update subagent run status in DB (non-fatal)");
    }

    // I-5: 触发 onEnded hooks（M6: 每个 hook 有 5s 超时保护，异步不阻塞）
    for (const hook of this.hooks) {
      if (hook.onEnded) {
        withHookTimeout(
          hook.onEnded(record, { status, output: result, error }),
          HOOK_TIMEOUT_MS,
          `Hook "${hook.name}" onEnded`,
        ).catch((err) => {
          logger.warn({ hookName: hook.name, error: err.message }, "I-5: onEnded hook failed (non-fatal)");
        });
      }
    }

    // G-4: 移除 archiveHandle setTimeout — 改为 spawn() 入口的 cleanupExpired() 惰性清理
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

    // I-2/M3: 同步清理 DB 记录，防止内存和 DB 状态不一致
    try {
      archiveSubagentRun(subagentId);
    } catch (err) {
      logger.warn({ subagentId, error: err }, "I-2/M3: Failed to archive subagent run in DB");
    }

    logger.debug({ subagentId }, "Sub-agent archived");
  }

  // ─── G-4: 惰性清理 ──────────────────────────────────────────

  /**
   * G-4: 惰性清理过期记录（替代 archiveHandle setTimeout）。
   * 遍历 registry，对已完成且超过 archiveAfterMs 的记录调用 archive()。
   * 在 spawn() 入口处调用，每次创建新子代理时顺带清理过期的。
   * M3 预留：当 I-2 DB 持久化实施后，archive() 需同步清理 DB 记录。
   */
  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, record] of this.registry) {
      if (record.status !== "running" && record.completedAt) {
        if (now - record.completedAt.getTime() > this.config.archiveAfterMs) {
          this.archive(id);
          cleaned++;
        }
      }
    }
    if (cleaned > 0) {
      logger.info({ cleaned }, "Expired sub-agent records cleaned up");
    }
    return cleaned;
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
      // I-2: 同步更新 DB 状态
      try {
        updateSubagentRunStatus(subagentId, "killed", record.completedAt.toISOString());
      } catch (err) {
        logger.warn({ subagentId, error: err }, "I-2: Failed to update killed status in DB");
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

  /**
   * E-2/R3: 注册虚拟根记录。
   * Crew 编排开始前注册一个 depth=0 的虚拟 session 作为子代理的 parent，
   * 使 getDepth / validateSpawnPolicy / announce 回退等链路能正确追溯。
   */
  registerVirtualRoot(sessionId: string, label?: string): void {
    if (this.sessionIndex.has(sessionId)) {
      logger.debug({ sessionId }, "Virtual root already registered, skipping");
      return;
    }

    const record: SubagentRecord = {
      id: sessionId,
      sessionId,
      parentSessionId: "",  // 顶层无父
      task: label ?? "Virtual root for crew execution",
      label: label ?? "crew-root",
      depth: 0,
      status: "running",
      createdAt: new Date(),
      childIds: [],
    };

    this.registry.set(record.id, record);
    this.sessionIndex.set(record.sessionId, record.id);
    logger.info({ sessionId }, "Virtual root registered");
  }

  /**
   * E-2/R3: 标记虚拟根为已完成。
   * Crew 执行结束后调用，防止 orphan recovery 误判。
   */
  completeVirtualRoot(sessionId: string): void {
    const id = this.sessionIndex.get(sessionId);
    if (!id) return;
    const record = this.registry.get(id);
    if (record && record.status === "running") {
      record.status = "success";
      record.completedAt = new Date();
      logger.info({ sessionId }, "Virtual root marked completed");
    }
  }

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

  /**
   * 获取当前 session 的嵌套深度（非子代理返回 0）。
   * I-1: 增加 visited set 防循环，沿 parentSessionId 链向上追溯。
   */
  getDepth(sessionId: string): number {
    const subId = this.sessionIndex.get(sessionId);
    if (!subId) return 0;
    const record = this.registry.get(subId);
    if (!record) return 0;

    // I-1: 沿 parentSessionId 链追溯验证深度，防止循环引用
    const visited = new Set<string>();
    let depth = 0;
    let current = sessionId;
    while (current) {
      if (visited.has(current)) {
        logger.warn({ sessionId, visited: [...visited] }, "I-1: Circular parentSessionId chain detected");
        break;
      }
      visited.add(current);
      const sid = this.sessionIndex.get(current);
      if (!sid) break;
      const rec = this.registry.get(sid);
      if (!rec?.parentSessionId) break;
      current = rec.parentSessionId;
      depth++;
    }
    return depth;
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

  // ─── I-2: 孤儿回收 ──────────────────────────────────────────

  /**
   * I-2: 回收孤儿子代理。
   * 查询 DB 中超过 30 分钟仍为 running 的记录，标记为 orphan_recovered。
   * 在 createAppContext() 初始化 SubagentManager 后立即调用。
   */
  reconcileOrphans(thresholdMs = 30 * 60 * 1000): number {
    try {
      const orphans = findOrphanSubagentRuns(thresholdMs);
      for (const orphan of orphans) {
        const id = orphan.id as string;
        updateSubagentRunStatus(id, "orphan_recovered", new Date().toISOString());
        logger.warn({ subagentId: id, task: (orphan.task as string)?.slice(0, 80) }, "I-2: Recovered orphan subagent run");
      }
      if (orphans.length > 0) {
        logger.info({ count: orphans.length }, "I-2: Orphan subagent runs recovered");
      }
      return orphans.length;
    } catch (err) {
      logger.warn({ error: err }, "I-2: reconcileOrphans failed (non-fatal)");
      return 0;
    }
  }

  /**
   * I-2/R4: 将某父 session 下所有 running 子代理在 DB 中标记为 killed。
   * 配合 E-3 abort 使用，防止 reconcileOrphans 误将已取消任务标记为孤儿。
   */
  markAllCancelled(parentSessionId: string): number {
    try {
      const count = markSubagentRunsCancelled(parentSessionId);
      if (count > 0) {
        logger.info({ parentSessionId, count }, "I-2/R4: Marked running subagent runs as cancelled in DB");
      }
      return count;
    } catch (err) {
      logger.warn({ parentSessionId, error: err }, "I-2/R4: markAllCancelled failed (non-fatal)");
      return 0;
    }
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
      // G-4: archiveHandle 已移除，不再需要清理
    }
    this.registry.clear();
    this.parentIndex.clear();
    this.sessionIndex.clear();
  }
}
