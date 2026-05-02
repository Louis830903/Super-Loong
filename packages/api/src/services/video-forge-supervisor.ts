/**
 * Video-Forge Supervisor — Python 视频微服务子进程生命周期管理。
 *
 * 设计原则（对齐 Spec v1.4 §4.1 "进程托管"）：
 * - 参考 gateway-launcher.ts 模式，在 app.listen() 成功后启动
 * - 启动前先调用 bootstrap.ensureVideoForgeDeps() 确保 Python/ffmpeg/venv 就绪
 * - 健康检查：每 10s GET /health，连续 3 次失败标记不可用
 * - 崩溃重启：指数退避，最多 3 次（Spec 要求）
 * - 进程退出清理：主进程 shutdown 时 kill 子进程
 * - 环境变量从 bootstrap.buildSpawnEnv() 获取（PATH 前置注入 ffmpeg + venv）
 */

import { spawn, type ChildProcess } from "child_process";
import path from "node:path";
import pino from "pino";
import pLimit from "p-limit";
import {
  ensureVideoForgeDeps,
  type VideoForgeDepsResult,
  updateVideoJob,
} from "@super-agent/core";

const logger = pino({ name: "video-forge-supervisor" });

export class VideoForgeSupervisor {
  private process: ChildProcess | null = null;
  private restartAttempts = 0;
  private maxRestarts = 3; // Spec: 最多 3 次
  private isRunning = false;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveHealthFailures = 0;
  private readonly maxHealthFailures = 3;
  private videoForgeDir: string;
  private deps: VideoForgeDepsResult | null = null;

  /** 微服务基础 URL */
  readonly baseUrl: string;

  /** 微服务是否就绪（健康检查通过） */
  private _ready = false;

  constructor() {
    // video-forge 目录：相对于 monorepo 根 (../../services/video-forge)
    this.videoForgeDir = path.resolve(
      process.cwd(),
      "../../services/video-forge",
    );
    this.baseUrl =
      process.env.VIDEO_FORGE_URL || "http://127.0.0.1:8199";
  }

  /**
   * 启动 video-forge 微服务
   * 在 app.listen() 成功后调用
   *
   * 步骤：
   * 1. 调用 bootstrap 确保 Python/ffmpeg/venv 就绪
   * 2. spawn uvicorn 子进程
   * 3. 轮询 /health 等待就绪
   * 4. 启动周期健康检查
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    try {
      this.isRunning = true;
      this.restartAttempts = 0;

      // Step 1: 环境自举
      logger.info("正在检查 video-forge 运行时依赖…");
      this.deps = await ensureVideoForgeDeps({
        videoForgeDir: this.videoForgeDir,
      });
      logger.info(
        {
          python: this.deps.pythonVersion,
          ffmpeg: this.deps.ffmpegPath,
        },
        "video-forge 运行时依赖就绪",
      );

      // Step 2: 启动子进程
      this._spawn();

      // Step 3: 等待就绪
      await this._waitForReady();
      this._ready = true;
      logger.info(
        `video-forge 微服务已启动 (PID: ${this.process?.pid}, URL: ${this.baseUrl})`,
      );

      // Step 4: 周期健康检查（每 10s）
      this._startHealthCheck();
    } catch (err) {
      logger.error({ err }, "video-forge 启动失败");
      this.isRunning = false;
      this._ready = false;
    }
  }

  /**
   * 停止 video-forge 子进程
   * 在 shutdown 时调用
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    this._ready = false;
    this._stopHealthCheck();

    if (this.process) {
      logger.info("正在停止 video-forge…");
      // 发送 SIGTERM，给 5 秒优雅关闭
      this.process.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            logger.warn("video-forge 未及时退出，强制终止");
            this.process.kill("SIGKILL");
          }
          resolve();
        }, 5000);

        if (this.process) {
          this.process.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
      this.process = null;
      logger.info("video-forge 已停止");
    }
  }

  /** 微服务是否正在运行且健康 */
  get ready(): boolean {
    return this._ready;
  }

  /** 微服务进程是否存活 */
  get running(): boolean {
    return (
      this.isRunning &&
      this.process !== null &&
      this.process.exitCode === null
    );
  }

  /** 获取子进程 PID */
  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  // ── 内部方法 ──────────────────────────────────────

  private _spawn(): void {
    if (!this.deps) {
      throw new Error("deps 未初始化，请先调用 start()");
    }

    const port = new URL(this.baseUrl).port || "8199";

    // 使用 venv 中的 python 通过 uvicorn 启动
    // buildSpawnEnv 已把 .venv/Scripts 前置到 PATH
    const child = spawn(
      this.deps.pythonPath,
      [
        "-m",
        "uvicorn",
        "main:app",
        "--host",
        "127.0.0.1",
        "--port",
        port,
        "--no-access-log",
      ],
      {
        cwd: this.videoForgeDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: this.deps.spawnEnv,
      },
    );

    // 转发 stdout/stderr 到主进程日志
    child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        logger.info(`[video-forge] ${line}`);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        // uvicorn 正常日志走 stderr，用 warn 级别
        logger.warn(`[video-forge] ${line}`);
      }
    });

    // 监听退出事件
    child.on("exit", (code, signal) => {
      logger.info(
        { code, signal },
        "video-forge 子进程退出",
      );
      this.process = null;
      this._ready = false;

      // 主动停止时不重启
      if (!this.isRunning) return;

      // 指数退避重启（最多 3 次）
      if (this.restartAttempts < this.maxRestarts) {
        this.restartAttempts++;
        const delay = Math.min(
          1000 * Math.pow(2, this.restartAttempts - 1),
          15000,
        );
        logger.warn(
          { attempt: this.restartAttempts, maxRestarts: this.maxRestarts, delayMs: delay },
          "准备重启 video-forge",
        );
        setTimeout(() => {
          if (this.isRunning) {
            try {
              this._spawn();
              // 重启后重新等待就绪
              this._waitForReady()
                .then(() => {
                  this._ready = true;
                  logger.info("video-forge 重启成功");
                })
                .catch((err) => {
                  logger.error({ err }, "video-forge 重启后健康检查失败");
                });
            } catch (err) {
              logger.error({ err }, "video-forge 重启 spawn 失败");
            }
          }
        }, delay);
      } else {
        logger.error(
          { maxRestarts: this.maxRestarts },
          "video-forge 达到最大重启次数，标记为不可用",
        );
        this.isRunning = false;
      }
    });

    child.on("error", (err) => {
      logger.error({ err }, "video-forge 进程 spawn 错误");
    });

    this.process = child;
  }

  /**
   * 等待微服务就绪 — 轮询 /health 端点
   */
  private async _waitForReady(
    maxWaitMs = 30000,
    intervalMs = 1000,
  ): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`${this.baseUrl}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          logger.info("video-forge 健康检查通过");
          return;
        }
      } catch {
        // 尚未就绪，继续等待
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    logger.warn(
      `video-forge 就绪检查超时 (${maxWaitMs}ms)，继续运行但标记为未就绪`,
    );
  }

  /**
   * 周期健康检查（每 10s），连续 3 次失败标记不可用
   */
  private _startHealthCheck(): void {
    this._stopHealthCheck();
    this.consecutiveHealthFailures = 0;

    this.healthTimer = setInterval(async () => {
      if (!this.isRunning || !this.process) return;

      try {
        const resp = await fetch(`${this.baseUrl}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          this.consecutiveHealthFailures = 0;
          if (!this._ready) {
            this._ready = true;
            logger.info("video-forge 恢复就绪状态");
          }
        } else {
          this._onHealthFailure();
        }
      } catch {
        this._onHealthFailure();
      }
    }, 10000);
  }

  private _onHealthFailure(): void {
    this.consecutiveHealthFailures++;
    if (this.consecutiveHealthFailures >= this.maxHealthFailures) {
      logger.warn(
        { failures: this.consecutiveHealthFailures },
        "video-forge 连续健康检查失败，标记为不可用",
      );
      this._ready = false;
    }
  }

  private _stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }
}

// ─── 并发守卫（Spec §4.5 三道闸 —— 全局槽位限制） ─────────

/**
 * 全局视频任务并发限制器。
 * 默认同时允许 2 个视频任务执行（Spec §4.5 global_max=2）。
 * 可通过环境变量 VIDEO_CONCURRENCY_MAX 覆盖。
 */
const concurrencyMax = Number(process.env.VIDEO_CONCURRENCY_MAX) || 2;
export const videoJobLimiter = pLimit(concurrencyMax);

/**
 * 将视频任务入队执行（带 queued 状态管理）。
 *
 * 逻辑：
 * - 槽位未满：立即执行，status: running
 * - 槽位已满：先置 status: queued，FIFO 排队，槽位释放后自动晋升为 running
 *
 * @param jobId 视频任务 ID（用于更新状态）
 * @param jobFn 实际执行函数（调 orchestrator 等）
 * @returns jobFn 的返回值
 */
export function enqueueVideoJob<T>(jobId: string, jobFn: () => Promise<T>): Promise<T> {
  // 判断当前槽位是否已满（activeCount 已等于或超过 concurrency）
  const isSlotFull = videoJobLimiter.activeCount >= concurrencyMax;
  if (isSlotFull) {
    // 槽位满——先置为 queued 状态
    updateVideoJob(jobId, { status: "queued" });
    logger.info({ jobId, activeCount: videoJobLimiter.activeCount, pendingCount: videoJobLimiter.pendingCount }, "视频任务入队排队 (queued)");
  }

  return videoJobLimiter(() => {
    // 槽位获得——置为 running
    updateVideoJob(jobId, { status: "running" });
    logger.info({ jobId, activeCount: videoJobLimiter.activeCount }, "视频任务开始执行 (running)");
    return jobFn();
  });
}
