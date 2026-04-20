/**
 * 检查点管理 — 断点续跑支持
 *
 * 参考 Hermes batch_runner.py 的检查点机制：
 * - JSON 文件记录已完成任务
 * - 中断后自动跳过已完成项
 * - 支持增量追加新任务
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import pino from "pino";

const logger = pino({ name: "research:checkpoint" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 检查点数据 */
export interface CheckpointData {
  runId: string;
  startedAt: string;
  updatedAt: string;
  completedTaskIds: string[];
  failedTaskIds: string[];
  stats: {
    total: number;
    completed: number;
    failed: number;
  };
  metadata?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// Checkpoint Manager
// ═══════════════════════════════════════════════════════════════

export class CheckpointManager {
  private filePath: string;
  private data: CheckpointData;

  constructor(filePath: string, runId?: string) {
    this.filePath = filePath;

    // 尝试加载已有检查点
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, "utf-8");
        this.data = JSON.parse(raw);
        logger.info({ runId: this.data.runId, completed: this.data.completedTaskIds.length }, "加载检查点");
      } catch {
        this.data = this.createFresh(runId ?? `run_${Date.now()}`);
      }
    } else {
      this.data = this.createFresh(runId ?? `run_${Date.now()}`);
    }
  }

  /** 获取已完成的任务 ID 集合 */
  getCompletedIds(): Set<string> {
    return new Set(this.data.completedTaskIds);
  }

  /** 标记任务完成 */
  markCompleted(taskId: string): void {
    if (!this.data.completedTaskIds.includes(taskId)) {
      this.data.completedTaskIds.push(taskId);
      this.data.stats.completed++;
    }
    this.save();
  }

  /** 标记任务失败 */
  markFailed(taskId: string): void {
    if (!this.data.failedTaskIds.includes(taskId)) {
      this.data.failedTaskIds.push(taskId);
      this.data.stats.failed++;
    }
    this.save();
  }

  /** 更新总任务数 */
  setTotal(total: number): void {
    this.data.stats.total = total;
    this.save();
  }

  /** 设置元数据 */
  setMetadata(metadata: Record<string, unknown>): void {
    this.data.metadata = metadata;
    this.save();
  }

  /** 检查任务是否已完成 */
  isCompleted(taskId: string): boolean {
    return this.data.completedTaskIds.includes(taskId);
  }

  /** 获取检查点数据 */
  getData(): CheckpointData {
    return { ...this.data };
  }

  /** 重置检查点 */
  reset(): void {
    this.data = this.createFresh(this.data.runId);
    this.save();
  }

  // ─── 内部方法 ──────────────────────────────────────────────

  private save(): void {
    try {
      this.data.updatedAt = new Date().toISOString();
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (err) {
      logger.error({ err }, "保存检查点失败");
    }
  }

  private createFresh(runId: string): CheckpointData {
    return {
      runId,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedTaskIds: [],
      failedTaskIds: [],
      stats: { total: 0, completed: 0, failed: 0 },
    };
  }
}
