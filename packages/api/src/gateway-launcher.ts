/**
 * Gateway Launcher — 独立模块，在 app.listen() 成功后启动 IM Gateway 子进程。
 *
 * 设计原则：
 * - 不侵入 context.ts 的 11 模块初始化序列
 * - 在 app.listen() 成功后才触发启动，确保 /api/chat 已就绪
 * - Gateway 崩溃时指数退避重启（最多 5 次）
 * - API 关闭时优雅终止 Gateway 子进程
 */

import { spawn, type ChildProcess } from "child_process";
import path from "node:path";

export class GatewayLauncher {
  private process: ChildProcess | null = null;
  private restartAttempts = 0;
  private maxRestarts = 5;
  private isRunning = false;
  private gatewayDir: string;

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

    try {
      this.isRunning = true;
      this.restartAttempts = 0;
      this._spawn();
      await this._waitForReady();
      console.log(`[GatewayLauncher] IM Gateway started and ready (dir: ${this.gatewayDir})`);
    } catch (err) {
      console.error("[GatewayLauncher] Failed to start IM Gateway:", err);
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
      console.log("[GatewayLauncher] Stopping IM Gateway...");
      // 发送 SIGTERM，给 5 秒优雅关闭
      this.process.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            console.log("[GatewayLauncher] Force killing IM Gateway");
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
      console.log("[GatewayLauncher] IM Gateway stopped");
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

  private _spawn(): void {
    // 使用 python 启动 server.py
    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    const child = spawn(pythonCmd, ["-u", "server.py"], {
      cwd: this.gatewayDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // 确保 Python 无缓冲输出
        PYTHONUNBUFFERED: "1",
      },
    });

    // 将 Gateway 的 stdout/stderr 转发到主进程日志
    child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        console.log(`[IM-Gateway] ${line}`);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        console.error(`[IM-Gateway] ${line}`);
      }
    });

    // 监听退出事件
    child.on("exit", (code, signal) => {
      console.log(
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
        console.log(
          `[GatewayLauncher] Restarting in ${delay}ms (attempt ${this.restartAttempts}/${this.maxRestarts})`
        );
        setTimeout(() => {
          if (this.isRunning) this._spawn();
        }, delay);
      } else {
        console.error(
          `[GatewayLauncher] Max restart attempts (${this.maxRestarts}) reached. IM Gateway will not be restarted.`
        );
        this.isRunning = false;
      }
    });

    child.on("error", (err) => {
      console.error("[GatewayLauncher] Failed to spawn IM Gateway:", err);
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
          console.log("[GatewayLauncher] IM Gateway health check passed");
          return;
        }
      } catch {
        // 尚未就绪，继续等待
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    console.warn(`[GatewayLauncher] Readiness check timed out after ${maxWaitMs}ms, proceeding anyway`);
  }
}
