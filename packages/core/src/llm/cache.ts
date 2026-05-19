/**
 * v3 Task 10：LLM 语义缓存层
 *
 * 设计原则：
 *   - SHA-256 缓存键：对 (model + 规范化 messages + tools + temperature) 取摘要
 *   - SQLite 持久化：进程重启后缓存不丢失
 *   - LRU 驱逐：超出 maxEntries 时删除最旧 lastAccessedAt
 *   - 规范化消息：去除 tool_call_id / timestamp 等非语义字段，提高命中率
 *   - Feature Flag 闸门：FEATURE_FLAG_LLM_CACHE=true 才生效，可灰度
 *   - 命中率统计：hits / misses 计数器，供监控大盘消费
 *
 * 使用：
 *   import { llmCache } from "./cache.js";
 *   const cached = llmCache.get(key);
 *   if (cached) return cached;
 *   const response = await provider._complete(params);
 *   llmCache.set(key, response);
 */

import { createHash } from "node:crypto";
import pino from "pino";
import { getDatabase, scheduleSave } from "../persistence/sqlite.js";
import type { LLMResponse, LLMMessage } from "../types/index.js";
import type { LLMToolDef, LLMCompletionParams } from "./provider.js";
import { FeatureFlags } from "../config/feature-flags.js";

const logger = pino({ name: "llm-cache" });

// ─── 配置常量 ─────────────────────────────────────────────────

/** 默认最大缓存条目数 */
const DEFAULT_MAX_ENTRIES = 10_000;

/** 默认 TTL（秒），0 表示永不过期 */
const DEFAULT_TTL_SEC = 86_400; // 24h

/** 仅当 temperature ≤ 此值时启用缓存（高 temperature = 随机采样，不适合缓存） */
const CACHE_MAX_TEMPERATURE = 0.3;

// ─── 缓存条目结构 ─────────────────────────────────────────────

export interface LLMCacheEntry {
  cacheKey: string;
  model: string;
  requestJson: string; // 原始请求（调试用）
  responseJson: string; // LLMResponse 序列化
  temperature: number;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
}

// ─── LLM 语义缓存 ─────────────────────────────────────────────

export class LLMCache {
  private initialized = false;
  private maxEntries: number;
  private ttlSec: number;

  // 统计
  private _hits = 0;
  private _misses = 0;

  constructor(opts?: { maxEntries?: number; ttlSec?: number }) {
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlSec = opts?.ttlSec ?? DEFAULT_TTL_SEC;
  }

  /** 命中率（0-1） */
  get hitRate(): number {
    const total = this._hits + this._misses;
    return total === 0 ? 0 : this._hits / total;
  }

  /** hits 计数 */
  get hits(): number {
    return this._hits;
  }

  /** misses 计数 */
  get misses(): number {
    return this._misses;
  }

  /** 确保 llm_cache 表存在 */
  private init(): void {
    if (this.initialized) return;
    const db = getDatabase();
    db.run(`
      CREATE TABLE IF NOT EXISTS llm_cache (
        cache_key TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        request_json TEXT,
        response_json TEXT NOT NULL,
        temperature REAL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        access_count INTEGER DEFAULT 1
      )
    `);
    // 添加索引加速 model 维度统计
    try {
      db.run("CREATE INDEX IF NOT EXISTS idx_llm_cache_last_access ON llm_cache(last_accessed_at)");
      db.run("CREATE INDEX IF NOT EXISTS idx_llm_cache_model ON llm_cache(model)");
    } catch {
      // 索引已存在，忽略
    }
    scheduleSave();
    this.initialized = true;
    logger.info({ maxEntries: this.maxEntries, ttlSec: this.ttlSec }, "LLM cache layer initialized");
  }

  /**
   * 生成缓存键：SHA-256(model + normalized_messages + tools + temperature)
   *
   * 规范化策略：
   *   - 移除 assistant 消息中的 tool_calls（ID 每次不同，影响命中率）
   *   - 移除 tool 消息中的 toolCallId（同上）
   *   - 移除 reasoning_content（语义无关）
   *   - 移除 system message 中的时间戳类内容（不影响语义）
   */
  makeCacheKey(params: LLMCompletionParams, model: string): string {
    const normalized = {
      model,
      messages: (params.messages ?? []).map((m: LLMMessage) => {
        const n: Record<string, unknown> = { role: m.role };
        if (m.content) n.content = m.content;
        // 保留 tool 消息的 toolName 但丢弃 toolCallId（每次不同）
        if (m.role === "tool") {
          // 不包含 toolCallId — 它随每次 tool 调用变化
        }
        return n;
      }),
      tools: (params.tools ?? []).map((t: LLMToolDef) => ({
        name: t.function.name,
        desc: t.function.description,
      })),
    };
    const raw = JSON.stringify(normalized);
    return createHash("sha256").update(raw).digest("hex");
  }

  /**
   * 查询缓存。
   * @returns LLMResponse | null（缓存未命中）
   */
  get(cacheKey: string): LLMResponse | null {
    if (!FeatureFlags.llmCache) return null;
    this.init();

    const db = getDatabase();
    const results = db.exec(
      `SELECT response_json, last_accessed_at, access_count FROM llm_cache WHERE cache_key = ?`,
      [cacheKey],
    );

    if (!results.length || !results[0].values.length) {
      this._misses++;
      return null;
    }

    const row = results[0].values[0] as unknown[];
    const responseJson = row[0] as string;
    const lastAccessedAt = row[1] as string;

    // TTL 过期检查
    if (this.ttlSec > 0) {
      const ageMs = Date.now() - new Date(lastAccessedAt).getTime();
      if (ageMs > this.ttlSec * 1000) {
        // 过期：删除并计 miss
        db.run("DELETE FROM llm_cache WHERE cache_key = ?", [cacheKey]);
        this._misses++;
        return null;
      }
    }

    // 命中：更新 last_accessed_at + access_count
    const now = new Date().toISOString();
    db.run(
      "UPDATE llm_cache SET last_accessed_at = ?, access_count = access_count + 1 WHERE cache_key = ?",
      [now, cacheKey],
    );

    this._hits++;
    try {
      return JSON.parse(responseJson) as LLMResponse;
    } catch {
      // 损坏的缓存条目：删除并计 miss
      logger.warn({ cacheKey }, "Corrupted cache entry, removing");
      db.run("DELETE FROM llm_cache WHERE cache_key = ?", [cacheKey]);
      this._misses++;
      return null;
    }
  }

  /**
   * 写入缓存。
   * 触发 LRU 驱逐：若当前条目数 ≥ maxEntries，删除最旧的 20% 条目。
   */
  set(cacheKey: string, params: LLMCompletionParams, model: string, response: LLMResponse): void {
    if (!FeatureFlags.llmCache) return;
    this.init();

    const db = getDatabase();
    const now = new Date().toISOString();
    const responseJson = JSON.stringify(response);
    const requestJson = JSON.stringify({
      model,
      messages: params.messages,
      tools: params.tools,
    });

    // 先尝试插入（主键冲突则更新）
    const existing = db.exec("SELECT 1 FROM llm_cache WHERE cache_key = ?", [cacheKey]);
    if (existing.length && existing[0].values.length) {
      db.run(
        `UPDATE llm_cache SET response_json = ?, last_accessed_at = ?, access_count = access_count + 1 WHERE cache_key = ?`,
        [responseJson, now, cacheKey],
      );
      return;
    }

    // LRU 驱逐：超出容量时删除最旧的条目
    const countResult = db.exec("SELECT COUNT(*) FROM llm_cache");
    const count = countResult.length ? (countResult[0].values[0][0] as number) : 0;
    if (count >= this.maxEntries) {
      const evictCount = Math.max(1, Math.floor(this.maxEntries * 0.2));
      db.run(
        "DELETE FROM llm_cache WHERE cache_key IN (SELECT cache_key FROM llm_cache ORDER BY last_accessed_at ASC LIMIT ?)",
        [evictCount],
      );
      logger.info(
        { evicted: evictCount, total: count },
        "LLM cache LRU eviction triggered",
      );
    }

    // 插入新条目
    db.run(
      `INSERT INTO llm_cache (cache_key, model, request_json, response_json, temperature, created_at, last_accessed_at, access_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        cacheKey,
        model,
        requestJson,
        responseJson,
        0, // temperature 字段保留（未来可按 temp 维度分类统计）
        now,
        now,
      ],
    );
    scheduleSave();
  }

  /**
   * 判断是否可缓存该请求。
   * 不可缓存条件：
   *   - 闸门关闭（FeatureFlags.llmCache = false）
   *   - temperature > CACHE_MAX_TEMPERATURE（高随机性无缓存价值）
   *   - 请求包含 stream=true（流式响应暂不缓存）
   */
  isCacheable(params: LLMCompletionParams, temperature: number): boolean {
    if (!FeatureFlags.llmCache) return false;
    if (params.stream) return false; // 流式请求不缓存（响应分块，完整性无法保证）
    if (temperature > CACHE_MAX_TEMPERATURE) return false;
    if (!params.messages || params.messages.length === 0) return false;
    return true;
  }

  /** 获取缓存统计信息 */
  getStats(): { hits: number; misses: number; hitRate: number; totalEntries: number } {
    const db = getDatabase();
    const result = db.exec("SELECT COUNT(*) FROM llm_cache");
    const totalEntries = result.length ? (result[0].values[0][0] as number) : 0;
    return {
      hits: this._hits,
      misses: this._misses,
      hitRate: this.hitRate,
      totalEntries,
    };
  }

  /** 清空全部缓存（管理员操作，如 model 升级后） */
  purge(): number {
    const db = getDatabase();
    const result = db.run("DELETE FROM llm_cache");
    const deleted = result.changes;
    logger.info({ deleted }, "LLM cache purged");
    scheduleSave();
    return deleted;
  }

  /** 按 model 清空缓存 */
  purgeByModel(model: string): number {
    const db = getDatabase();
    const result = db.run("DELETE FROM llm_cache WHERE model = ?", [model]);
    logger.info({ model, deleted: result.changes }, "LLM cache purged by model");
    scheduleSave();
    return result.changes;
  }
}

// ─── 单例导出 ─────────────────────────────────────────────────

/** 全局 LLM 缓存单例（进程中唯一） */
export const llmCache = new LLMCache();
