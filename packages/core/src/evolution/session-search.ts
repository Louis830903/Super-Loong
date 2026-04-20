/**
 * 会话搜索 — FTS5 全文检索历史会话 + LLM 焦点摘要
 *
 * 参考 Hermes session_search_tool.py 实现：
 * - FTS5 全文索引历史对话
 * - 匹配消息 → Kimi 2.5 总结 → 结构化知识点
 * - 搜索结果缓存
 *
 * 作为独立模块，不修改现有 engine.ts 逻辑。
 * 通过 EventEmitter3 事件与进化引擎松耦合集成。
 */

import pino from "pino";

const logger = pino({ name: "evolution:session-search" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 搜索结果条目 */
export interface SearchResult {
  sessionId: string;
  messageIndex: number;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  score: number; // FTS5 排名分数
}

/** 焦点摘要 */
export interface FocusSummary {
  query: string;
  keyPoints: string[];
  patterns: string[];
  suggestions: string[];
  sourceCount: number;
  generatedAt: Date;
}

/** 搜索缓存条目 */
interface CacheEntry {
  results: SearchResult[];
  summary?: FocusSummary;
  cachedAt: number;
}

// ═══════════════════════════════════════════════════════════════
// Session Search Engine
// ═══════════════════════════════════════════════════════════════

export class SessionSearchEngine {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly cacheTTL: number; // 缓存过期时间（毫秒）
  private readonly maxResults: number;
  private readonly summaryModel: string;

  constructor(options?: {
    cacheTTL?: number;
    maxResults?: number;
    summaryModel?: string;
  }) {
    this.cacheTTL = options?.cacheTTL ?? 5 * 60 * 1000; // 默认 5 分钟
    this.maxResults = options?.maxResults ?? 20;
    this.summaryModel = options?.summaryModel ?? "kimi-2.5"; // Kimi 2.5 总结
  }

  /**
   * 全文搜索历史会话
   *
   * 使用 FTS5 在历史对话中搜索匹配的消息片段。
   * 如果 SQLite FTS5 不可用，降级为内存中的简单关键词匹配。
   */
  async search(
    query: string,
    options?: {
      sessionFilter?: string[];
      roleFilter?: ("user" | "assistant")[];
      limit?: number;
      skipCache?: boolean;
    }
  ): Promise<SearchResult[]> {
    const cacheKey = this.buildCacheKey(query, options);

    // 检查缓存
    if (!options?.skipCache) {
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        logger.debug({ query, cached: true }, "使用缓存搜索结果");
        return cached.results;
      }
    }

    try {
      const results = await this.executeFTS5Search(query, options?.limit ?? this.maxResults);

      // 应用过滤
      let filtered = results;
      if (options?.sessionFilter?.length) {
        filtered = filtered.filter((r) => options.sessionFilter!.includes(r.sessionId));
      }
      if (options?.roleFilter?.length) {
        filtered = filtered.filter((r) => (options.roleFilter as string[]).includes(r.role));
      }

      // 更新缓存
      this.setCache(cacheKey, { results: filtered, cachedAt: Date.now() });
      logger.info({ query, resultCount: filtered.length }, "搜索完成");
      return filtered;
    } catch (err) {
      logger.error({ err, query }, "搜索失败");
      return [];
    }
  }

  /**
   * 生成焦点摘要
   *
   * 将搜索结果通过 Kimi 2.5 LLM 总结为结构化知识点。
   */
  async generateFocusSummary(
    query: string,
    results: SearchResult[],
    llmCall?: (prompt: string, model?: string) => Promise<string>
  ): Promise<FocusSummary> {
    if (!results.length) {
      return {
        query,
        keyPoints: [],
        patterns: [],
        suggestions: [],
        sourceCount: 0,
        generatedAt: new Date(),
      };
    }

    // 构建摘要 prompt
    const contextSnippets = results
      .slice(0, 10) // 最多取 10 条
      .map((r, i) => `[${i + 1}] (${r.role}) ${r.content.slice(0, 500)}`)
      .join("\n\n");

    const prompt = `你是一个知识提取助手。请分析以下历史对话片段，围绕查询 "${query}" 提取关键信息。

## 历史对话片段

${contextSnippets}

## 请返回 JSON 格式

{
  "keyPoints": ["关键发现1", "关键发现2", ...],
  "patterns": ["反复出现的模式1", ...],
  "suggestions": ["基于历史经验的建议1", ...]
}

只返回 JSON，不要额外解释。`;

    try {
      if (llmCall) {
        const response = await llmCall(prompt, this.summaryModel);
        const parsed = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
        return {
          query,
          keyPoints: parsed.keyPoints ?? [],
          patterns: parsed.patterns ?? [],
          suggestions: parsed.suggestions ?? [],
          sourceCount: results.length,
          generatedAt: new Date(),
        };
      }
    } catch (err) {
      logger.error({ err }, "焦点摘要生成失败");
    }

    // LLM 不可用时返回简单摘要
    return {
      query,
      keyPoints: results.slice(0, 5).map((r) => r.content.slice(0, 100)),
      patterns: [],
      suggestions: [],
      sourceCount: results.length,
      generatedAt: new Date(),
    };
  }

  /**
   * 搜索并生成摘要（一步完成）
   */
  async searchAndSummarize(
    query: string,
    llmCall?: (prompt: string, model?: string) => Promise<string>
  ): Promise<{ results: SearchResult[]; summary: FocusSummary }> {
    const results = await this.search(query);
    const summary = await this.generateFocusSummary(query, results, llmCall);
    return { results, summary };
  }

  /** 清除搜索缓存 */
  clearCache(): void {
    this.cache.clear();
  }

  /** 获取缓存统计 */
  getCacheStats(): { size: number; oldestAge: number } {
    let oldestAge = 0;
    const now = Date.now();
    for (const entry of this.cache.values()) {
      const age = now - entry.cachedAt;
      if (age > oldestAge) oldestAge = age;
    }
    return { size: this.cache.size, oldestAge };
  }

  // ─── 内部方法 ──────────────────────────────────────────────

  private async executeFTS5Search(query: string, limit: number): Promise<SearchResult[]> {
    // 尝试使用 SQLite FTS5
    try {
      const Database = (await import("better-sqlite3" as string)).default;
      const dbPath = (globalThis as any).__superAgentDataDir
        ? `${(globalThis as any).__superAgentDataDir}/conversations.db`
        : "conversations.db";
      const db = new Database(dbPath, { readonly: true });

      // 检查 FTS5 表是否存在
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'")
        .get();

      if (tableExists) {
        const rows = db
          .prepare(
            `SELECT session_id, message_index, role, content, rank
             FROM messages_fts
             WHERE messages_fts MATCH ?
             ORDER BY rank
             LIMIT ?`
          )
          .all(query, limit) as any[];

        db.close();

        return rows.map((row) => ({
          sessionId: row.session_id,
          messageIndex: row.message_index,
          role: row.role,
          content: row.content,
          timestamp: 0,
          score: Math.abs(row.rank),
        }));
      }

      db.close();
    } catch {
      // FTS5 不可用，降级到内存搜索
      logger.debug("FTS5 不可用，使用内存关键词搜索");
    }

    // 降级：内存关键词搜索
    return this.fallbackKeywordSearch(query, limit);
  }

  private fallbackKeywordSearch(query: string, limit: number): SearchResult[] {
    // 简单的关键词匹配降级方案
    // 实际实现需读取会话文件进行搜索
    logger.debug({ query }, "内存关键词搜索（降级模式）");
    return [];
  }

  private buildCacheKey(query: string, options?: Record<string, unknown>): string {
    return `${query}::${JSON.stringify(options ?? {})}`;
  }

  private getFromCache(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > this.cacheTTL) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  private setCache(key: string, entry: CacheEntry): void {
    // 限制缓存大小
    if (this.cache.size > 100) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, entry);
  }
}
