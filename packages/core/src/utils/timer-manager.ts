/**
 * 定时器统一清理机制 — 防止内存泄漏
 *
 * 优化：
 * 1. 命名空间隔离
 * 2. 过期自动清理
 * 3. 统计信息
 */

import pino from "pino";

const logger = pino({ name: "timer-manager" });

interface TimerEntry {
  id: string;
  type: "timeout" | "interval";
  handle: NodeJS.Timeout;
  createdAt: number;
  namespace: string;
  description?: string;
}

class TimerManager {
  private timers: Map<string, TimerEntry> = new Map();
  private namespaces: Map<string, Set<string>> = new Map();
  private maxAge: number = 3600000; // 1 小时过期
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // 每 10 分钟清理过期定时器
    this.cleanupInterval = setInterval(() => this.cleanup(), 600000);
  }

  /**
   * 创建定时器
   */
  setTimeout(
    namespace: string,
    id: string,
    fn: () => void,
    delay: number,
    description?: string,
  ): string {
    const key = `${namespace}:${id}`;
    this.clear(key);

    const handle = setTimeout(() => {
      this.timers.delete(key);
      this.removeFromNamespace(namespace, key);
      fn();
    }, delay);

    this.timers.set(key, {
      id: key,
      type: "timeout",
      handle,
      createdAt: Date.now(),
      namespace,
      description,
    });

    this.addToNamespace(namespace, key);
    logger.debug({ key, delay, description }, "Timer created");
    return key;
  }

  /**
   * 创建间隔定时器
   */
  setInterval(
    namespace: string,
    id: string,
    fn: () => void,
    interval: number,
    description?: string,
  ): string {
    const key = `${namespace}:${id}`;
    this.clear(key);

    const handle = setInterval(fn, interval);

    this.timers.set(key, {
      id: key,
      type: "interval",
      handle,
      createdAt: Date.now(),
      namespace,
      description,
    });

    this.addToNamespace(namespace, key);
    logger.debug({ key, interval, description }, "Interval created");
    return key;
  }

  /**
   * 清除定时器
   */
  clear(key: string): boolean {
    const entry = this.timers.get(key);
    if (!entry) return false;

    if (entry.type === "timeout") {
      clearTimeout(entry.handle);
    } else {
      clearInterval(entry.handle);
    }

    this.timers.delete(key);
    this.removeFromNamespace(entry.namespace, key);
    logger.debug({ key }, "Timer cleared");
    return true;
  }

  /**
   * 清除命名空间下所有定时器
   */
  clearNamespace(namespace: string): number {
    const keys = this.namespaces.get(namespace);
    if (!keys) return 0;

    let count = 0;
    for (const key of keys) {
      if (this.clear(key)) count++;
    }

    this.namespaces.delete(namespace);
    logger.info({ namespace, count }, "Namespace cleared");
    return count;
  }

  /**
   * 清理过期定时器
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.timers) {
      if (now - entry.createdAt > this.maxAge) {
        this.clear(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, "Expired timers cleaned");
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    total: number;
    byNamespace: Record<string, number>;
    byType: Record<string, number>;
  } {
    const byNamespace: Record<string, number> = {};
    const byType: Record<string, number> = { timeout: 0, interval: 0 };

    for (const entry of this.timers.values()) {
      byNamespace[entry.namespace] = (byNamespace[entry.namespace] ?? 0) + 1;
      byType[entry.type]++;
    }

    return {
      total: this.timers.size,
      byNamespace,
      byType,
    };
  }

  /**
   * 清除所有定时器
   */
  clearAll(): void {
    for (const key of this.timers.keys()) {
      this.clear(key);
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    logger.info("All timers cleared");
  }

  private addToNamespace(namespace: string, key: string): void {
    if (!this.namespaces.has(namespace)) {
      this.namespaces.set(namespace, new Set());
    }
    this.namespaces.get(namespace)!.add(key);
  }

  private removeFromNamespace(namespace: string, key: string): void {
    this.namespaces.get(namespace)?.delete(key);
  }
}

// 全局单例
export const timerManager = new TimerManager();

// 进程退出时清理
process.on("SIGTERM", () => timerManager.clearAll());
process.on("SIGINT", () => timerManager.clearAll());
