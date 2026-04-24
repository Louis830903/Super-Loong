/**
 * Shared runShellCmd — 统一的 shell 命令执行封装
 *
 * 解决的核心问题:
 * 10 个工具文件中复制粘贴相同的 runShellCmd() 函数，仅 timeout 默认值不同。
 * 统一提取后，各文件通过 options 传入各自配置。
 *
 * 使用方式:
 * ```typescript
 * import { runShellCmd } from "../run-shell-cmd.js";
 * const result = await runShellCmd("ls -la", { cwd: "/tmp", timeoutMs: 15_000 });
 * ```
 */

import { spawn } from "node:child_process";
import { buildShellArgs } from "../platform/adapter.js";
import { buildIsolatedEnv } from "../security/env-isolation.js";
import { processOutput } from "./output-processor.js";
import type { ToolResult } from "../types/index.js";

/** runShellCmd 配置选项 */
export interface RunShellCmdOptions {
  /** 工作目录 */
  cwd?: string;
  /** 超时毫秒数，默认 30_000 */
  timeoutMs?: number;
}

/**
 * 在子 shell 中执行命令并返回结果
 *
 * 统一行为:
 * - 使用 buildShellArgs() 自动选择当前平台的 shell
 * - stdout 经过 processOutput() 处理（ANSI 剥离、截断）
 * - success 根据 exit code === 0 判定
 * - 失败时返回退出码 + stderr + stdout 的合并输出
 *
 * @param command shell 命令字符串
 * @param opts 可选配置
 */
export async function runShellCmd(
  command: string,
  opts?: RunShellCmdOptions,
): Promise<ToolResult> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const cwd = opts?.cwd ?? undefined;

  return new Promise((resolve) => {
    const [exe, args] = buildShellArgs(command);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn(exe, args, {
      timeout: timeoutMs,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildIsolatedEnv(), // 安全: 过滤子进程环境变量，阻止敏感密钥泄漏
    });

    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.stderr?.on("data", (d: Buffer) => errChunks.push(d));

    child.on("error", (err) => {
      resolve({ success: false, output: `执行失败: ${err.message}` });
    });

    child.on("close", (code) => {
      const stdout = processOutput(Buffer.concat(chunks).toString("utf-8"));
      const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
      const ok = code === 0;
      resolve({
        success: ok,
        output: ok ? stdout : `退出码: ${code}\n${stderr}\n${stdout}`.trim(),
      });
    });
  });
}
