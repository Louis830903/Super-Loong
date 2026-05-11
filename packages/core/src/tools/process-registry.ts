/**
 * Process Registry — 后台进程注册表
 *
 * 跟踪所有后台进程的生命周期:
 * - ID/命令/PID/状态/输出缓冲
 * - 滚动输出缓冲 (200,000 字符窗口)
 * - 状态查询: 运行中/已退出/已分离(detached)
 * - 进程操作: poll / wait / kill / readLog
 * - oldest-first清理(非LRU): 最多 64 个并发跟踪, 已完成进程 30分钟 TTL
 *
 * 参考: hermes-agent/tools/process_registry.py
 * - 全局锁 + 每个 ProcessSession 独立锁
 * - 后台 reader 线程每次 read(4096), 首块过滤 shell 噪声
 * - _prune_if_needed(): 先TTL清理, 再按 min(started_at) 移除最旧
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { processOutput } from "./output-processor.js";

const logger = pino({ name: "process-registry" });

// ─── 常量配置 ──────────────────────────────────────────────

/** 最大并发跟踪进程数 */
const MAX_TRACKED_PROCESSES = 64;

/** 滚动输出缓冲区大小 (字符) */
const MAX_OUTPUT_BUFFER = 200_000;

/** 已完成进程的 TTL (毫秒) — 30分钟 */
const COMPLETED_TTL_MS = 30 * 60 * 1000;

/** 清理检查间隔 (毫秒) — 60秒 */
const CLEANUP_INTERVAL_MS = 60 * 1000;

/** Idle 超时 (毫秒) — 600秒无输出/访问自动清理（为长任务留足容差） */
const IDLE_TIMEOUT_MS = 600 * 1000;

// ─── 类型定义 ──────────────────────────────────────────────

/** 进程状态 */
export type ProcessStatus = "running" | "exited" | "detached" | "killed";

/** 进程会话信息 */
export interface ProcessSession {
  /** 唯一标识符 */
  id: string;
  /** 执行的命令 */
  command: string;
  /** 操作系统 PID */
  pid: number;
  /** 当前状态 */
  status: ProcessStatus;
  /** 退出码 (仅 exited 状态有效) */
  exitCode: number | null;
  /** 输出缓冲区 (滚动窗口) */
  outputBuffer: string;
  /** 启动时间 */
  startedAt: Date;
  /** 结束时间 (仅 exited/killed 状态有效) */
  endedAt: Date | null;
  /** 最后活动时间 (输出/访问) */
  lastActivityAt: Date;
  /** 工作目录 */
  workdir: string;
}

/** 进程轮询结果 */
export interface ProcessPollResult {
  id: string;
  command: string;
  status: ProcessStatus;
  exitCode: number | null;
  /** 最新输出片段 (最后 2000 字符) */
  recentOutput: string;
  /** 运行时长 (秒) */
  runtimeSeconds: number;
  /** 是否还有更多输出可读 */
  hasMoreOutput: boolean;
}

/** 进程日志读取结果 */
export interface ProcessLogResult {
  id: string;
  /** 输出内容 (指定范围) */
  output: string;
  /** 总字符数 */
  totalChars: number;
  /** 是否已截断 */
  truncated: boolean;
}

// ─── 内部进程句柄 ──────────────────────────────────────────

interface InternalProcess {
  session: ProcessSession;
  childProcess: ChildProcess | null;
  /** 标记是否为首块输出 (用于过滤 shell 噪声) */
  isFirstChunk: boolean;
}

// ─── 进程注册表 ──────────────────────────────────────────────

/** 全局进程注册表 — 单例 */
const _processes = new Map<string, InternalProcess>();

/** 清理定时器 */
let _cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 注册一个新的后台进程
 *
 * @param command 执行的命令
 * @param childProc 子进程对象
 * @param workdir 工作目录
 * @returns 进程会话 ID
 */
export function registerProcess(
  command: string,
  childProc: ChildProcess,
  workdir: string,
): string {
  // 先执行清理检查
  pruneIfNeeded();

  const id = randomUUID().slice(0, 8); // 短 ID 更友好
  const now = new Date();

  const session: ProcessSession = {
    id,
    command,
    pid: childProc.pid ?? -1,
    status: "running",
    exitCode: null,
    outputBuffer: "",
    startedAt: now,
    endedAt: null,
    lastActivityAt: now,
    workdir,
  };

  const internal: InternalProcess = {
    session,
    childProcess: childProc,
    isFirstChunk: true,
  };

  _processes.set(id, internal);

  // 设置输出监听
  setupOutputListeners(internal);

  // 设置退出监听
  setupExitListener(internal);

  // 确保清理定时器在运行
  ensureCleanupTimer();

  logger.info({ id, pid: session.pid, command: command.slice(0, 80) }, "后台进程已注册");

  return id;
}

/**
 * 轮询进程状态和最新输出
 */
export function pollProcess(id: string): ProcessPollResult | null {
  const internal = _processes.get(id);
  if (!internal) return null;

  const { session } = internal;
  session.lastActivityAt = new Date();

  const runtimeMs = (session.endedAt ?? new Date()).getTime() - session.startedAt.getTime();
  const recentOutput = session.outputBuffer.slice(-2000);

  return {
    id: session.id,
    command: session.command,
    status: session.status,
    exitCode: session.exitCode,
    recentOutput: processOutput(recentOutput),
    runtimeSeconds: Math.round(runtimeMs / 1000),
    hasMoreOutput: session.outputBuffer.length > 2000,
  };
}

/**
 * 读取进程完整日志
 *
 * @param id 进程ID
 * @param tail 只返回最后 N 个字符 (可选)
 */
export function readProcessLog(id: string, tail?: number): ProcessLogResult | null {
  const internal = _processes.get(id);
  if (!internal) return null;

  const { session } = internal;
  session.lastActivityAt = new Date();

  let output = session.outputBuffer;
  let truncated = false;

  if (tail && tail < output.length) {
    output = output.slice(-tail);
    truncated = true;
  }

  return {
    id: session.id,
    output: processOutput(output),
    totalChars: session.outputBuffer.length,
    truncated,
  };
}

/**
 * 终止后台进程
 *
 * @param id 进程ID
 * @param signal 终止信号，默认 SIGTERM，超时后自动 SIGKILL
 * @returns 是否成功发送信号
 */
export function killProcess(id: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
  const internal = _processes.get(id);
  if (!internal) return false;

  const { session, childProcess } = internal;

  if (session.status !== "running" || !childProcess) {
    logger.warn({ id, status: session.status }, "进程不在运行状态，无法终止");
    return false;
  }

  try {
    childProcess.kill(signal);
    logger.info({ id, signal }, "已发送终止信号");

    // 如果是 SIGTERM，5秒后检查是否需要 SIGKILL
    if (signal === "SIGTERM") {
      setTimeout(() => {
        if (session.status === "running" && childProcess) {
          logger.warn({ id }, "SIGTERM 超时，发送 SIGKILL");
          childProcess.kill("SIGKILL");
          session.status = "killed";
          session.endedAt = new Date();
        }
      }, 5000);
    } else {
      session.status = "killed";
      session.endedAt = new Date();
    }

    return true;
  } catch (err) {
    logger.error({ id, error: (err as Error).message }, "终止进程失败");
    return false;
  }
}

/**
 * 获取所有已跟踪进程的摘要列表
 */
export function listProcesses(): ProcessSession[] {
  return Array.from(_processes.values()).map(p => ({ ...p.session }));
}

/**
 * 获取正在运行的进程数量
 */
export function getRunningCount(): number {
  let count = 0;
  for (const { session } of _processes.values()) {
    if (session.status === "running") count++;
  }
  return count;
}

// ─── 内部辅助函数 ──────────────────────────────────────────

/**
 * 设置子进程的输出监听
 * - stdout/stderr 合并到 outputBuffer
 * - 滚动窗口: 超过 MAX_OUTPUT_BUFFER 时截取末尾
 * - 首块过滤 shell 噪声 (bash 版本信息等)
 */
function setupOutputListeners(internal: InternalProcess): void {
  const { session, childProcess } = internal;
  if (!childProcess) return;

  const handleData = (data: Buffer) => {
    let chunk = data.toString();

    // 首块过滤: 跳过 shell 启动噪声
    if (internal.isFirstChunk) {
      internal.isFirstChunk = false;
      // 过滤常见的 shell 启动信息
      chunk = chunk.replace(/^(bash|sh|zsh|powershell).*version.*\n/i, "");
    }

    // 追加到缓冲区 (滚动窗口)
    session.outputBuffer += chunk;
    if (session.outputBuffer.length > MAX_OUTPUT_BUFFER) {
      session.outputBuffer = session.outputBuffer.slice(-MAX_OUTPUT_BUFFER);
    }

    session.lastActivityAt = new Date();
  };

  childProcess.stdout?.on("data", handleData);
  childProcess.stderr?.on("data", handleData);
}

/**
 * 设置子进程退出监听
 */
function setupExitListener(internal: InternalProcess): void {
  const { session, childProcess } = internal;
  if (!childProcess) return;

  childProcess.on("close", (code) => {
    session.status = "exited";
    session.exitCode = code;
    session.endedAt = new Date();
    internal.childProcess = null; // 释放子进程引用

    logger.info(
      { id: session.id, exitCode: code, command: session.command.slice(0, 80) },
      "后台进程已退出",
    );
  });

  childProcess.on("error", (err) => {
    session.status = "exited";
    session.exitCode = -1;
    session.endedAt = new Date();
    session.outputBuffer += `\n[ERROR] ${err.message}\n`;
    internal.childProcess = null;

    logger.error(
      { id: session.id, error: err.message },
      "后台进程执行错误",
    );
  });
}

/**
 * 清理过期/超量的进程记录
 *
 * 策略 (参考 Hermes _prune_if_needed):
 * 1. 先按 TTL 清理已完成进程 (30分钟)
 * 2. 先按 idle timeout 清理超时进程 (300秒)
 * 3. 再按 oldest-first 策略移除最旧的进程
 */
function pruneIfNeeded(): void {
  const now = Date.now();

  // Phase 1: TTL 清理已完成进程
  for (const [id, { session }] of _processes) {
    if (
      session.status !== "running" &&
      session.endedAt &&
      now - session.endedAt.getTime() > COMPLETED_TTL_MS
    ) {
      _processes.delete(id);
      logger.debug({ id }, "已清理过期进程记录");
    }
  }

  // Phase 2: Idle 超时清理
  for (const [id, internal] of _processes) {
    const { session } = internal;
    if (
      session.status === "running" &&
      now - session.lastActivityAt.getTime() > IDLE_TIMEOUT_MS
    ) {
      // 尝试终止 idle 进程
      if (internal.childProcess) {
        internal.childProcess.kill("SIGTERM");
      }
      session.status = "killed";
      session.endedAt = new Date();
      logger.info({ id }, "已清理idle超时进程");
    }
  }

  // Phase 3: 数量限制 — oldest-first 移除
  if (_processes.size > MAX_TRACKED_PROCESSES) {
    const sorted = Array.from(_processes.entries())
      .sort(([, a], [, b]) => a.session.startedAt.getTime() - b.session.startedAt.getTime());

    const removeCount = _processes.size - MAX_TRACKED_PROCESSES;
    for (let i = 0; i < removeCount; i++) {
      const [id, internal] = sorted[i];
      // 如果进程还在运行，先终止
      if (internal.session.status === "running" && internal.childProcess) {
        internal.childProcess.kill("SIGTERM");
      }
      _processes.delete(id);
      logger.debug({ id }, "oldest-first清理: 移除最旧进程");
    }
  }
}

/**
 * 确保清理定时器在运行
 */
function ensureCleanupTimer(): void {
  if (_cleanupTimer) return;

  _cleanupTimer = setInterval(() => {
    pruneIfNeeded();

    // 如果没有进程了，停止定时器
    if (_processes.size === 0 && _cleanupTimer) {
      clearInterval(_cleanupTimer);
      _cleanupTimer = null;
    }
  }, CLEANUP_INTERVAL_MS);

  // 允许 Node.js 在只剩这个定时器时正常退出
  if (_cleanupTimer && typeof _cleanupTimer === "object" && "unref" in _cleanupTimer) {
    _cleanupTimer.unref();
  }
}

/**
 * 清除所有进程记录和定时器（仅用于测试/清理）。
 * @internal — 测试专用，不应在生产代码中调用。
 */
export function _resetRegistry(): void {
  // 终止所有运行中的进程
  for (const { childProcess, session } of _processes.values()) {
    if (session.status === "running" && childProcess) {
      childProcess.kill("SIGTERM");
    }
  }
  _processes.clear();

  if (_cleanupTimer) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
}
