/**
 * KB-Parser Supervisor — 知识库 Docling Python 微服务子进程生命周期管理
 * （对齐知识库 Spec §T7 "可选 Docling Sidecar"）。
 *
 * 核心差异于 video-forge-supervisor：
 *   1. 懒启动：不在 app.listen() 时启动，首次调用 getClient().parse() 时才 spawn
 *   2. 动态端口：通过 net.createServer().listen(0) 获取可用端口后再启 uvicorn
 *   3. 独立 venv：services/kb-parser/.venv（不复用 video-forge 的 venv，避免 Docling
 *      的 torch/easyocr 体积污染 video-forge）
 *   4. 不需要 ffmpeg
 *
 * 与 router.ts 集成：通过 getClient() 暴露 DoclingClient 实例；client 内部的
 * endpoint getter 触发 ensureStarted()，实现"上传扫描件时才启动"的按需语义。
 *
 * 设计边界：
 *   - 达到最大重启次数（默认 3 次）后 isAvailable() 返回 false，router 会回落 TS 原错
 *   - stop() 在 api 进程 shutdown 时调用（若从未 start，则 no-op）
 *   - 启动失败（bootstrap 失败 / spawn 失败）不抛错到调用栈顶层 —— 仅标记 unavailable
 */

import { spawn, type ChildProcess } from "child_process";
import net from "node:net";
import pino from "pino";
import {
  ensureKbParserDeps,
  type KbParserDepsResult,
  createDoclingClient,
  type DoclingClient,
} from "@super-agent/core";

const logger = pino({ name: "kb-parser-supervisor" });

// ─── 常量 ──────────────────────────────────────────────────

/** 首次健康检查就绪等待上限 —— Docling 未加载模型时 /healthz 很快返回 */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 500;

/** 周期健康检查频率与连续失败阈值（对齐 video-forge） */
const HEALTH_INTERVAL_MS = 10_000;
const HEALTH_TIMEOUT_MS = 5_000;
const MAX_HEALTH_FAILURES = 3;

/** 崩溃重启上限与指数退避上限 */
const MAX_RESTARTS = 3;
const BACKOFF_CEILING_MS = 15_000;

// ─── Supervisor 主类 ───────────────────────────────────────

export class KbParserSupervisor {
  private process: ChildProcess | null = null;
  private deps: KbParserDepsResult | null = null;
  private port: number | null = null;
  private _ready = false;
  /** isRunning=true 表示"期望在运行"（由 start/stop 翻转），不等于进程存活 */
  private isRunning = false;
  private restartAttempts = 0;
  private consecutiveHealthFailures = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  /** ensureStarted 的进行中 promise（避免并发重复启动） */
  private startingPromise: Promise<void> | null = null;

  /** 由客户端复用的 DoclingClient 单例（懒创建） */
  private clientSingleton: DoclingClient | null = null;

  // ──────────────────────────────────────────────
  // 公开 API
  // ──────────────────────────────────────────────

  /**
   * 获取 DoclingClient（懒启动入口）。
   *
   * 首次调用时构造；调用 client.parse() 时才真正启动 Python 子进程。
   * 返回的 client 实例被长期复用，endpoint 通过闭包动态获取当前端口。
   */
  getClient(): DoclingClient {
    if (this.clientSingleton) return this.clientSingleton;

    this.clientSingleton = createDoclingClient({
      endpoint: async () => {
        await this.ensureStarted();
        if (!this._ready || this.port == null) {
          // 返回空字符串会被 createDoclingClient 转为 DOCLING_ENDPOINT_UNAVAILABLE
          return "";
        }
        return `http://127.0.0.1:${this.port}`;
      },
      // 达到最大重启或明确 stop 时，用 disabled hook 短路
      disabled: () => !this.isAvailableSync(),
    });

    return this.clientSingleton;
  }

  /**
   * 懒启动入口：确保 Python 子进程已启动且健康检查就绪。
   *
   * - 若已启动：立即返回
   * - 若正在启动：等待当前启动流程完成
   * - 若已标记不可用（超过最大重启）：直接返回（上游会看到不可用态）
   */
  async ensureStarted(): Promise<void> {
    if (this._ready && this.process) return;
    if (this.startingPromise) return this.startingPromise;
    if (!this.isAvailableSync() && this.restartAttempts >= MAX_RESTARTS) {
      return;
    }

    this.startingPromise = this._doStart().finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  /**
   * 停止子进程（api 进程 shutdown 时调用）。
   * 幂等：若从未启动，仅清理状态。
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    this._ready = false;
    this._stopHealthCheck();

    if (!this.process) return;

    logger.info("正在停止 kb-parser sidecar…");
    const proc = this.process;
    this.process = null;

    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null) {
          logger.warn("kb-parser 未及时退出，强制终止");
          proc.kill("SIGKILL");
        }
        resolve();
      }, 5_000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    logger.info("kb-parser 已停止");
  }

  /** sidecar 是否处于可用状态（异步，考虑当前启动进度） */
  async isAvailable(): Promise<boolean> {
    if (!this.isAvailableSync()) return false;
    // 尚未启动过 —— 视为"可用（按需启动）"，router 首次调用会触发 ensureStarted
    if (!this.process) return true;
    return this._ready;
  }

  /** 同步可用判定：未超最大重启且未 stop */
  private isAvailableSync(): boolean {
    return this.restartAttempts < MAX_RESTARTS;
  }

  /** 调试用：当前端口（未启动时返回 null） */
  get currentPort(): number | null {
    return this.port;
  }

  /** 调试用：子进程 PID */
  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  // ──────────────────────────────────────────────
  // 内部：启动流水线
  // ──────────────────────────────────────────────

  private async _doStart(): Promise<void> {
    try {
      this.isRunning = true;

      // Step 1: 环境自举
      if (!this.deps) {
        logger.info("正在检查 kb-parser 运行时依赖…");
        this.deps = await ensureKbParserDeps();
        logger.info(
          {
            python: this.deps.pythonVersion,
            venvDir: this.deps.venvDir,
          },
          "kb-parser 运行时依赖就绪",
        );
      }

      // Step 2: 分配动态端口（优先复用上次的端口；首次启动才探测）
      if (this.port == null) {
        this.port = await pickFreePort();
      }

      // Step 3: spawn uvicorn
      this._spawn(this.port);

      // Step 4: 轮询 /healthz 等待就绪
      await this._waitForReady();
      this._ready = true;
      logger.info(
        `kb-parser sidecar 已启动 (PID: ${this.process?.pid}, Port: ${this.port})`,
      );

      // Step 5: 周期健康检查
      this._startHealthCheck();
    } catch (err) {
      logger.error({ err }, "kb-parser 启动失败");
      this._ready = false;
      this.isRunning = false;
      // 不抛 —— 让 router 看到 isAvailable=false 自然降级
    }
  }

  private _spawn(port: number): void {
    if (!this.deps) {
      throw new Error("kb-parser deps 未初始化");
    }

    const child = spawn(
      this.deps.pythonPath,
      [
        "-m",
        "uvicorn",
        "main:app",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--no-access-log",
      ],
      {
        cwd: this.deps.kbParserDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: this.deps.spawnEnv,
      },
    );

    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().trim().split("\n")) {
        if (line) logger.info(`[kb-parser] ${line}`);
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().trim().split("\n")) {
        if (line) logger.warn(`[kb-parser] ${line}`);
      }
    });

    child.on("exit", (code, signal) => {
      logger.info({ code, signal }, "kb-parser sidecar 子进程退出");
      this.process = null;
      this._ready = false;

      // 主动 stop 不重启
      if (!this.isRunning) return;

      if (this.restartAttempts < MAX_RESTARTS) {
        this.restartAttempts++;
        const delay = Math.min(
          1_000 * Math.pow(2, this.restartAttempts - 1),
          BACKOFF_CEILING_MS,
        );
        logger.warn(
          {
            attempt: this.restartAttempts,
            maxRestarts: MAX_RESTARTS,
            delayMs: delay,
          },
          "准备重启 kb-parser sidecar",
        );
        setTimeout(() => {
          if (!this.isRunning) return;
          try {
            this._spawn(port);
            this._waitForReady()
              .then(() => {
                this._ready = true;
                logger.info("kb-parser sidecar 重启成功");
              })
              .catch((err) => {
                logger.error({ err }, "kb-parser 重启后健康检查失败");
              });
          } catch (err) {
            logger.error({ err }, "kb-parser 重启 spawn 失败");
          }
        }, delay);
      } else {
        logger.error(
          { maxRestarts: MAX_RESTARTS },
          "kb-parser 达到最大重启次数，标记为不可用（router 将回落到 TS 解析原错）",
        );
        this.isRunning = false;
      }
    });

    child.on("error", (err) => {
      logger.error({ err }, "kb-parser spawn 错误");
    });

    this.process = child;
  }

  private async _waitForReady(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const url = `http://127.0.0.1:${this.port}/healthz`;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(url, {
          signal: AbortSignal.timeout(3_000),
        });
        if (resp.ok) {
          return;
        }
      } catch {
        // 还没起，继续轮询
      }
      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
    }
    throw new Error(
      `kb-parser 就绪超时（${READY_TIMEOUT_MS}ms）—— 可能 Docling 依赖安装未完成`,
    );
  }

  private _startHealthCheck(): void {
    this._stopHealthCheck();
    this.consecutiveHealthFailures = 0;

    this.healthTimer = setInterval(async () => {
      if (!this.isRunning || !this.process || this.port == null) return;

      try {
        const resp = await fetch(
          `http://127.0.0.1:${this.port}/healthz`,
          { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) },
        );
        if (resp.ok) {
          this.consecutiveHealthFailures = 0;
          if (!this._ready) {
            this._ready = true;
            logger.info("kb-parser 恢复就绪状态");
          }
        } else {
          this._onHealthFailure();
        }
      } catch {
        this._onHealthFailure();
      }
    }, HEALTH_INTERVAL_MS);
  }

  private _onHealthFailure(): void {
    this.consecutiveHealthFailures++;
    if (this.consecutiveHealthFailures >= MAX_HEALTH_FAILURES) {
      logger.warn(
        { failures: this.consecutiveHealthFailures },
        "kb-parser 连续健康检查失败，标记为不可用",
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

// ─── 工具：动态端口探测 ──────────────────────────────────────

/**
 * 让内核分配一个可用端口（listen(0)），随后立即关闭返回端口号。
 *
 * 注意：存在 TOCTOU 风险（关闭到 uvicorn 绑定之间可能被其他进程抢走），
 * 但在单机私有 sidecar 场景下概率极低；启动失败会走 restart 重取端口。
 */
async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || addr === null) {
        srv.close();
        reject(new Error("pickFreePort: server.address() 返回异常"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}
