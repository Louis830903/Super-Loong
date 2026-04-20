/**
 * EventBridge — MCP Server 事件桥接系统
 *
 * 参考 Hermes EventBridge 实现：
 * - 事件队列：内存缓冲 + 可选持久化
 * - 游标式消费：每个客户端维护独立游标
 * - 长轮询：events_wait 挂起直到有新事件或超时
 * - 后台清理：过期事件自动清理
 */

import pino from "pino";
import { v4 as uuid } from "uuid";

const logger = pino({ name: "mcp-event-bridge" });

/** MCP 事件类型 */
export type MCPEventType =
  | "message:received"    // 收到新消息
  | "message:sent"        // 消息已发送
  | "tool:called"         // 工具被调用
  | "tool:result"         // 工具返回结果
  | "session:created"     // 新会话创建
  | "session:ended"       // 会话结束
  | "permission:request"  // 权限请求
  | "error";              // 错误事件

/** 事件条目 */
export interface MCPEvent {
  /** 事件唯一 ID */
  id: string;
  /** 事件序列号（单调递增，用于游标） */
  seq: number;
  /** 事件类型 */
  type: MCPEventType;
  /** 事件数据 */
  data: Record<string, unknown>;
  /** 事件时间戳 */
  timestamp: Date;
}

/** 客户端游标 */
interface ClientCursor {
  /** 客户端 ID */
  clientId: string;
  /** 最后消费的序列号 */
  lastSeq: number;
  /** 最后活动时间 */
  lastActiveAt: Date;
}

/** EventBridge 配置 */
export interface EventBridgeConfig {
  /** 事件最大保留数量（默认 10000） */
  maxEvents?: number;
  /** 事件过期时间（毫秒，默认 1 小时） */
  eventTTL?: number;
  /** 客户端游标过期时间（毫秒，默认 10 分钟） */
  cursorTTL?: number;
  /** 清理间隔（毫秒，默认 60 秒） */
  cleanupInterval?: number;
}

/**
 * MCP 事件桥接。
 *
 * 在 MCP Server 和外部消费者之间传递事件。
 * 支持短轮询（poll）和长轮询（wait）两种消费模式。
 */
export class EventBridge {
  private events: MCPEvent[] = [];
  private cursors = new Map<string, ClientCursor>();
  private nextSeq = 1;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** 长轮询等待队列：resolve 函数列表 */
  private waiters: Array<{
    clientId: string;
    afterSeq: number;
    resolve: (events: MCPEvent[]) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private readonly maxEvents: number;
  private readonly eventTTL: number;
  private readonly cursorTTL: number;

  constructor(config: EventBridgeConfig = {}) {
    this.maxEvents = config.maxEvents ?? 10000;
    this.eventTTL = config.eventTTL ?? 60 * 60 * 1000;     // 1 小时
    this.cursorTTL = config.cursorTTL ?? 10 * 60 * 1000;    // 10 分钟
    const cleanupInterval = config.cleanupInterval ?? 60_000; // 60 秒

    // 启动后台清理
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupInterval);
  }

  /**
   * 发布一个事件。
   */
  emit(type: MCPEventType, data: Record<string, unknown>): MCPEvent {
    const event: MCPEvent = {
      id: uuid(),
      seq: this.nextSeq++,
      type,
      data,
      timestamp: new Date(),
    };

    this.events.push(event);

    // 超限时删除最旧事件
    while (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    // 唤醒所有等待此序列号之后事件的 waiter
    this.notifyWaiters();

    logger.debug({ eventId: event.id, type, seq: event.seq }, "事件已发布");
    return event;
  }

  /**
   * 短轮询 — 获取指定游标之后的所有事件。
   *
   * @param clientId - 客户端标识
   * @param afterSeq - 从此序列号之后开始（0 表示获取所有）
   * @param limit - 最大返回数量（默认 100）
   */
  poll(clientId: string, afterSeq?: number, limit = 100): MCPEvent[] {
    const cursor = this.getOrCreateCursor(clientId);
    const startSeq = afterSeq ?? cursor.lastSeq;

    const events = this.events
      .filter(e => e.seq > startSeq)
      .slice(0, limit);

    // 更新游标
    if (events.length > 0) {
      cursor.lastSeq = events[events.length - 1].seq;
    }
    cursor.lastActiveAt = new Date();

    return events;
  }

  /**
   * 长轮询 — 等待新事件或超时。
   *
   * @param clientId - 客户端标识
   * @param afterSeq - 从此序列号之后开始
   * @param timeoutMs - 超时时间（毫秒，默认 30000）
   * @param limit - 最大返回数量（默认 100）
   */
  async wait(
    clientId: string,
    afterSeq?: number,
    timeoutMs = 30_000,
    limit = 100,
  ): Promise<MCPEvent[]> {
    const cursor = this.getOrCreateCursor(clientId);
    const startSeq = afterSeq ?? cursor.lastSeq;

    // 先检查是否已有新事件
    const existing = this.events
      .filter(e => e.seq > startSeq)
      .slice(0, limit);

    if (existing.length > 0) {
      cursor.lastSeq = existing[existing.length - 1].seq;
      cursor.lastActiveAt = new Date();
      return existing;
    }

    // 没有新事件，挂起等待
    return new Promise<MCPEvent[]>(resolve => {
      const timer = setTimeout(() => {
        // 超时，返回空数组
        this.removeWaiter(clientId);
        resolve([]);
      }, timeoutMs);

      this.waiters.push({
        clientId,
        afterSeq: startSeq,
        resolve: (events) => {
          clearTimeout(timer);
          const limited = events.slice(0, limit);
          if (limited.length > 0) {
            cursor.lastSeq = limited[limited.length - 1].seq;
          }
          cursor.lastActiveAt = new Date();
          resolve(limited);
        },
        timer,
      });
    });
  }

  /**
   * 获取当前事件队列统计。
   */
  getStats(): {
    totalEvents: number;
    activeClients: number;
    waitingClients: number;
    oldestSeq: number;
    newestSeq: number;
  } {
    return {
      totalEvents: this.events.length,
      activeClients: this.cursors.size,
      waitingClients: this.waiters.length,
      oldestSeq: this.events[0]?.seq ?? 0,
      newestSeq: this.events[this.events.length - 1]?.seq ?? 0,
    };
  }

  /**
   * 关闭 EventBridge，清理所有资源。
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // 唤醒所有等待者
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.waiters = [];
    this.events = [];
    this.cursors.clear();
  }

  // ─── 内部方法 ──────────────────────────────

  private getOrCreateCursor(clientId: string): ClientCursor {
    let cursor = this.cursors.get(clientId);
    if (!cursor) {
      cursor = { clientId, lastSeq: 0, lastActiveAt: new Date() };
      this.cursors.set(clientId, cursor);
    }
    return cursor;
  }

  private notifyWaiters(): void {
    const toNotify = [...this.waiters];
    this.waiters = [];

    for (const waiter of toNotify) {
      const events = this.events.filter(e => e.seq > waiter.afterSeq);
      if (events.length > 0) {
        waiter.resolve(events);
      } else {
        // 放回等待队列
        this.waiters.push(waiter);
      }
    }
  }

  private removeWaiter(clientId: string): void {
    this.waiters = this.waiters.filter(w => {
      if (w.clientId === clientId) {
        clearTimeout(w.timer);
        return false;
      }
      return true;
    });
  }

  private cleanup(): void {
    const now = Date.now();

    // 清理过期事件
    const cutoff = now - this.eventTTL;
    const before = this.events.length;
    this.events = this.events.filter(e => e.timestamp.getTime() > cutoff);
    const removed = before - this.events.length;

    // 清理过期游标
    const cursorCutoff = now - this.cursorTTL;
    for (const [id, cursor] of this.cursors) {
      if (cursor.lastActiveAt.getTime() < cursorCutoff) {
        this.cursors.delete(id);
      }
    }

    if (removed > 0) {
      logger.debug({ removedEvents: removed, activeClients: this.cursors.size }, "过期事件已清理");
    }
  }
}
