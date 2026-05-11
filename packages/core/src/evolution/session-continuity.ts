/**
 * 会话连续性 — 跨会话任务状态持久化与恢复。
 *
 * 核心能力：
 *   - 会话结束时自动保存"未完成任务"列表
 *   - 下次会话开始时恢复上下文
 *   - 长期任务追踪：跨多天的任务自动推进
 *   - 与 MemoryManager 的 Recall 记忆层集成
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const logger = pino({ name: "session-continuity" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 任务状态 */
export type TaskState =
  | "pending"        // 待处理
  | "in_progress"    // 进行中
  | "blocked"        // 被阻塞（等待依赖）
  | "completed"      // 已完成
  | "cancelled"      // 已取消
  | "failed";        // 失败

/** 未完成任务 */
export interface PendingTask {
  /** 任务 ID */
  id: string;
  /** 任务标题 */
  title: string;
  /** 任务描述 */
  description: string;
  /** 任务状态 */
  state: TaskState;
  /** 关联的 Agent ID */
  agentId: string;
  /** 关联的会话 ID 列表 */
  sessionIds: string[];
  /** 已完成的子目标名称列表 */
  completedSubGoals: string[];
  /** 剩余子目标名称列表 */
  remainingSubGoals: string[];
  /** 总进度百分比 (0-100) */
  progress: number;
  /** 创建时间 */
  createdAt: Date;
  /** 最后更新时间 */
  updatedAt: Date;
  /** 关联的工作流 ID（如有） */
  workflowId?: string;
  /** 关联的意图分解 ID（如有） */
  decompositionId?: string;
  /** 上下文摘要（供恢复使用） */
  contextSummary: string;
  /** 关键产出物路径 */
  outputs: string[];
  /** 标签 */
  tags: string[];
  /** 优先级 (1-5) */
  priority: number;
}

/** 会话手交包（保存/恢复的完整状态） */
export interface SessionHandoff {
  /** 手交包 ID */
  id: string;
  /** 手交时间 */
  handoffAt: Date;
  /** 来源会话 ID */
  sourceSessionId: string;
  /** 关联 Agent ID */
  agentId: string;
  /** 未完成任务列表 */
  pendingTasks: PendingTask[];
  /** 用户偏好快照 */
  userPreferences: Record<string, unknown>;
  /** 最近操作摘要 */
  recentActions: string[];
  /** 上下文摘要 */
  contextSummary: string;
  /** 恢复提示词模板 */
  resumePrompt: string;
}

/** 连续性配置 */
export interface ContinuityConfig {
  /** 存储目录 */
  storageDir: string;
  /** 最大未完成任务数（默认 20） */
  maxPendingTasks: number;
  /** 最大已完成任务数（默认 200）—— Task 8: Map 容量截断 */
  maxCompletedTasks: number;
  /** 已完成任务保留天数（默认 30） */
  completedRetentionDays: number;
  /** 是否自动恢复（默认 true） */
  autoResume: boolean;
}

const DEFAULT_CONFIG: ContinuityConfig = {
  storageDir: join(process.cwd(), "data", "continuity"),
  maxPendingTasks: 20,
  maxCompletedTasks: 200,
  completedRetentionDays: 30,
  autoResume: true,
};

// ═══════════════════════════════════════════════════════════════
// 会话连续性管理器
// ═══════════════════════════════════════════════════════════════

export class SessionContinuityManager {
  private config: ContinuityConfig;
  /** 未完成任务列表 */
  private pendingTasks: Map<string, PendingTask> = new Map();
  /** 已完成任务（近期） */
  private completedTasks: Map<string, PendingTask> = new Map();
  /** 所有手交包（内存缓存） */
  private handoffs: SessionHandoff[] = [];

  constructor(config?: Partial<ContinuityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureStorage();
    this.loadState();
  }

  /**
   * 注册一个未完成任务。
   */
  registerTask(params: {
    title: string;
    description: string;
    agentId: string;
    sessionId: string;
    subGoals: string[];
    workflowId?: string;
    decompositionId?: string;
    contextSummary?: string;
    tags?: string[];
    priority?: number;
  }): PendingTask {
    const now = new Date();
    const task: PendingTask = {
      id: `task_${uuid().slice(0, 8)}`,
      title: params.title,
      description: params.description,
      state: "in_progress",
      agentId: params.agentId,
      sessionIds: [params.sessionId],
      completedSubGoals: [],
      remainingSubGoals: params.subGoals,
      progress: 0,
      createdAt: now,
      updatedAt: now,
      workflowId: params.workflowId,
      decompositionId: params.decompositionId,
      contextSummary: params.contextSummary ?? params.description.slice(0, 200),
      outputs: [],
      tags: params.tags ?? [],
      priority: params.priority ?? 3,
    };

    this.pendingTasks.set(task.id, task);
    this.prunePendingTasks();

    this.saveState();
    logger.info({ taskId: task.id, title: task.title }, "Task registered");
    return task;
  }

  /**
   * 更新任务进度。
   */
  updateTaskProgress(
    taskId: string,
    completedSubGoal: string,
    outputPath?: string,
  ): PendingTask | null {
    const task = this.pendingTasks.get(taskId);
    if (!task) {
      // 检查已完成任务
      return this.completedTasks.get(taskId) ?? null;
    }

    // 从剩余移动到已完成
    const remainingIdx = task.remainingSubGoals.indexOf(completedSubGoal);
    if (remainingIdx >= 0) {
      task.remainingSubGoals.splice(remainingIdx, 1);
      task.completedSubGoals.push(completedSubGoal);
    }

    if (outputPath) {
      task.outputs.push(outputPath);
    }

    // 更新进度
    const total = task.completedSubGoals.length + task.remainingSubGoals.length;
    task.progress = total > 0 ? Math.round((task.completedSubGoals.length / total) * 100) : task.progress;

    task.updatedAt = new Date();

    // 检查是否完成
    if (task.remainingSubGoals.length === 0) {
      task.state = "completed";
      task.progress = 100;
    }

    this.saveState();
    return task;
  }

  /**
   * 标记任务完成。
   */
  completeTask(taskId: string, summary?: string): boolean {
    const task = this.pendingTasks.get(taskId);
    if (!task) return false;

    task.state = "completed";
    task.progress = 100;
    task.updatedAt = new Date();
    if (summary) {
      task.contextSummary = summary;
    }

    this.pendingTasks.delete(taskId);
    this.completedTasks.set(taskId, task);
    this.pruneCompletedTasks();

    this.saveState();
    logger.info({ taskId, title: task.title }, "Task completed");
    return true;
  }

  /**
   * 取消任务。
   */
  cancelTask(taskId: string, reason?: string): boolean {
    const task = this.pendingTasks.get(taskId);
    if (!task) return false;

    task.state = "cancelled";
    task.contextSummary = reason ?? "任务已取消";
    task.updatedAt = new Date();

    this.pendingTasks.delete(taskId);
    this.completedTasks.set(taskId, task);
    this.pruneCompletedTasks();

    this.saveState();
    logger.info({ taskId, reason }, "Task cancelled");
    return true;
  }

  /**
   * 创建会话手交包。
   */
  createHandoff(
    sessionId: string,
    agentId: string,
    userPreferences?: Record<string, unknown>,
    recentActions?: string[],
  ): SessionHandoff {
    const pendingList = Array.from(this.pendingTasks.values()).filter(
      t => t.agentId === agentId || t.sessionIds.includes(sessionId),
    );

    const summary = this.buildResumePrompt(pendingList);

    const handoff: SessionHandoff = {
      id: `handoff_${uuid().slice(0, 8)}`,
      handoffAt: new Date(),
      sourceSessionId: sessionId,
      agentId,
      pendingTasks: pendingList,
      userPreferences: userPreferences ?? {},
      recentActions: recentActions ?? [],
      contextSummary: summary.slice(0, 500),
      resumePrompt: summary,
    };

    this.handoffs.push(handoff);
    this.saveHandoff(handoff);

    logger.info(
      { handoffId: handoff.id, pendingCount: pendingList.length },
      "Session handoff created",
    );
    return handoff;
  }

  /**
   * 生成恢复提示词。
   */
  getResumePrompt(agentId: string): string {
    const pendingList = Array.from(this.pendingTasks.values()).filter(
      t => t.agentId === agentId,
    );

    if (pendingList.length === 0) {
      // 检查最近的手交包
      const lastHandoff = this.handoffs
        .filter(h => h.agentId === agentId)
        .sort((a, b) => b.handoffAt.getTime() - a.handoffAt.getTime())[0];

      if (lastHandoff) {
        return lastHandoff.resumePrompt;
      }
      return "";
    }

    return this.buildResumePrompt(pendingList);
  }

  /**
   * 获取所有未完成任务。
   */
  getPendingTasks(agentId?: string): PendingTask[] {
    let tasks = Array.from(this.pendingTasks.values());
    if (agentId) {
      tasks = tasks.filter(t => t.agentId === agentId);
    }
    return tasks.sort((a, b) => b.priority - a.priority || b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  /**
   * 获取最近的已完成任务。
   */
  getRecentCompletedTasks(agentId?: string, limit = 10): PendingTask[] {
    let tasks = Array.from(this.completedTasks.values());
    if (agentId) {
      tasks = tasks.filter(t => t.agentId === agentId);
    }
    return tasks
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }

  /**
   * 获取最近的手交包。
   */
  getLastHandoff(agentId: string): SessionHandoff | undefined {
    return this.handoffs
      .filter(h => h.agentId === agentId)
      .sort((a, b) => b.handoffAt.getTime() - a.handoffAt.getTime())[0];
  }

  // ─── 清理 ──────────────────────────────────────────────

  /**
   * 清理过期的已完成任务。
   */
  cleanupCompleted(): number {
    const cutoff = Date.now() - this.config.completedRetentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const [id, task] of this.completedTasks) {
      if (task.updatedAt.getTime() < cutoff) {
        this.completedTasks.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      logger.info({ removed }, "Cleaned up completed tasks");
    }

    return removed;
  }

  // ─── 持久化 ────────────────────────────────────────────

  /**
   * 确保存储目录存在。
   */
  private ensureStorage(): void {
    if (!existsSync(this.config.storageDir)) {
      mkdirSync(this.config.storageDir, { recursive: true });
    }
  }

  /**
   * 从磁盘加载状态。
   */
  private loadState(): void {
    try {
      // 加载任务状态
      const tasksPath = join(this.config.storageDir, "pending-tasks.json");
      if (existsSync(tasksPath)) {
        const data = JSON.parse(readFileSync(tasksPath, "utf-8"));
        if (data.pending) {
          for (const t of data.pending) {
            t.createdAt = new Date(t.createdAt);
            t.updatedAt = new Date(t.updatedAt);
            this.pendingTasks.set(t.id, t);
          }
        }
        if (data.completed) {
          for (const t of data.completed) {
            t.createdAt = new Date(t.createdAt);
            t.updatedAt = new Date(t.updatedAt);
            this.completedTasks.set(t.id, t);
          }
        }
        logger.info(
          { pending: this.pendingTasks.size, completed: this.completedTasks.size },
          "Session continuity state loaded",
        );
      }
    } catch (err) {
      logger.warn({ err }, "Failed to load continuity state");
    }
  }

  /**
   * 保存状态到磁盘。
   */
  private saveState(): void {
    try {
      const data = {
        pending: Array.from(this.pendingTasks.values()).map(t => ({
          ...t,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        })),
        completed: Array.from(this.completedTasks.values()).map(t => ({
          ...t,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        })),
        savedAt: new Date().toISOString(),
      };

      writeFileSync(
        join(this.config.storageDir, "pending-tasks.json"),
        JSON.stringify(data, null, 2),
        "utf-8",
      );
    } catch (err) {
      logger.warn({ err }, "Failed to save continuity state");
    }
  }

  /**
   * 保存手交包。
   */
  private saveHandoff(handoff: SessionHandoff): void {
    try {
      writeFileSync(
        join(this.config.storageDir, `handoff_${handoff.id}.json`),
        JSON.stringify(handoff, null, 2),
        "utf-8",
      );
    } catch (err) {
      logger.warn({ err }, "Failed to save handoff");
    }
  }

  // ─── 辅助 ──────────────────────────────────────────────

  /**
   * 构建恢复提示词。
   */
  private buildResumePrompt(tasks: PendingTask[]): string {
    if (tasks.length === 0) return "";

    const lines: string[] = [
      "## 会话恢复 — 未完成任务",
      "",
      `上次会话有 ${tasks.length} 个未完成的任务：`,
      "",
    ];

    for (const task of tasks) {
      const statusEmoji = task.state === "in_progress" ? "🔄" :
        task.state === "blocked" ? "⏸️" : "📋";

      lines.push(`### ${statusEmoji} ${task.title}`);
      lines.push(`- **进度**: ${task.progress}% (${task.completedSubGoals.length}/${task.completedSubGoals.length + task.remainingSubGoals.length} 子目标)`);
      lines.push(`- **上下文**: ${task.contextSummary}`);

      if (task.completedSubGoals.length > 0) {
        lines.push(`- **已完成**: ${task.completedSubGoals.map(s => `"${s}"`).join(", ")}`);
      }
      if (task.remainingSubGoals.length > 0) {
        lines.push(`- **剩余**: ${task.remainingSubGoals.map(s => `"${s}"`).join(", ")}`);
      }
      if (task.outputs.length > 0) {
        lines.push(`- **产出物**: ${task.outputs.join(", ")}`);
      }
      lines.push("");
    }

    lines.push("请从这里继续执行未完成的任务。");
    return lines.join("\n");
  }

  /**
   * 获取最旧的任务。
   */
  private getOldestTask(): PendingTask | undefined {
    let oldest: PendingTask | undefined;
    for (const task of this.pendingTasks.values()) {
      if (!oldest || task.createdAt < oldest.createdAt) {
        oldest = task;
      }
    }
    return oldest;
  }

  /**
   * Task 8: 截断 pendingTasks Map — 超过 maxPendingTasks 时淘汰最旧条目
   */
  private prunePendingTasks(): void {
    if (this.pendingTasks.size <= this.config.maxPendingTasks) return;
    const sorted = Array.from(this.pendingTasks.entries())
      .sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime());
    this.pendingTasks = new Map(sorted.slice(-this.config.maxPendingTasks));
  }

  /**
   * Task 8: 截断 completedTasks Map — 时间窗口淘汰 + 容量截断
   */
  private pruneCompletedTasks(): void {
    const now = Date.now();
    const retentionMs = this.config.completedRetentionDays * 24 * 60 * 60 * 1000;
    // 时间窗口淘汰
    for (const [id, t] of this.completedTasks) {
      if (now - t.updatedAt.getTime() > retentionMs) {
        this.completedTasks.delete(id);
      }
    }
    // 容量截断 — 保留最近更新的
    if (this.completedTasks.size > this.config.maxCompletedTasks) {
      const sorted = Array.from(this.completedTasks.entries())
        .sort((a, b) => b[1].updatedAt.getTime() - a[1].updatedAt.getTime());
      this.completedTasks = new Map(sorted.slice(0, this.config.maxCompletedTasks));
    }
  }

  /**
   * 获取统计信息。
   */
  getStats(): {
    pendingCount: number;
    completedCount: number;
    totalOutputs: number;
    averageProgress: number;
  } {
    const pending = Array.from(this.pendingTasks.values());
    const totalOutputs = pending.reduce((sum, t) => sum + t.outputs.length, 0);

    return {
      pendingCount: pending.length,
      completedCount: this.completedTasks.size,
      totalOutputs,
      averageProgress: pending.length > 0
        ? Math.round(pending.reduce((sum, t) => sum + t.progress, 0) / pending.length)
        : 0,
    };
  }
}
