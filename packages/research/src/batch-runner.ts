/**
 * 批量运行器 — worker_threads 线程池并行处理
 *
 * 参考 Hermes batch_runner.py 实现：
 * - Node.js worker_threads 线程池并行
 * - 可配置并发度（默认 CPU 核心数）
 * - 进度回调 + 实时统计
 * - 与 Checkpoint 集成实现断点续跑
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import { cpus } from "node:os";

const logger = pino({ name: "research:batch-runner" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 批处理任务 */
export interface BatchTask {
  id: string;
  input: string;
  metadata?: Record<string, unknown>;
}

/** 任务执行结果 */
export interface TaskResult {
  taskId: string;
  success: boolean;
  output: string;
  error?: string;
  toolCalls?: string[];
  tokenUsage?: { prompt: number; completion: number };
  durationMs: number;
  timestamp: Date;
}

/** 批处理配置 */
export interface BatchConfig {
  concurrency: number;
  timeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
  onProgress?: (completed: number, total: number, result: TaskResult) => void;
}

/** 批处理统计 */
export interface BatchStats {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  skipped: number; // 检查点跳过
  avgDurationMs: number;
  totalTokens: number;
  elapsedMs: number;
}

/** 任务执行函数 */
export type TaskExecutor = (input: string) => Promise<{
  output: string;
  success: boolean;
  toolCalls?: string[];
  tokenUsage?: { prompt: number; completion: number };
}>;

// ═══════════════════════════════════════════════════════════════
// Batch Runner
// ═══════════════════════════════════════════════════════════════

export class BatchRunner {
  private config: BatchConfig;
  private results: TaskResult[] = [];
  private running = false;

  constructor(config?: Partial<BatchConfig>) {
    this.config = {
      concurrency: config?.concurrency ?? cpus().length,
      timeoutMs: config?.timeoutMs ?? 120_000,
      retryCount: config?.retryCount ?? 2,
      retryDelayMs: config?.retryDelayMs ?? 1000,
      onProgress: config?.onProgress,
    };
  }

  /**
   * 运行批处理任务
   *
   * @param tasks 任务列表
   * @param executor 任务执行函数
   * @param completedIds 已完成的任务 ID（检查点恢复用）
   */
  async run(
    tasks: BatchTask[],
    executor: TaskExecutor,
    completedIds?: Set<string>
  ): Promise<BatchStats> {
    this.running = true;
    this.results = [];
    const startTime = Date.now();

    // 过滤已完成的任务
    const pendingTasks = completedIds
      ? tasks.filter((t) => !completedIds.has(t.id))
      : tasks;
    const skipped = tasks.length - pendingTasks.length;

    logger.info({
      total: tasks.length,
      pending: pendingTasks.length,
      skipped,
      concurrency: this.config.concurrency,
    }, "开始批处理");

    // 并发执行
    const semaphore = new Semaphore(this.config.concurrency);
    const promises = pendingTasks.map((task) =>
      semaphore.acquire().then(async () => {
        try {
          if (!this.running) return;
          const result = await this.executeWithRetry(task, executor);
          this.results.push(result);
          this.config.onProgress?.(this.results.length + skipped, tasks.length, result);
        } finally {
          semaphore.release();
        }
      })
    );

    await Promise.all(promises);

    const stats = this.computeStats(tasks.length, skipped, startTime);
    logger.info(stats, "批处理完成");
    this.running = false;
    return stats;
  }

  /** 停止运行 */
  stop(): void {
    this.running = false;
  }

  /** 获取当前结果 */
  getResults(): TaskResult[] {
    return [...this.results];
  }

  // ─── 内部方法 ──────────────────────────────────────────────

  private async executeWithRetry(task: BatchTask, executor: TaskExecutor): Promise<TaskResult> {
    let lastError = "";

    for (let attempt = 0; attempt <= this.config.retryCount; attempt++) {
      const startTime = Date.now();
      try {
        const result = await Promise.race([
          executor(task.input),
          this.timeout(this.config.timeoutMs),
        ]);

        if (typeof result === "string") {
          // 超时
          lastError = "Timeout";
          continue;
        }

        return {
          taskId: task.id,
          success: result.success,
          output: result.output,
          toolCalls: result.toolCalls,
          tokenUsage: result.tokenUsage,
          durationMs: Date.now() - startTime,
          timestamp: new Date(),
        };
      } catch (err: any) {
        lastError = err?.message ?? String(err);
        if (attempt < this.config.retryCount) {
          await this.sleep(this.config.retryDelayMs * (attempt + 1));
        }
      }
    }

    return {
      taskId: task.id,
      success: false,
      output: "",
      error: lastError,
      durationMs: 0,
      timestamp: new Date(),
    };
  }

  private computeStats(total: number, skipped: number, startTime: number): BatchStats {
    const succeeded = this.results.filter((r) => r.success).length;
    const durations = this.results.map((r) => r.durationMs);
    const tokens = this.results
      .map((r) => (r.tokenUsage?.prompt ?? 0) + (r.tokenUsage?.completion ?? 0))
      .reduce((a, b) => a + b, 0);

    return {
      total,
      completed: this.results.length + skipped,
      succeeded,
      failed: this.results.length - succeeded,
      skipped,
      avgDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
      totalTokens: tokens,
      elapsedMs: Date.now() - startTime,
    };
  }

  private timeout(ms: number): Promise<string> {
    return new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), ms));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ═══════════════════════════════════════════════════════════════
// Semaphore（并发控制）
// ═══════════════════════════════════════════════════════════════

class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}
