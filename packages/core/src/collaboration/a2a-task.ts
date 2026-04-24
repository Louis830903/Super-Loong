/**
 * A2A Task 状态机 + TaskStore
 *
 * 管理 A2A Task 的生命周期，校验状态转换合法性，
 * 支持内存 Map + SQLite 双写持久化。
 *
 * @see a2a-types.ts — TaskState / VALID_TRANSITIONS / A2ATask
 * @see a2a-spec.md §4 Task 状态机
 */

import { randomUUID } from "node:crypto";
import pino from "pino";
import {
  TaskState,
  isTerminalState,
  VALID_TRANSITIONS,
  type A2ATask,
  type A2AMessage,
  type Artifact,
  type TaskStatus,
  type TaskFilter,
  type Part,
} from "./a2a-types.js";
import { getDatabase } from "../persistence/sqlite.js";

// ─── 日志（P2-1：统一使用 pino） ──────────────────────────────

const logger = pino({ name: "TaskStore" });

const log = {
  info: (msg: string, data?: unknown) => data ? logger.info(data, msg) : logger.info(msg),
  warn: (msg: string, data?: unknown) => data ? logger.warn(data, msg) : logger.warn(msg),
  error: (msg: string, data?: unknown) => data ? logger.error(data, msg) : logger.error(msg),
};

// ─── 错误类型 ───────────────────────────────────────────────

/** 非法状态转换错误 */
export class InvalidTransitionError extends Error {
  constructor(taskId: string, from: TaskState, to: TaskState) {
    super(`Invalid state transition for task ${taskId}: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** Task 不存在错误 */
export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

// ─── TaskStore ──────────────────────────────────────────────

/**
 * TaskStore — A2A Task 状态机管理器。
 *
 * 内存 Map 做主存储（快速读写），SQLite 做持久化备份（重启恢复）。
 * 所有状态转换严格校验合法性（终止态不可转换）。
 */
export class TaskStore {
  /** 内存主存储 */
  private tasks = new Map<string, A2ATask>();
  /** 是否启用 SQLite 持久化 */
  private persistEnabled: boolean;

  constructor(opts?: { persist?: boolean }) {
    this.persistEnabled = opts?.persist ?? false;
  }

  // ─── 创建 Task ────────────────────────────────────────────

  /**
   * 创建新 Task（初态 submitted）。
   * @param contextId 会话上下文 ID（映射到 Session.id）
   * @param message 初始消息（可选）
   */
  createTask(contextId: string, message?: A2AMessage): A2ATask {
    const now = new Date().toISOString();
    const task: A2ATask = {
      id: randomUUID(),
      contextId,
      status: {
        state: TaskState.SUBMITTED,
        message,
        timestamp: now,
      },
      artifacts: [],
      history: message ? [message] : [],
      metadata: {},
    };
    this.tasks.set(task.id, task);
    this.persistToDb(task);
    log.info(`Task created: ${task.id} (contextId=${contextId})`);
    return task;
  }

  // ─── 状态转换 ─────────────────────────────────────────────

  /**
   * 转换 Task 状态。严格校验合法性：
   * - 终止态不可转换
   * - 只允许 VALID_TRANSITIONS 矩阵中定义的转换
   *
   * @throws InvalidTransitionError 非法转换
   * @throws TaskNotFoundError Task 不存在
   */
  transition(taskId: string, newState: TaskState, message?: A2AMessage): A2ATask {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    const currentState = task.status.state;

    // 终止态不可转换
    if (isTerminalState(currentState)) {
      throw new InvalidTransitionError(taskId, currentState, newState);
    }

    // 校验合法转换
    const allowedStates = VALID_TRANSITIONS.get(currentState);
    if (!allowedStates || !allowedStates.has(newState)) {
      throw new InvalidTransitionError(taskId, currentState, newState);
    }

    // 执行转换
    const now = new Date().toISOString();
    task.status = {
      state: newState,
      message,
      timestamp: now,
    };

    // 追加消息到历史
    if (message) {
      task.history.push(message);
    }

    this.persistToDb(task);
    log.info(`Task ${taskId}: ${currentState} → ${newState}`);
    return task;
  }

  // ─── 查询 ────────────────────────────────────────────────

  /** 获取单个 Task */
  getTask(taskId: string): A2ATask | null {
    return this.tasks.get(taskId) ?? this.loadFromDb(taskId);
  }

  /** 列表查询 Task（支持 contextId / state / 分页过滤） */
  listTasks(filter?: TaskFilter): A2ATask[] {
    const results: A2ATask[] = [];
    for (const task of this.tasks.values()) {
      if (filter?.contextId && task.contextId !== filter.contextId) continue;
      if (filter?.state && task.status.state !== filter.state) continue;
      results.push(task);
    }

    // 分页
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  // ─── Artifact 操作 ────────────────────────────────────────

  /**
   * 添加完整 Artifact 到 Task。
   * @throws TaskNotFoundError Task 不存在
   */
  addArtifact(taskId: string, artifact: Artifact): A2ATask {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    task.artifacts.push(artifact);
    this.persistToDb(task);
    return task;
  }

  /**
   * 追加 Artifact 分块（流式场景）。
   * 若 artifactId 已存在则追加 parts，否则创建新 Artifact。
   */
  appendArtifactChunk(
    taskId: string,
    artifactId: string,
    parts: Part[],
    opts?: { append?: boolean; lastChunk?: boolean; name?: string },
  ): A2ATask {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    const existing = task.artifacts.find((a) => a.artifactId === artifactId);
    if (existing && opts?.append) {
      // 追加到现有 Artifact
      existing.parts.push(...parts);
    } else if (existing) {
      // 替换 parts
      existing.parts = parts;
    } else {
      // 新建 Artifact
      task.artifacts.push({
        artifactId,
        name: opts?.name || artifactId,
        parts,
      });
    }

    this.persistToDb(task);
    return task;
  }

  // ─── SQLite 持久化 ───────────────────────────────────────

  /** 将 Task 写入 SQLite（双写） */
  private persistToDb(task: A2ATask): void {
    if (!this.persistEnabled) return;
    try {
      const db = getDatabase();
      const now = new Date().toISOString();
      db.run(
        `INSERT OR REPLACE INTO a2a_tasks (id, contextId, state, payload, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, COALESCE((SELECT createdAt FROM a2a_tasks WHERE id = ?), ?), ?)`,
        [task.id, task.contextId, task.status.state, JSON.stringify(task), task.id, now, now],
      );
    } catch (e: any) {
      log.error(`Failed to persist task ${task.id}: ${e.message}`);
    }
  }

  /** 从 SQLite 加载单个 Task（缓存未命中时的回退） */
  private loadFromDb(taskId: string): A2ATask | null {
    if (!this.persistEnabled) return null;
    try {
      const db = getDatabase();
      const rows = db.exec(
        "SELECT payload FROM a2a_tasks WHERE id = ?",
        [taskId],
      );
      if (!rows.length || !rows[0].values.length) return null;
      const task: A2ATask = JSON.parse(rows[0].values[0][0] as string);
      // 加载后放入内存缓存
      this.tasks.set(task.id, task);
      return task;
    } catch {
      return null;
    }
  }
}
