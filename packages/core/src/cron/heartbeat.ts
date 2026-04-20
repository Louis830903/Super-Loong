/**
 * Heartbeat Runner — 心跳巡检引擎（学 OpenClaw Heartbeat System）
 *
 * 定期触发 Agent 自检：
 * 1. 读取项目根目录 HEARTBEAT.md 作为巡检清单
 * 2. 以隔离会话（不污染主对话）执行心跳轮次
 * 3. 若回复包含 HEARTBEAT_OK → 静默吞掉（无事发生）
 * 4. 若回复有实际内容 → 按 target 投递
 *
 * 对标：
 * - OpenClaw src/auto-reply/heartbeat.ts (HEARTBEAT_PROMPT, ackMaxChars)
 * - OpenClaw src/infra/heartbeat-runner.ts (runHeartbeatOnce)
 * - OpenClaw src/infra/heartbeat-schedule.ts (interval + active hours)
 * - OpenClaw src/agents/heartbeat-system-prompt.ts (system prompt injection)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { CronScheduler } from "./scheduler.js";

const logger = pino({ name: "heartbeat" });

// ─── 配置结构 ──────────────────────────────────────────────

export interface HeartbeatConfig {
  enabled: boolean;
  /** 心跳间隔，如 "30m", "1h", "0m"(禁用) */
  every: string;
  /** 覆盖主 agent 模型（心跳可用更便宜的模型） */
  model?: string;
  /** 自定义心跳提示词（覆盖默认 HEARTBEAT_PROMPT） */
  prompt?: string;
  /** 投递目标: "none"(默认不投递) | "last"(最近联系人) | channel-id */
  target: "none" | "last" | string;
  /** 仅加载 HEARTBEAT.md 作为上下文（减少 token） */
  lightContext: boolean;
  /** 每次心跳使用隔离会话（不污染主对话） */
  isolatedSession: boolean;
  /** 活跃时段限制 */
  activeHours?: { start: string; end: string; timezone: string };
  /** HEARTBEAT_OK 后允许的最大附加字符数（超出则保留完整回复） */
  ackMaxChars: number;
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  enabled: false,
  every: "30m",
  target: "none",
  lightContext: true,
  isolatedSession: true,
  ackMaxChars: 300,
};

// ─── 提示词常量 ──────────────────────────────────────────────

/** 默认心跳用户消息（发送给 Agent 作为 user message） */
export const HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). " +
  "Follow it strictly. Do not infer or repeat old tasks from prior chats. " +
  "If nothing needs attention, reply HEARTBEAT_OK.";

/** 系统提示中注入的心跳指导段落 */
export const HEARTBEAT_SYSTEM_SECTION = `## Heartbeats
If the current user message is a heartbeat poll and nothing needs attention, reply exactly:
HEARTBEAT_OK
If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.`;

// ─── 回调接口 ──────────────────────────────────────────────

/** 心跳执行回调：接受用户消息，返回 Agent 回复 */
export type HeartbeatExecuteFn = (
  userMessage: string,
  contextMd: string | null,
  isolatedSession: boolean,
  model?: string,
) => Promise<string>;

/** 心跳投递回调：将有意义的回复投递到目标 */
export type HeartbeatDeliverFn = (
  target: string,
  content: string,
) => Promise<void>;

// ─── HeartbeatRunner 类 ────────────────────────────────────

export class HeartbeatRunner {
  private config: HeartbeatConfig;
  private cronScheduler: CronScheduler;
  private executeFn?: HeartbeatExecuteFn;
  private deliverFn?: HeartbeatDeliverFn;
  private contextFilesRoot?: string;
  private heartbeatJobId: string | null = null;

  constructor(
    config: Partial<HeartbeatConfig> & { enabled?: boolean },
    cronScheduler: CronScheduler,
    options?: {
      contextFilesRoot?: string;
      executeFn?: HeartbeatExecuteFn;
      deliverFn?: HeartbeatDeliverFn;
    },
  ) {
    this.config = { ...DEFAULT_HEARTBEAT_CONFIG, ...config };
    this.cronScheduler = cronScheduler;
    this.contextFilesRoot = options?.contextFilesRoot;
    this.executeFn = options?.executeFn;
    this.deliverFn = options?.deliverFn;
  }

  /** 设置执行回调（由 API 层注入） */
  setExecuteFn(fn: HeartbeatExecuteFn): void {
    this.executeFn = fn;
  }

  /** 设置投递回调（由 API 层注入） */
  setDeliverFn(fn: HeartbeatDeliverFn): void {
    this.deliverFn = fn;
  }

  /** 启动心跳调度 */
  start(): void {
    if (!this.config.enabled) {
      logger.info("Heartbeat disabled, not starting");
      return;
    }

    const intervalMs = this.parseInterval(this.config.every);
    if (intervalMs <= 0) {
      logger.info("Heartbeat interval is 0, disabled");
      return;
    }

    // 将间隔转为 cron 表达式注册到 CronScheduler
    const cronExpr = this.intervalToCron(intervalMs);
    try {
      const job = this.cronScheduler.addJob({
        name: "__heartbeat__",
        expression: cronExpr,
        agentId: "__heartbeat__",
        message: this.config.prompt || HEARTBEAT_PROMPT,
      });
      this.heartbeatJobId = job.id;
      logger.info({ every: this.config.every, cronExpr }, "Heartbeat started");
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to start heartbeat");
    }
  }

  /** 停止心跳调度 */
  stop(): void {
    if (this.heartbeatJobId) {
      this.cronScheduler.removeJob(this.heartbeatJobId);
      this.heartbeatJobId = null;
      logger.info("Heartbeat stopped");
    }
  }

  /** 执行单次心跳（可由外部手动触发或 Cron 回调调用） */
  async runOnce(): Promise<string | null> {
    // 1. 活跃时段检查
    if (!this.isInActiveHours()) {
      logger.debug("Outside active hours, skipping heartbeat");
      return null;
    }

    // 2. 读取 HEARTBEAT.md
    const contextMd = this.loadHeartbeatMd();
    if (contextMd !== null && this.isEffectivelyEmpty(contextMd)) {
      logger.debug("HEARTBEAT.md is effectively empty, skipping API call");
      return null;
    }

    // 3. 构造用户消息
    const userMessage = this.config.prompt || HEARTBEAT_PROMPT;

    // 4. 执行
    if (!this.executeFn) {
      logger.warn("No execute function set, cannot run heartbeat");
      return null;
    }

    try {
      const reply = await this.executeFn(
        userMessage,
        contextMd,
        this.config.isolatedSession,
        this.config.model,
      );

      // 5. 剥离 HEARTBEAT_OK
      const stripped = this.stripAck(reply);

      // 6. 若为纯 OK → 不投递
      if (stripped === null) {
        logger.debug("Heartbeat OK — nothing to report");
        return null;
      }

      // 7. 投递
      if (this.config.target !== "none" && this.deliverFn) {
        await this.deliverFn(this.config.target, stripped);
        logger.info({ target: this.config.target }, "Heartbeat alert delivered");
      }

      return stripped;
    } catch (err: any) {
      logger.error({ error: err.message }, "Heartbeat execution failed");
      return null;
    }
  }

  // ─── 配置读取 ────────────────────────────────────────────

  /** 获取当前心跳配置 */
  getConfig(): Readonly<HeartbeatConfig> {
    return { ...this.config };
  }

  /** 更新心跳配置（运行时调整） */
  updateConfig(updates: Partial<HeartbeatConfig>): void {
    const wasEnabled = this.config.enabled;
    this.config = { ...this.config, ...updates };

    // 若启用状态变化，重新调度
    if (wasEnabled && !this.config.enabled) {
      this.stop();
    } else if (!wasEnabled && this.config.enabled) {
      this.start();
    }
  }

  // ─── 内部工具方法 ────────────────────────────────────────

  /** 检查当前是否在活跃时段内 */
  private isInActiveHours(): boolean {
    const { activeHours } = this.config;
    if (!activeHours) return true; // 无限制

    const now = new Date();
    // 简单时段检查：解析 HH:MM 格式
    const [startH, startM] = activeHours.start.split(":").map(Number);
    const [endH, endM] = activeHours.end.split(":").map(Number);

    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      // 同日区间：08:00 ~ 22:00
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } else {
      // 跨日区间：22:00 ~ 06:00
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
  }

  /** 解析间隔字符串为毫秒："30m" → 1800000, "1h" → 3600000, "0m" → 0 */
  private parseInterval(str: string): number {
    const match = str.match(/^(\d+)\s*(m|h|s)$/i);
    if (!match) return 0;
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    switch (unit) {
      case "s": return value * 1000;
      case "m": return value * 60 * 1000;
      case "h": return value * 60 * 60 * 1000;
      default: return 0;
    }
  }

  /** 将毫秒间隔转为 cron 表达式 */
  private intervalToCron(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    if (minutes <= 0) return "0 * * * *"; // fallback: hourly
    if (minutes < 60) return `*/${minutes} * * * *`;
    const hours = Math.round(minutes / 60);
    return `0 */${hours} * * *`;
  }

  /**
   * 剥离 HEARTBEAT_OK 令牌。
   * - 若回复仅含 HEARTBEAT_OK（或 OK 后附加内容 <= ackMaxChars），返回 null
   * - 否则返回剥离后的内容
   */
  private stripAck(reply: string): string | null {
    const trimmed = reply.trim();
    const token = "HEARTBEAT_OK";

    // 完全匹配
    if (trimmed === token) return null;

    // 以 token 开头或结尾
    let stripped = trimmed;
    if (stripped.startsWith(token)) {
      stripped = stripped.slice(token.length).trim();
    } else if (stripped.endsWith(token)) {
      stripped = stripped.slice(0, -token.length).trim();
    } else {
      // 不包含 token，返回完整回复
      return trimmed;
    }

    // 剥离后内容 <= ackMaxChars → 视为"无事发生"
    if (stripped.length <= this.config.ackMaxChars) {
      return null;
    }

    return stripped;
  }

  /** 读取项目根目录 HEARTBEAT.md */
  private loadHeartbeatMd(): string | null {
    if (!this.contextFilesRoot) return null;
    const mdPath = join(this.contextFilesRoot, "HEARTBEAT.md");
    if (!existsSync(mdPath)) return null;

    try {
      return readFileSync(mdPath, "utf-8");
    } catch {
      return null;
    }
  }

  /** 检测文件是否"实质为空"（仅含标题/空列表/空白） */
  private isEffectivelyEmpty(content: string): boolean {
    // 移除 Markdown 标题行和空行
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l !== "-" && l !== "*");
    return lines.length === 0;
  }
}
