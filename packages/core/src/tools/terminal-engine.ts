/**
 * Terminal Engine — 增强版终端执行引擎
 *
 * 与现有 run_shell 并存(不替换):
 * - run_shell: 简单命令, 30s超时, 无后台/审批/进程管理
 * - terminal: 增强版, 180s默认超时(前台硬限600s), 支持后台/安全审批/进程管理
 *
 * 核心特性:
 * 1. 前台执行(同步等待) + 后台执行(异步跟踪)
 * 2. 会话快照: 保存/恢复环境变量、当前目录
 * 3. 输出处理: ANSI剥离, 敏感信息编辑(截断交给现有系统)
 * 4. 超时机制: 前台默认180s(硬限600s), 后台无限制
 * 5. 中断支持: 外部信号可中断执行中的命令
 * 6. 跨平台: PlatformAdapter自动选择Shell和命令格式
 * 7. 安全: CommandGuard 危险命令检测(Task 2.1实现后集成)
 *
 * 参考: hermes-agent/tools/terminal_tool.py
 * - spawn-per-call 模型: 每条命令新建shell进程
 * - macOS/Linux: sh -c "command" (非 bash, 兼容 alpine/容器)
 * - Windows: pwsh/powershell -NoProfile -Command "command"
 * - 工作目录通过 spawn(cwd=) 参数传递
 */

import { z } from "zod";
import { spawn, type ChildProcess } from "node:child_process";
import pino from "pino";
import type { ToolDefinition, ToolContext, ToolResult } from "../types/index.js";
import { getPlatformInfo, buildShellArgs } from "../platform/adapter.js";
import { processOutputWithExitCode } from "./output-processor.js";
import { checkCompoundCommand } from "../security/command-guard.js";
import { buildIsolatedEnv } from "../security/env-isolation.js";
import { isApproved, recordApproval } from "../security/approval.js";
import {
  registerProcess,
  pollProcess,
  killProcess,
  readProcessLog,
  type ProcessPollResult,
  type ProcessLogResult,
} from "./process-registry.js";

const logger = pino({ name: "terminal-engine" });

// ─── 常量 ──────────────────────────────────────────────────

/** 前台默认超时 (秒) — 参考 Hermes TERMINAL_TIMEOUT=180 */
const DEFAULT_TIMEOUT_SEC = 180;

/** 前台硬限制超时 (秒) */
const MAX_FOREGROUND_TIMEOUT_SEC = 600;

// 环境变量隔离已统一由 env-isolation.ts 的 buildIsolatedEnv() 处理
// 双层策略: 明确黑名单(~100条) + 关键词模式兜底(8种)

// ─── 参数定义 ──────────────────────────────────────────────

/** terminal 工具参数 schema */
const terminalSchema = z.object({
  command: z.string().describe("要执行的Shell命令(使用当前平台的Shell语法)"),
  background: z.boolean().default(false).describe("是否后台执行。true=异步执行并返回进程ID，false=同步等待结果"),
  timeout: z.number().default(DEFAULT_TIMEOUT_SEC).describe("前台执行超时(秒)，默认180，最大600。后台模式忽略此参数"),
  workdir: z.string().optional().describe("工作目录(绝对路径)。不指定则使用进程当前目录"),
  env: z.record(z.string()).optional().describe("额外环境变量(追加到安全白名单环境)"),
});

/** process_poll 工具参数 schema */
const processPollSchema = z.object({
  process_id: z.string().describe("后台进程ID(由terminal后台执行返回)"),
});

/** process_kill 工具参数 schema */
const processKillSchema = z.object({
  process_id: z.string().describe("要终止的后台进程ID"),
  signal: z.enum(["SIGTERM", "SIGKILL", "SIGINT"]).default("SIGTERM").describe("终止信号，默认SIGTERM(优雅终止)"),
});

// ─── 核心执行函数 ──────────────────────────────────────────

// buildSafeEnv 已删除 — 统一使用 buildIsolatedEnv() 替代
// 修复了原 buildSafeEnv 中“不在白名单+不含关键词”的变量被静默丢弃的 bug

/**
 * 前台执行命令 — 同步等待结果
 */
async function executeForeground(
  command: string,
  timeoutSec: number,
  workdir?: string,
  extraEnv?: Record<string, string>,
): Promise<ToolResult> {
  // 超时限制
  const effectiveTimeout = Math.min(timeoutSec, MAX_FOREGROUND_TIMEOUT_SEC);
  const timeoutMs = effectiveTimeout * 1000;

  const [cmd, args] = buildShellArgs(command);
  const platform = getPlatformInfo();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: workdir || process.cwd(),
      env: buildIsolatedEnv(extraEnv),
      timeout: timeoutMs,
      // Windows 上需要 shell: false (已通过 buildShellArgs 处理)
    });

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    // 超时处理
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGKILL");
        const rawOutput = (stdout + stderr).trim();
        const { output } = processOutputWithExitCode(rawOutput, command, -1);
        resolve({
          success: false,
          output,
          error: `命令超时(${effectiveTimeout}s): ${command.slice(0, 80)}`,
        });
      }
    }, timeoutMs);

    proc.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);

        const rawOutput = (stdout + stderr).trim();
        const exitCode = code ?? -1;
        const { output, isNormalExit, exitNote } = processOutputWithExitCode(rawOutput, command, exitCode);

        let finalOutput = output || `Exit code: ${exitCode}`;
        if (exitNote) {
          finalOutput += `\n[退出码说明] ${exitNote}`;
        }

        // 追加执行上下文信息
        finalOutput += `\n[platform: ${platform.osLabel}, workdir: ${workdir || process.cwd()}]`;

        resolve({
          success: exitCode === 0 || isNormalExit,
          output: finalOutput,
          error: !isNormalExit && exitCode !== 0 ? `Exit code: ${exitCode}` : undefined,
        });
      }
    });

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          success: false,
          output: err.message,
          error: err.message,
        });
      }
    });
  });
}

/**
 * 后台执行命令 — 异步跟踪
 */
async function executeBackground(
  command: string,
  workdir?: string,
  extraEnv?: Record<string, string>,
): Promise<ToolResult> {
  const [cmd, args] = buildShellArgs(command);
  const cwd = workdir || process.cwd();

  try {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
      env: buildIsolatedEnv(extraEnv),
      detached: false, // 不分离: 父进程退出时子进程也终止
    });

    if (!proc.pid) {
      return {
        success: false,
        output: "无法启动后台进程",
        error: "spawn failed: no PID",
      };
    }

    const sessionId = registerProcess(command, proc, cwd);

    return {
      success: true,
      output: `后台进程已启动\nID: ${sessionId}\nPID: ${proc.pid}\n命令: ${command.slice(0, 100)}\n\n使用 process_poll 查看状态和输出，使用 process_kill 终止进程。`,
      data: { sessionId, pid: proc.pid },
    };
  } catch (err) {
    return {
      success: false,
      output: `后台进程启动失败: ${(err as Error).message}`,
      error: (err as Error).message,
    };
  }
}

// ─── 工具定义 ──────────────────────────────────────────────

/**
 * terminal 工具 — 增强版Shell执行
 *
 * 与 run_shell 并存，提供:
 * - 后台执行能力
 * - 更长的默认超时(180s vs 30s)
 * - 安全审批(CommandGuard, Task 2.1 集成后启用)
 * - 环境变量隔离
 * - 退出码语义解释
 */
export const terminalTool: ToolDefinition = {
  name: "terminal",
  description:
    "Execute a shell command with enhanced capabilities (background execution, longer timeout, security guard). " +
    "Use this instead of run_shell when you need: background processes, long-running commands, " +
    "or operations that may require security approval. " +
    "Check the Runtime section for OS and shell details.",
  parameters: terminalSchema,
  execute: async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const parsed = terminalSchema.parse(params);
    const { command, background, timeout, workdir, env } = parsed;

    // CommandGuard 危险命令检测 — 42条规则自动拦截
    const guardResult = checkCompoundCommand(command);
    if (guardResult.isDangerous) {
      const { level, patternKey, category, description } = guardResult;

      // critical: 绝对拦截，不可审批
      if (level === "critical") {
        logger.warn(
          { command: command.slice(0, 80), pattern: patternKey, category },
          "critical 级別命令被绝对拦截",
        );
        return {
          success: false,
          output: `🚫 critical 级别命令被绝对拦截\n类型: ${category}\n说明: ${description}\n\n此命令不可通过审批机制放行。`,
          error: `Critical command blocked: ${patternKey}`,
        };
      }

      // high/medium: 检查是否已审批
      if (!isApproved(patternKey!, context.sessionId)) {
        logger.warn(
          { command: command.slice(0, 80), pattern: patternKey, category, level },
          "危险命令需要审批",
        );
        return {
          success: false,
          output: `⚠️ 此命令需要审批\n等级: ${level}\n模式: ${patternKey}\n类型: ${category}\n说明: ${description}\n\n请用户确认后，使用 approve_command 批准此操作。`,
          data: { needsApproval: true, patternKey, level },
        };
      }

      // 已审批 — 放行
      logger.info({ patternKey, level }, "已审批命令放行");
    }

    logger.info(
      { command: command.slice(0, 80), background, timeout, workdir },
      "终端命令执行",
    );

    if (background) {
      return executeBackground(command, workdir, env);
    }

    const result = await executeForeground(command, timeout, workdir, env);

    // Phase 4 Task 4.6: 更新会话状态（当前目录 + 退出码）
    const exitCode = result.success ? 0 : -1;
    updateSessionState(context.sessionId, workdir || process.cwd(), exitCode, result.output ?? "");

    return result;
  },
};

/**
 * process_poll 工具 — 查询后台进程状态和输出
 */
export const processPollTool: ToolDefinition = {
  name: "process_poll",
  description:
    "Check the status and recent output of a background process started with the terminal tool. " +
    "Returns the process status (running/exited/killed) and the last 2000 characters of output.",
  parameters: processPollSchema,
  execute: async (params: unknown, _context: ToolContext): Promise<ToolResult> => {
    const { process_id } = processPollSchema.parse(params);

    const result = pollProcess(process_id);
    if (!result) {
      return {
        success: false,
        output: `进程 ${process_id} 未找到。可能已过期或ID错误。`,
        error: "Process not found",
      };
    }

    const statusEmoji = result.status === "running" ? "🟢" : result.status === "exited" ? "⚪" : "🔴";
    const lines = [
      `${statusEmoji} 进程 ${result.id}`,
      `状态: ${result.status}`,
      `命令: ${result.command.slice(0, 100)}`,
      `运行时长: ${result.runtimeSeconds}s`,
    ];

    if (result.exitCode !== null) {
      lines.push(`退出码: ${result.exitCode}`);
    }

    if (result.recentOutput) {
      lines.push("", "--- 最新输出 ---", result.recentOutput);
    } else {
      lines.push("", "(暂无输出)");
    }

    if (result.hasMoreOutput) {
      lines.push("", "[提示: 使用 process_poll 的 tail 参数可获取更多输出]");
    }

    return {
      success: true,
      output: lines.join("\n"),
      data: result,
    };
  },
};

/**
 * process_kill 工具 — 终止后台进程
 */
export const processKillTool: ToolDefinition = {
  name: "process_kill",
  description:
    "Terminate a running background process. Sends SIGTERM by default (graceful shutdown). " +
    "Use SIGKILL for force-kill if SIGTERM doesn't work.",
  parameters: processKillSchema,
  execute: async (params: unknown, _context: ToolContext): Promise<ToolResult> => {
    const { process_id, signal } = processKillSchema.parse(params);

    const success = killProcess(process_id, signal as NodeJS.Signals);
    if (!success) {
      return {
        success: false,
        output: `无法终止进程 ${process_id}。可能已退出或ID错误。`,
        error: "Kill failed",
      };
    }

    return {
      success: true,
      output: `已向进程 ${process_id} 发送 ${signal} 信号。`,
    };
  },
};

// ─── approve_command 工具 ─ 审批闭环的关键一环 ──────────

/** approve_command 参数 schema */
const approveCommandSchema = z.object({
  pattern_key: z.string().describe("命令模式 key (从 terminal 拦截消息的 patternKey 字段获取)"),
  scope: z.enum(["once", "session"]).default("session").describe("once=仅本次, session=本会话同类放行"),
});

/**
 * approve_command 工具 — 批准被安全系统拦截的命令模式
 *
 * 端到端流程:
 * 1. Agent 调用 terminal("rm -rf old_cache/")
 * 2. CommandGuard 检测到 high 级別危险, patternKey="dangerous_rm"
 * 3. isApproved("dangerous_rm", sessionId) → false
 * 4. 返回 "⚠️ 需要审批: dangerous_rm"
 * 5. Agent 向用户说明风险，用户回复 "可以执行"
 * 6. Agent 调用 approve_command({ pattern_key: "dangerous_rm", scope: "session" })
 * 7. Agent 再次调用 terminal("rm -rf old_cache/") → isApproved → true → 执行
 */
export const approveCommandTool: ToolDefinition = {
  name: "approve_command",
  description:
    "Approve a command pattern that was blocked by the security system. " +
    "Only call this AFTER the user has explicitly confirmed they want to proceed. " +
    "Use the pattern_key from the terminal tool's blocking message.",
  parameters: approveCommandSchema,
  execute: async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const { pattern_key, scope } = approveCommandSchema.parse(params);
    recordApproval(pattern_key, context.sessionId, scope);
    return {
      success: true,
      output: `✅ 已批准: ${pattern_key} (${scope === "session" ? "会话级 — 本会话同类命令均放行" : "仅本次"})\n现在可以重新执行被拦截的命令。`,
    };
  },
};
// ─── 会话状态跟踪（Phase 4 Task 4.6）──────────────────

/** 每个会话的当前工作目录 */
const sessionWorkdirs: Map<string, string> = new Map();
/** 每个会话的最后退出码 */
const sessionExitCodes: Map<string, number> = new Map();
/** 每个会话的最后输出（截断到 2000 字符） */
const sessionLastOutput: Map<string, string> = new Map();

/** 更新会话状态 */
function updateSessionState(sessionId: string, workdir: string, exitCode: number, output: string): void {
  sessionWorkdirs.set(sessionId, workdir);
  sessionExitCodes.set(sessionId, exitCode);
  sessionLastOutput.set(sessionId, output.slice(-2000));
}

// ─── shell_status 工具 ─ 查询当前 Shell 状态 ──────────

/** shell_status 参数 schema */
const shellStatusSchema = z.object({
  _dummy: z.string().optional().describe("无需参数"),
});

/**
 * shell_status 工具 — 返回当前 Shell 会话的状态快照。
 *
 * 包含：当前工作目录、上一次命令的退出码、环境变量快照、
 * 最后输出（截断）和平台信息。
 */
export const shellStatusTool: ToolDefinition = {
  name: "shell_status",
  description:
    "Get the current status of the shell session. " +
    "Returns: working directory, last exit code, environment snapshot, " +
    "last command output (truncated), and platform info. " +
    "Use this to understand the current shell state before running commands.",
  parameters: shellStatusSchema,
  execute: async (_params: unknown, context: ToolContext): Promise<ToolResult> => {
    const workdir = sessionWorkdirs.get(context.sessionId) ?? process.cwd();
    const exitCode = sessionExitCodes.get(context.sessionId);
    const lastOutput = sessionLastOutput.get(context.sessionId);
    const platform = getPlatformInfo();

    // 环境变量快照（仅安全白名单）
    const safeEnvKeys = ["HOME", "USER", "PATH", "SHELL", "PWD", "LANG", "NODE_ENV",
      "OS", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"];
    const envSnapshot: Record<string, string> = {};
    for (const key of safeEnvKeys) {
      if (process.env[key]) {
        // 脱敏：截断过长的值
        const val = process.env[key]!;
        envSnapshot[key] = val.length > 200 ? val.slice(0, 200) + "..." : val;
      }
    }

    const lines = [
      `📂 当前目录: ${workdir}`,
      `💻 平台: ${platform.osLabel} (${platform.arch})`,
      `🐚 Shell: ${platform.shell}`,
      exitCode !== undefined ? `✅ 上次退出码: ${exitCode}` : "ℹ️ 尚未执行命令",
      "",
      "📋 环境变量:",
      ...Object.entries(envSnapshot).map(([k, v]) => `  ${k}=${v}`),
    ];

    if (lastOutput) {
      lines.push("", "📄 最后一次输出（截断）:", lastOutput);
    }

    return {
      success: true,
      output: lines.join("\n"),
      data: { workdir, exitCode, platform, envSnapshot },
    };
  },
};

// ─── shell_wait 工具 ─ 等待上次命令完成 ────────────────

/** shell_wait 参数 schema */
const shellWaitSchema = z.object({
  process_id: z.string().describe("要等待的后台进程ID"),
  poll_interval: z.number().default(2000).describe("轮询间隔（毫秒），默认 2000"),
  max_wait: z.number().default(300000).describe("最大等待时间（毫秒），默认 300000（5分钟）"),
});

/**
 * shell_wait 工具 — 等待后台进程完成。
 *
 * 阻塞式轮询 process_poll，直到进程退出或超时。
 * 适用于需要等待长时间运行命令完成的场景。
 */
export const shellWaitTool: ToolDefinition = {
  name: "shell_wait",
  description:
    "Wait for a background process to complete. " +
    "This will poll the process status at the specified interval " +
    "until the process exits or the max wait time is reached. " +
    "Returns the final output and exit code when complete.",
  parameters: shellWaitSchema,
  execute: async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const { process_id, poll_interval, max_wait } = shellWaitSchema.parse(params);

    const startTime = Date.now();
    let lastResult: ProcessPollResult | undefined;

    while (Date.now() - startTime < max_wait) {
      const result = pollProcess(process_id);

      if (!result) {
        return {
          success: false,
          output: `进程 ${process_id} 未找到。可能已过期或ID错误。`,
          error: "Process not found",
        };
      }

      lastResult = result;

      // 进程已退出或被杀
      if (result.status === "exited" || result.status === "killed") {
        const lines = [
          `✅ 进程 ${process_id} 已完成`,
          `状态: ${result.status}`,
          `退出码: ${result.exitCode ?? "N/A"}`,
          `运行时长: ${result.runtimeSeconds}s`,
          `等待耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`,
        ];

        if (result.recentOutput) {
          lines.push("", "--- 输出 ---", result.recentOutput);
        }

        // 更新会话状态
        updateSessionState(
          context.sessionId,
          process.cwd(),
          result.exitCode ?? -1,
          result.recentOutput ?? "",
        );

        return {
          success: result.exitCode === 0,
          output: lines.join("\n"),
          data: result,
        };
      }

      // 仍在运行 — 等待下一次轮询
      await new Promise(resolve => setTimeout(resolve, poll_interval));
    }

    // 超时
    return {
      success: false,
      output: `⏰ 等待超时（${max_wait / 1000}s）\n进程 ${process_id} 仍在运行中。\n使用 process_poll 手动检查状态，或使用 process_kill 终止。`,
      data: lastResult,
    };
  },
};

// ─── shell_interrupt 工具 ─ 中断正在运行的命令 ─────────

/** shell_interrupt 参数 schema */
const shellInterruptSchema = z.object({
  process_id: z.string().describe("要中断的后台进程ID"),
});

/**
 * shell_interrupt 工具 — 发送 Ctrl+C 中断当前命令。
 *
 * 相当于在终端按 Ctrl+C。发送 SIGINT 信号。
 * 如果 SIGINT 无效，可再调用 process_kill(signal="SIGKILL")。
 */
export const shellInterruptTool: ToolDefinition = {
  name: "shell_interrupt",
  description:
    "Send an interrupt signal (Ctrl+C equivalent) to a running background process. " +
    "Use this to stop a long-running command that you no longer need. " +
    "If the process doesn't respond to SIGINT, use process_kill with SIGKILL instead.",
  parameters: shellInterruptSchema,
  execute: async (params: unknown, _context: ToolContext): Promise<ToolResult> => {
    const { process_id } = shellInterruptSchema.parse(params);

    const success = killProcess(process_id, "SIGINT");
    if (!success) {
      return {
        success: false,
        output: `无法中断进程 ${process_id}。可能已退出或ID错误。`,
        error: "Interrupt failed",
      };
    }

    return {
      success: true,
      output: `已向进程 ${process_id} 发送 SIGINT 信号（Ctrl+C）。\n使用 process_poll 查看进程状态。`,
    };
  },
};

export const terminalTools: ToolDefinition[] = [
  terminalTool,
  processPollTool,
  processKillTool,
  approveCommandTool,
  shellStatusTool,
  shellWaitTool,
  shellInterruptTool,
];
