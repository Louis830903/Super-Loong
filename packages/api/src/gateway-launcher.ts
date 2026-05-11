/**
 * Gateway Launcher — 独立模块，在 app.listen() 成功后启动 IM Gateway 子进程。
 *
 * 设计原则：
 * - 不侵入 context.ts 的 11 模块初始化序列
 * - 在 app.listen() 成功后才触发启动，确保 /api/chat 已就绪
 * - Gateway 崩溃时指数退避重启（最多 5 次）
 * - API 关闭时优雅终止 Gateway 子进程
 */

import { spawn, exec, type ChildProcess } from "child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import path from "node:path";
import pino from "pino";
import { ensureGatewayDeps, type GatewayDepsResult } from "@super-agent/core";

const execAsync = promisify(exec);
const logger = pino({ name: "gateway-launcher" });

export class GatewayLauncher {
  private process: ChildProcess | null = null;
  private restartAttempts = 0;
  private maxRestarts = 5;
  private isRunning = false;
  private gatewayDir: string;
  /** 自举结果（首次启动时自动完成 Python venv + 依赖安装），null 表示跳过自举（降级到系统 python） */
  private deps: GatewayDepsResult | null = null;

  constructor() {
    // Gateway 目录：相对于 monorepo 根 (../../services/im-gateway)
    this.gatewayDir = path.resolve(
      process.cwd(),
      "../../services/im-gateway"
    );
  }

  /**
   * 启动 Gateway 子进程
   * 在 app.listen() 成功后调用
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    // 启动前先清理可能残留的旧进程（防孤儿进程端口占用）
    await this._freePort();

    try {
      this.isRunning = true;
      this.restartAttempts = 0;

      // 自举 IM Gateway 的 Python venv + 依赖（首次自动安装，幂等）
      // 失败不阻塞：降级到直接用系统 python，Gateway 可能因缺依赖而崩溃但不会影响 API 主流程
      try {
        this.deps = await ensureGatewayDeps({ gatewayDir: this.gatewayDir });
        logger.info(
          `[GatewayLauncher] venv 就绪 (python: ${this.deps.pythonVersion}, dir: ${this.deps.venvDir})`,
        );
      } catch (err) {
        logger.warn("[GatewayLauncher] 自举失败，回退到系统 python: %s", (err as Error).message);
        this.deps = null;
      }

      this._spawn();
      await this._waitForReady();
      logger.info(`[GatewayLauncher] IM Gateway started and ready (dir: ${this.gatewayDir})`);
    } catch (err) {
      logger.error("[GatewayLauncher] Failed to start IM Gateway: %s", err);
      this.isRunning = false;
    }
  }

  /**
   * 停止 Gateway 子进程
   * 在 shutdown 时调用
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.process) {
      logger.info("[GatewayLauncher] Stopping IM Gateway...");
      // 发送 SIGTERM，给 5 秒优雅关闭
      this.process.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            logger.info("[GatewayLauncher] Force killing IM Gateway");
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
      logger.info("[GatewayLauncher] IM Gateway stopped");
    }
  }

  /** Gateway 是否正在运行 */
  get running(): boolean {
    return this.isRunning && this.process !== null && this.process.exitCode === null;
  }

  /** 获取 Gateway PID */
  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  /**
   * 释放 Gateway 端口：检测是否被旧孤儿进程占用，自动清理
   * 防止上次异常退出后孤儿进程持续占用端口导致新 Gateway 无法启动
   */
  private async _freePort(): Promise<void> {
    const gatewayUrl = process.env.IM_GATEWAY_URL || "http://localhost:8642";
    const port = parseInt(new URL(gatewayUrl).port || "8642", 10);

    // 检查端口是否空闲（尝试监听，成功则立即关闭）
    const isPortFree = (): Promise<boolean> =>
      new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => {
          server.close(() => resolve(true));
        });
        server.listen(port, "0.0.0.0");
      });

    if (await isPortFree()) return;

    logger.warn(`[GatewayLauncher] 端口 ${port} 被占用，尝试清理旧进程...`);

    try {
      if (process.platform === "win32") {
        // Windows: 用 netstat + taskkill 清理占用端口的进程
        const { stdout: netstatOut } = await execAsync(
          `netstat -ano | findstr ":${port}"`,
          { encoding: "utf-8", timeout: 5000 },
        );
        const lines = netstatOut.trim().split("\n");
        for (const line of lines) {
          const match = line.match(/LISTENING\s+(\d+)/);
          if (match) {
            const pid = match[1];
            logger.warn(
              `[GatewayLauncher] 发现旧进程 PID=${pid} 占用端口 ${port}，正在终止...`,
            );
            try {
              await execAsync(`taskkill /PID ${pid} /F`, {
                encoding: "utf-8",
                timeout: 5000,
              });
              logger.info(`[GatewayLauncher] 已终止旧进程 PID=${pid}`);
            } catch {
              logger.warn(`[GatewayLauncher] 无法终止 PID=${pid}（可能需要管理员权限）`);
            }
          }
        }
      } else {
        // Unix: 用 fuser 或 lsof 清理
        try {
          await execAsync(`fuser -k ${port}/tcp 2>/dev/null || true`, {
            encoding: "utf-8",
            timeout: 5000,
          });
        } catch {
          try {
            await execAsync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, {
              encoding: "utf-8",
              timeout: 5000,
            });
          } catch { /* 清理失败不阻塞 */ }
        }
      }
    } catch (err) {
      logger.warn(
        "[GatewayLauncher] 端口清理异常: %s",
        (err as Error).message,
      );
    }

    // 等待端口释放（最多 6 秒）
    for (let i = 0; i < 30; i++) {
      if (await isPortFree()) {
        logger.info(`[GatewayLauncher] 端口 ${port} 已释放，可以启动 Gateway`);
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    logger.error(
      `[GatewayLauncher] 端口 ${port} 清理失败，Gateway 可能无法绑定端口`,
    );
  }

  private _spawn(): void {
    // 自举成功则用 venv 中的 python，否则回退到系统 python
    const pythonCmd = this.deps
      ? (process.platform === "win32"
        ? path.join(this.deps.venvDir, "Scripts", "python.exe")
        : path.join(this.deps.venvDir, "bin", "python"))
      : (process.platform === "win32" ? "python" : "python3");

    const child = spawn(pythonCmd, ["-u", "server.py"], {
      cwd: this.gatewayDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // 自举成功时注入 venv 的 PATH
        ...(this.deps ? { PATH: this.deps.spawnEnv.PATH } : {}),
        // 确保 Python 无缓冲输出
        PYTHONUNBUFFERED: "1",
        // 强制 Python UTF-8 输出（修复 Windows 中文乱码"锟斤拷"）
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });

    // 将 Gateway 的 stdout/stderr 转发到主进程日志
    child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        logger.info(`[IM-Gateway] ${line}`);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        // 智能分级：真正的错误栈保留 ERROR，常规诊断信息降为 WARN
        // Python 生态中 Uvicorn 等框架将启动日志写入 stderr，全量 ERROR 造成噪音
        if (/Traceback|Error:|FATAL|CRITICAL/i.test(line)) {
          logger.error(`[IM-Gateway] ${line}`);
        } else {
          logger.warn(`[IM-Gateway] ${line}`);
        }
      }
    });

    // 监听退出事件
    child.on("exit", (code, signal) => {
      logger.info(
        `[GatewayLauncher] IM Gateway exited (code=${code}, signal=${signal})`
      );
      this.process = null;

      // 如果是主动停止，不重启
      if (!this.isRunning) return;

      // 指数退避重启
      if (this.restartAttempts < this.maxRestarts) {
        this.restartAttempts++;
        const delay = Math.min(
          1000 * Math.pow(2, this.restartAttempts - 1),
          30000
        );
        logger.info(
          `[GatewayLauncher] Restarting in ${delay}ms (attempt ${this.restartAttempts}/${this.maxRestarts})`
        );
        setTimeout(() => {
          if (this.isRunning) this._spawn();
        }, delay);
      } else {
        logger.error(
          `[GatewayLauncher] Max restart attempts (${this.maxRestarts}) reached. IM Gateway will not be restarted.`
        );
        this.isRunning = false;
      }
    });

    child.on("error", (err) => {
      logger.error("[GatewayLauncher] Failed to spawn IM Gateway: %s", err);
    });

    this.process = child;
  }

  /**
   * 等待 Gateway 就绪 — 轮询 /health 端点
   * 确保 Gateway 完成 Uvicorn 启动 + lifespan 初始化后再返回
   */
  private async _waitForReady(maxWaitMs = 30000, intervalMs = 1000): Promise<void> {
    const gatewayUrl = process.env.IM_GATEWAY_URL || "http://localhost:8642";
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`${gatewayUrl}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (resp.ok) {
          logger.info("[GatewayLauncher] IM Gateway health check passed");
          return;
        }
      } catch {
        // 尚未就绪，继续等待
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    logger.warn(`[GatewayLauncher] Readiness check timed out after ${maxWaitMs}ms, proceeding anyway`);
  }
}
