/**
 * 浏览器会话管理器 — 多会话管理 + 不活跃清理
 *
 * 参考 Hermes double-check 线程安全模式：
 * - Map<taskId, BrowserSession> 管理多并发会话
 * - 不活跃超时清理（默认 300s）
 * - 会话复用策略
 */

import pino from "pino";
import type { BrowserProvider, BrowserSessionConfig, BrowserSessionState, BrowserProviderType } from "./types.js";

const logger = pino({ name: "browser-session-manager" });

/** 默认不活跃超时 5 分钟 */
const DEFAULT_INACTIVITY_TIMEOUT = 300_000;

/** 会话条目 */
interface SessionEntry {
  provider: BrowserProvider;
  state: BrowserSessionState;
  config: BrowserSessionConfig;
}

/**
 * 浏览器会话管理器。
 * 管理多个并发浏览器会话，支持自动清理不活跃会话。
 */
export class BrowserSessionManager {
  private sessions = new Map<string, SessionEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private providerFactory: (type: BrowserProviderType) => Promise<BrowserProvider>;

  constructor(factory: (type: BrowserProviderType) => Promise<BrowserProvider>) {
    this.providerFactory = factory;
    // 每 60 秒检查不活跃会话
    this.cleanupTimer = setInterval(() => this.cleanupInactive(), 60_000);
  }

  /**
   * 获取或创建会话。
   */
  async getOrCreate(sessionId: string, config?: BrowserSessionConfig): Promise<BrowserProvider> {
    // Double-check pattern
    let entry = this.sessions.get(sessionId);
    if (entry && !entry.provider.isClosed()) {
      entry.state.lastActiveAt = new Date();
      return entry.provider;
    }

    // 创建新会话
    const providerType = config?.provider ?? "local";
    const provider = await this.providerFactory(providerType);
    await provider.initialize(config ?? {});

    const state: BrowserSessionState = {
      id: sessionId,
      provider: providerType,
      createdAt: new Date(),
      lastActiveAt: new Date(),
      closed: false,
    };

    this.sessions.set(sessionId, { provider, state, config: config ?? {} });
    logger.info({ sessionId, provider: providerType }, "浏览器会话已创建");
    return provider;
  }

  /**
   * 获取已存在的会话（不创建）。
   */
  get(sessionId: string): BrowserProvider | null {
    const entry = this.sessions.get(sessionId);
    if (entry && !entry.provider.isClosed()) {
      entry.state.lastActiveAt = new Date();
      return entry.provider;
    }
    return null;
  }

  /**
   * 关闭指定会话。
   */
  async close(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      try {
        await entry.provider.close();
      } catch (err) {
        logger.error({ sessionId, err }, "关闭会话失败");
      }
      entry.state.closed = true;
      this.sessions.delete(sessionId);
      logger.info({ sessionId }, "浏览器会话已关闭");
    }
  }

  /**
   * 关闭所有会话。
   */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.allSettled(ids.map(id => this.close(id)));
  }

  /**
   * 列出所有活跃会话。
   */
  listSessions(): BrowserSessionState[] {
    return Array.from(this.sessions.values())
      .filter(e => !e.provider.isClosed())
      .map(e => ({ ...e.state }));
  }

  /**
   * 获取会话数量。
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * 清理不活跃会话。
   */
  private async cleanupInactive(): Promise<void> {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [id, entry] of this.sessions) {
      if (entry.provider.isClosed()) {
        toRemove.push(id);
        continue;
      }
      const timeout = entry.config.inactivityTimeout ?? DEFAULT_INACTIVITY_TIMEOUT;
      if (now - entry.state.lastActiveAt.getTime() > timeout) {
        toRemove.push(id);
      }
    }

    if (toRemove.length > 0) {
      logger.info({ count: toRemove.length }, "清理不活跃浏览器会话");
      await Promise.allSettled(toRemove.map(id => this.close(id)));
    }
  }

  /**
   * 销毁管理器（清理定时器）。
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
