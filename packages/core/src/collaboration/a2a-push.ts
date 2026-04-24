/**
 * A2A Push Notification Dispatcher
 *
 * 管理 Task 的 Push Notification 配置并分发事件到 webhook。
 * - register / unregister 管理订阅配置
 * - dispatch 发送 HTTP POST 到 webhookUrl + 指数退避重试
 * - dead-letter 机制：3 次失败后记录日志不再重试
 * - URL 安全校验：强制 HTTPS + 可选白名单
 *
 * @see a2a-types.ts — TaskPushNotificationConfig / PushEvent
 */

import type {
  TaskPushNotificationConfig,
  PushEvent,
} from "./a2a-types.js";
import { isPrivateOrReservedHost } from "./ssrf-guard.js";
import { retryWithBackoff } from "./retry.js";
import pino from "pino";

// ─── 日志（P2-1：统一使用 pino） ──────────────────────────────

const logger = pino({ name: "PushDispatcher" });

const log = {
  info: (msg: string, data?: unknown) => data ? logger.info(data, msg) : logger.info(msg),
  warn: (msg: string, data?: unknown) => data ? logger.warn(data, msg) : logger.warn(msg),
  error: (msg: string, data?: unknown) => data ? logger.error(data, msg) : logger.error(msg),
};

// ─── 配置 ───────────────────────────────────────────────────

export interface PushDispatcherOptions {
  /** 最大重试次数（含首次），默认 3 */
  maxAttempts?: number;
  /** 初始退避延迟（毫秒），默认 500 */
  initialDelayMs?: number;
  /** 最大退避延迟（毫秒），默认 8000 */
  maxDelayMs?: number;
  /** 是否允许非 HTTPS URL（仅用于本地开发），默认 false */
  allowInsecure?: boolean;
  /** URL 白名单域名列表（可选，为空则不限制） */
  domainWhitelist?: string[];
  /** dead-letter 最大容量（P1-6 新增），超过则丢弃最旧条目，默认 1000 */
  maxDeadLetters?: number;
}

// ─── Dead-Letter 记录 ───────────────────────────────────────

interface DeadLetterEntry {
  config: TaskPushNotificationConfig;
  lastEvent: PushEvent;
  failCount: number;
  lastError: string;
  timestamp: string;
}

// ─── PushNotificationDispatcher ─────────────────────────────

/**
 * Push Notification 分发器：管理订阅并投递事件到 webhook。
 */
export class PushNotificationDispatcher {
  /** 按 taskId 存储的订阅配置（一个 Task 可有多个订阅） */
  private readonly subscriptions = new Map<string, TaskPushNotificationConfig[]>();

  /** Dead-letter 记录（所有重试耗尽的事件） */
  private readonly deadLetters: DeadLetterEntry[] = [];

  private readonly maxAttempts: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly allowInsecure: boolean;
  private readonly domainWhitelist: Set<string>;
  private readonly maxDeadLetters: number;

  constructor(opts?: PushDispatcherOptions) {
    this.maxAttempts = opts?.maxAttempts ?? 3;
    this.initialDelayMs = opts?.initialDelayMs ?? 500;
    this.maxDelayMs = opts?.maxDelayMs ?? 8000;
    this.allowInsecure = opts?.allowInsecure ?? false;
    this.domainWhitelist = new Set(opts?.domainWhitelist ?? []);
    this.maxDeadLetters = opts?.maxDeadLetters ?? 1000;
  }

  // ─── 注册 / 注销 ──────────────────────────────────────────

  /**
   * 注册 Push Notification 配置。
   * 校验 URL 安全性后存入内存。
   */
  register(config: TaskPushNotificationConfig): void {
    this.validateUrl(config.webhookUrl);

    const existing = this.subscriptions.get(config.taskId) ?? [];
    // 去重：同 id 覆盖
    const filtered = existing.filter((c) => c.id !== config.id);
    filtered.push(config);
    this.subscriptions.set(config.taskId, filtered);

    log.info("注册推送订阅", { taskId: config.taskId, id: config.id });
  }

  /**
   * 注销指定 Task 的所有推送配置，或按 configId 注销单个。
   */
  unregister(taskId: string, configId?: string): void {
    if (!configId) {
      this.subscriptions.delete(taskId);
      log.info("注销 Task 全部推送订阅", { taskId });
      return;
    }

    const existing = this.subscriptions.get(taskId);
    if (!existing) return;

    const filtered = existing.filter((c) => c.id !== configId);
    if (filtered.length === 0) {
      this.subscriptions.delete(taskId);
    } else {
      this.subscriptions.set(taskId, filtered);
    }
    log.info("注销单个推送订阅", { taskId, configId });
  }

  /**
   * 获取指定 Task 的所有推送配置。
   */
  getSubscriptions(taskId: string): TaskPushNotificationConfig[] {
    return this.subscriptions.get(taskId) ?? [];
  }

  // ─── 分发 ─────────────────────────────────────────────────

  /**
   * 向指定 Task 的所有订阅者分发事件。
   * 每个订阅独立重试，互不阻塞。
   */
  async dispatch(taskId: string, event: PushEvent): Promise<void> {
    const configs = this.subscriptions.get(taskId);
    if (!configs || configs.length === 0) return;

    // 并行投递所有订阅（各自独立重试）
    await Promise.allSettled(
      configs
        .filter((c) => this.shouldDeliver(c, event))
        .map((c) => this.deliverWithRetry(c, event)),
    );
  }

  /**
   * 获取 dead-letter 记录（用于监控/排查）。
   */
  getDeadLetters(): ReadonlyArray<DeadLetterEntry> {
    return this.deadLetters;
  }

  // ─── 内部方法 ─────────────────────────────────────────────

  /**
   * 检查订阅是否关心此事件类型。
   */
  private shouldDeliver(config: TaskPushNotificationConfig, event: PushEvent): boolean {
    if (!config.events || config.events.length === 0) return true;
    return config.events.includes(event.eventType);
  }

  /**
   * 带指数退避重试的投递（委托 retryWithBackoff 公共函数）。
   */
  private async deliverWithRetry(
    config: TaskPushNotificationConfig,
    event: PushEvent,
  ): Promise<void> {
    try {
      await retryWithBackoff(
        async () => {
          await this.deliverOnce(config, event);
          log.info("推送投递成功", {
            taskId: event.taskId,
            configId: config.id,
          });
        },
        {
          maxAttempts: this.maxAttempts,
          initialDelayMs: this.initialDelayMs,
          maxDelayMs: this.maxDelayMs,
        },
        // Push 投递所有错误均可重试（网络/HTTP 错误）
      );
    } catch (err) {
      // 所有重试耗尽 → dead-letter
      const lastError = err instanceof Error ? err.message : String(err);
      log.error("推送投递全部失败，进入 dead-letter", {
        configId: config.id,
        taskId: event.taskId,
        lastError,
      });
      this.deadLetters.push({
        config,
        lastEvent: event,
        failCount: this.maxAttempts,
        lastError,
        timestamp: new Date().toISOString(),
      });
      // P1-6修复：防止 dead-letter 无限增长导致内存泄漏
      while (this.deadLetters.length > this.maxDeadLetters) {
        this.deadLetters.shift();
      }
    }
  }

  /**
   * 单次 HTTP POST 投递。
   */
  private async deliverOnce(
    config: TaskPushNotificationConfig,
    event: PushEvent,
  ): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // 附带鉴权令牌
    if (config.authToken) {
      headers["Authorization"] = `Bearer ${config.authToken}`;
    }

    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
      // P1-2修复：Push 投递超时 10 秒，防止远端 webhook 无响应时挂起
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }

  // ─── URL 安全校验 ─────────────────────────────────────────

  /**
   * 校验 webhook URL 安全性：
   * 1. 必须为有效 URL
   * 2. 默认强制 HTTPS（allowInsecure=true 可放宽）
   * 3. 禁止 localhost/127.0.0.1/::1 等回环地址（防 SSRF）
   * 4. 如有白名单则校验域名
   */
  private validateUrl(urlStr: string): void {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      throw new Error(`无效的 webhook URL: ${urlStr}`);
    }

    // 强制 HTTPS
    if (!this.allowInsecure && parsed.protocol !== "https:") {
      throw new Error(`webhook URL 必须使用 HTTPS: ${urlStr}`);
    }

    // SSRF 防护（P0-3 加固）：复用共享函数检测私网/保留地址
    const hostname = parsed.hostname.toLowerCase();
    if (isPrivateOrReservedHost(hostname)) {
      throw new Error(`webhook URL 禁止指向私网/保留地址: ${hostname}`);
    }

    // 域名白名单校验
    if (this.domainWhitelist.size > 0 && !this.domainWhitelist.has(hostname)) {
      throw new Error(`webhook URL 域名不在白名单中: ${hostname}`);
    }
  }
}
