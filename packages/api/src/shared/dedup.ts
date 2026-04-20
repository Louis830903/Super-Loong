/**
 * 传输层无关的请求去重缓存（借鉴 OpenClaw 架构设计）
 *
 * 所有入口（HTTP /api/chat、WS /ws/gateway）共用同一个 DedupCache 实例，
 * 确保 requestId 幂等性去重跨传输层生效。
 *
 * 设计参考：
 * - OpenClaw persistent-dedupe.ts：去重层与传输层完全解耦
 * - Hermes MessageDeduplicator：TTL + LRU 统一入口 is_duplicate()
 */

import pino from "pino";

const logger = pino({ name: "dedup" });

/** 哨兵值：标识 requestId 已被处理但无缓存响应（用于 WS 流式场景） */
export const SEEN_NO_RESPONSE = "__SEEN_NO_RESPONSE__" as const;

export interface DedupCacheOptions {
  /** 缓存过期时间（毫秒），默认 60s */
  ttlMs?: number;
  /** 最大缓存条目数，超出时强制清理过期条目，默认 5000 */
  maxSize?: number;
  /** 清理间隔（毫秒），默认 30s */
  cleanupIntervalMs?: number;
}

export interface DedupCache {
  /** 检查 requestId 是否重复。若重复返回缓存值（或 SEEN_NO_RESPONSE），否则返回 undefined */
  check(requestId: string): unknown | undefined;
  /** 记录 requestId 及其响应（供后续重复检查使用） */
  record(requestId: string, response: unknown): void;
  /** 仅标记为已处理（无缓存响应，用于 WS 等流式场景） */
  markSeen(requestId: string): void;
  /** 是否已见过（不论是否有缓存响应） */
  isSeen(requestId: string): boolean;
  /** 销毁定时器并清空缓存 */
  destroy(): void;
}

/**
 * 创建传输层无关的去重缓存
 *
 * 所有入口（HTTP /api/chat、WS /ws/gateway）共用同一个 DedupCache 实例，
 * 确保 requestId 去重跨传输生效。WS→HTTP 降级场景下同一 requestId 可被识别。
 */
export function createDedupCache(opts: DedupCacheOptions = {}): DedupCache {
  const ttlMs = opts.ttlMs ?? 60_000;
  const maxSize = opts.maxSize ?? 5000;
  const cleanupIntervalMs = opts.cleanupIntervalMs ?? 30_000;

  // requestId → { response(null 表示仅标记已见), expiry }
  const cache = new Map<string, { response: unknown | null; expiry: number }>();

  // 定期清理过期条目
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now > entry.expiry) cache.delete(key);
    }
  }, cleanupIntervalMs);
  // 确保不阻止进程退出
  if (cleanup.unref) cleanup.unref();

  return {
    check(requestId: string): unknown | undefined {
      if (!requestId) return undefined;
      const entry = cache.get(requestId);
      if (!entry) return undefined;
      if (Date.now() > entry.expiry) {
        cache.delete(requestId);
        return undefined;
      }
      logger.info({ requestId }, "Dedup hit");
      // 若有缓存响应则返回，否则返回哨兵值
      return entry.response ?? SEEN_NO_RESPONSE;
    },

    record(requestId: string, response: unknown): void {
      if (!requestId) return;
      cache.set(requestId, { response, expiry: Date.now() + ttlMs });
      // 超限时强制清理过期条目
      if (cache.size > maxSize) {
        const now = Date.now();
        for (const [k, v] of cache) {
          if (now > v.expiry) cache.delete(k);
        }
      }
    },

    markSeen(requestId: string): void {
      if (!requestId) return;
      cache.set(requestId, { response: null, expiry: Date.now() + ttlMs });
    },

    isSeen(requestId: string): boolean {
      if (!requestId) return false;
      const entry = cache.get(requestId);
      if (!entry) return false;
      if (Date.now() > entry.expiry) {
        cache.delete(requestId);
        return false;
      }
      return true;
    },

    destroy(): void {
      clearInterval(cleanup);
      cache.clear();
    },
  };
}
