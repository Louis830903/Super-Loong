/**
 * Process Sandbox — child_process 隔离的工具执行器
 *
 * @why v3 Task 9 拆分：从原 sandbox.ts 提取 ProcessSandbox 类（约 200 行），
 *      使用 child_process.fork + node:vm 双层隔离，配合 timeout/heap 限额。
 *      同包导入：sandbox-types 提供类型定义。
 *
 * 提供：
 * - Timeout 强制（超时 SIGKILL 子进程）
 * - 内存限额（--max-old-space-size）
 * - 隔离执行上下文（IPC 传参，clean env 不继承秘钥）
 * - executeWithTimeout：兼底路径，仅超时保护，闭包工具用
 */

import type { ProcessSandboxOptions, SandboxResult } from "./sandbox-types.js";

/**
 * Process-level sandbox that executes code in an isolated child_process.
 *
 * Provides:
 * - Timeout enforcement (kills process on timeout)
 * - Memory limits via --max-old-space-size
 * - Isolated execution context (no access to parent process globals)
 * - IPC-based result passing
 */
export class ProcessSandbox {
  private activeCount = 0;
  private maxConcurrent: number;

  constructor(maxConcurrent = 10) {
    this.maxConcurrent = maxConcurrent;
  }

  get active(): number {
    return this.activeCount;
  }

  /**
   * Execute a function in an isolated child process.
   * The function is serialized to a string, sent to a worker, and executed there.
   * Only works with pure functions (no closures over parent scope).
   */
  async execute(
    code: string,
    args: Record<string, unknown> = {},
    options: ProcessSandboxOptions = {},
  ): Promise<SandboxResult> {
    const { fork } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { writeFileSync, unlinkSync } = await import("node:fs");

    if (this.activeCount >= this.maxConcurrent) {
      return {
        success: false,
        output: "Sandbox limit reached",
        error: "Max concurrent sandboxes exceeded",
        durationMs: 0,
      };
    }

    const timeoutMs = options.timeoutMs ?? 30000;
    const maxHeapMB = options.maxHeapMB ?? 128;
    const start = Date.now();

    // Write a temporary worker script
    const workerId = `sa_sandbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const workerPath = join(tmpdir(), `${workerId}.mjs`);

    // P2-06: Removed unused worker_threads import (this is a child_process fork, not a worker)
    // P1-08: Use vm.runInNewContext to restrict available APIs in sandbox
    // FIX: Use resolve/reject callbacks to correctly propagate async results from VM context
    const workerCode = `
import { createContext, compileFunction } from 'node:vm';
// Sandbox worker — receives code + args, executes in restricted VM context
process.on('message', async (msg) => {
  try {
    let _resolve, _reject;
    const resultPromise = new Promise((resolve, reject) => {
      _resolve = resolve;
      _reject = reject;
    });
    const sandbox = {
      args: msg.args,
      console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout,
      Promise,
      JSON,
      Math,
      Date,
      Array, Object, String, Number, Boolean, Map, Set,
      Buffer,
      _resolve,
      _reject,
      code: msg.code,
    };
    // P1-07: 使用 compileFunction 替代 new Function，限制沙箱上下文
    try {
      const ctx = createContext(sandbox);
      const fn = compileFunction(msg.code, ['args'], { parsingContext: ctx });
      const r = await fn(msg.args);
      _resolve(r);
    } catch(e) {
      _reject(e);
    }
    const result = await resultPromise;
    process.send({ success: true, output: String(result ?? ''), data: result });
  } catch (err) {
    process.send({ success: false, output: err.message, error: err.message });
  }
  process.exit(0);
});
`;

    writeFileSync(workerPath, workerCode, "utf-8");

    this.activeCount++;

    return new Promise<SandboxResult>((resolve) => {
      let settled = false;

      const child = fork(workerPath, [], {
        execArgv: [`--max-old-space-size=${maxHeapMB}`],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {}, // Clean environment — no inherited secrets
      });

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill("SIGKILL");
          this.activeCount--;
          cleanup();
          resolve({
            success: false,
            output: "Execution timed out",
            error: `Sandbox timeout after ${timeoutMs}ms`,
            durationMs: Date.now() - start,
          });
        }
      }, timeoutMs);

      const cleanup = () => {
        try { unlinkSync(workerPath); } catch { /* ignore */ }
      };

      child.on("message", (msg: SandboxResult) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.activeCount--;
          cleanup();
          resolve({ ...msg, durationMs: Date.now() - start });
        }
      });

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.activeCount--;
          cleanup();
          resolve({
            success: false,
            output: err.message,
            error: err.message,
            durationMs: Date.now() - start,
          });
        }
      });

      child.on("exit", (exitCode) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.activeCount--;
          cleanup();
          resolve({
            success: exitCode === 0,
            output: exitCode === 0 ? "" : `Process exited with code ${exitCode}`,
            error: exitCode !== 0 ? `Exit code: ${exitCode}` : undefined,
            durationMs: Date.now() - start,
          });
        }
      });

      // Send code + args to the child
      child.send({ code, args });
    });
  }

  /**
   * Execute a tool's function with a timeout wrapper (NOT process isolation).
   *
   * P1-07: This method provides **only timeout enforcement** — the function still
   * runs in the main process. Use `execute()` for true child_process isolation.
   *
   * For closure-based tool functions that cannot be serialized to a child process,
   * this provides a safety net against runaway execution.
   *
   * @param fn - Async function to execute (runs in current process)
   * @param options.timeoutMs - Max execution time (default: 30000ms)
   * @param options.maxHeapMB - P2-10: Ignored in this path; only effective in `execute()` which uses child_process
   */
  async executeWithTimeout<T>(
    fn: () => Promise<T>,
    options: ProcessSandboxOptions = {},
  ): Promise<{ result?: T; timedOut: boolean; durationMs: number; error?: string }> {
    const timeoutMs = options.timeoutMs ?? 30000;
    const start = performance.now();
    this.activeCount++;

    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Sandbox timeout after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
      return { result, timedOut: false, durationMs: Math.max(1, Math.round(performance.now() - start)) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const timedOut = msg.includes("Sandbox timeout");
      return { timedOut, durationMs: Math.max(1, Math.round(performance.now() - start)), error: msg };
    } finally {
      this.activeCount--;
    }
  }
}
