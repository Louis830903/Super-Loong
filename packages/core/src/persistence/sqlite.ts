/**
 * SQLite Persistence Layer (门面层 + 业务段过渡态).
 *
 * CORE-P1-02 批 1 已完成：基础设施层（logger/constants/schema/migrations/client）
 * 已拆分至 ./sqlite/ 子目录；此文件保留业务段（SQLiteBackend / Conversations /
 * FTS / 各 repo CRUD），待批 2/3 进一步拆分为独立 repo 文件。
 *
 * 上游 25+ 处 `from "../persistence/sqlite.js"` 通过 `export * from "./sqlite/index.js"`
 * 桶导出继续拿到基础设施层符号；业务段符号由本文件直接 export。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export * from "./sqlite/index.js";
import { getContentText } from "../utils/content-helpers.js";
import type { MemoryEntry, MemorySearchResult } from "../types/index.js";
import type { MemoryBackend, MemoryFilter } from "../memory/manager.js";
import type { EntityRow } from "../memory/entity-resolver.js";
import { getJsonlWriter } from "./jsonl-writer.js";
import { logger } from "./sqlite/logger.js";
import { getDatabase, scheduleSave } from "./sqlite/client.js";

// ─── SQLiteBackend: MemoryBackend Implementation ────────────

export class SQLiteBackend implements MemoryBackend {
  private get db() {
    return getDatabase();
  }

  async add(entry: MemoryEntry): Promise<void> {
    // F-2: HRR 用 Float64 存储（保持相位精度），其他用 Float32（节省空间）
    let embBlob: Buffer | null = null;
    if (entry.embedding) {
      if (entry.embeddingType === "hrr") {
        embBlob = Buffer.from(new Float64Array(entry.embedding).buffer);
      } else {
        embBlob = Buffer.from(new Float32Array(entry.embedding).buffer);
      }
    }
    this.db.run(
      `INSERT OR REPLACE INTO memories (id, agentId, userId, content, type, embedding, metadata, createdAt, updatedAt, trust_score, helpful_count, retrieval_count, embedding_type, priority, relevanceScore)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.agentId,
        entry.userId ?? null,
        entry.content,
        entry.type,
        embBlob,
        JSON.stringify(entry.metadata),
        entry.createdAt.toISOString(),
        entry.updatedAt.toISOString(),
        entry.trustScore ?? 0.5,
        entry.helpfulCount ?? 0,
        entry.retrievalCount ?? 0,
        entry.embeddingType ?? "simple",
        // ✨ T1: 业务优先级（默认 normal，配合 PRIORITY_BOOST 加权）
        entry.priority ?? "normal",
        // ✨ T1: 相关性预留字段（与 trustScore 解耦）
        entry.relevanceScore ?? 0.5,
      ]
    );
    scheduleSave();
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const stmt = this.db.prepare("SELECT * FROM memories WHERE id = ?");
    stmt.bind([id]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return this.rowToEntry(row);
    }
    stmt.free();
    return null;
  }

  async update(id: string, updates: Partial<Pick<MemoryEntry, "content" | "metadata" | "embedding" | "trustScore" | "helpfulCount" | "retrievalCount" | "priority" | "relevanceScore">>): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Memory ${id} not found`);

    const sets: string[] = ["updatedAt = ?"];
    const params: unknown[] = [new Date().toISOString()];

    if (updates.content !== undefined) {
      sets.push("content = ?");
      params.push(updates.content);
    }
    if (updates.metadata !== undefined) {
      sets.push("metadata = ?");
      params.push(JSON.stringify({ ...existing.metadata, ...updates.metadata }));
    }
    if (updates.embedding !== undefined) {
      sets.push("embedding = ?");
      // F-2: HRR 用 Float64，其他用 Float32
      if (updates.embedding) {
        // 读取当前记忆的 embeddingType 决定存储格式
        const isHRR = existing.embeddingType === "hrr";
        params.push(Buffer.from(
          isHRR ? new Float64Array(updates.embedding).buffer : new Float32Array(updates.embedding).buffer
        ));
      } else {
        params.push(null);
      }
    }
    // C-1: 信任评分字段直写专属列
    if (updates.trustScore !== undefined) {
      sets.push("trust_score = ?");
      params.push(updates.trustScore);
    }
    if (updates.helpfulCount !== undefined) {
      sets.push("helpful_count = ?");
      params.push(updates.helpfulCount);
    }
    if (updates.retrievalCount !== undefined) {
      sets.push("retrieval_count = ?");
      params.push(updates.retrievalCount);
    }
    // ✨ T1: 优先级与相关性写入
    if (updates.priority !== undefined) {
      sets.push("priority = ?");
      params.push(updates.priority);
    }
    if (updates.relevanceScore !== undefined) {
      sets.push("relevanceScore = ?");
      params.push(updates.relevanceScore);
    }

    params.push(id);
    this.db.run(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`, params as any[]);
    scheduleSave();
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    this.db.run("DELETE FROM memories WHERE id = ?", [id]);
    scheduleSave();
    return true;
  }

  async list(filters: MemoryFilter): Promise<MemoryEntry[]> {
    const { where, params } = this.buildWhere(filters);
    const sql = `SELECT * FROM memories${where} ORDER BY createdAt DESC`;
    const results = this.db.exec(sql, params);
    if (!results.length) return [];
    return this.resultToEntries(results[0]);
  }

  async search(query: string, filters: MemoryFilter, topK: number): Promise<MemorySearchResult[]> {
    // P0-1: FTS5 优先搜索（BM25 排序，O(log N)），LIKE 兜底
    if (hasFTS5()) {
      try {
        const ftsResults = this.searchViaFTS5(query, filters, topK);
        if (ftsResults.length > 0) return ftsResults;
      } catch { /* FTS5 查询异常，fallback 到 LIKE */ }
    }

    // Fallback: 全表遍历 + JS 层关键词匹配（原有逻辑，保持不变）
    const candidates = await this.list(filters);
    const queryLower = query.toLowerCase();
    const words = queryLower.split(/\W+/).filter(Boolean);

    const scored: MemorySearchResult[] = candidates.map((entry) => {
      const contentLower = entry.content.toLowerCase();
      let hits = 0;
      for (const w of words) {
        if (contentLower.includes(w)) hits++;
      }
      const textScore = words.length > 0 ? hits / words.length : 0;
      return { entry, score: textScore };
    });

    return scored
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * P0-1: FTS5 搜索内部方法。
   * BUG-2 修复：优先使用 v6 内容同步表（rowid JOIN，更规范），兼容回退旧表（id JOIN）。
   * 安全处理：双引号转义 + 短语包裹，防止 FTS5 语法注入。
   */
  private searchViaFTS5(query: string, filters: MemoryFilter, topK: number): MemorySearchResult[] {
    const safeQuery = '"' + query.replace(/"/g, '""') + '"';

    // BUG-2: 优先使用 v6 内容同步表（rowid 关联，标准 FTS5 维护模式）
    const useV6 = hasFTS5v6();
    let sql: string;
    if (useV6) {
      sql = `
        SELECT m.* FROM memories m
        JOIN memories_fts_v6 f ON m.rowid = f.rowid
        WHERE f.memories_fts_v6 MATCH ?
      `;
    } else {
      sql = `
        SELECT m.* FROM memories m
        JOIN memories_fts f ON m.id = f.id
        WHERE f.memories_fts MATCH ?
      `;
    }
    const params: unknown[] = [safeQuery];

    if (filters.agentId) { sql += " AND m.agentId = ?"; params.push(filters.agentId); }
    if (filters.userId) { sql += " AND m.userId = ?"; params.push(filters.userId); }
    if (filters.type) { sql += " AND m.type = ?"; params.push(filters.type); }

    sql += " ORDER BY f.rank LIMIT ?";
    params.push(topK);

    const results = this.db.exec(sql, params);
    if (!results.length) return [];

    // 利用已有的 resultToEntries 反序列化完整 MemoryEntry
    // ISSUE-6: 用位置倒数近似 BM25 权重（比固定 1.0 更有信息量）
    return this.resultToEntries(results[0]).map((entry, i) => ({
      entry,
      score: 1.0 / (1 + i),
    }));
  }

  async count(filters: MemoryFilter): Promise<number> {
    const { where, params } = this.buildWhere(filters);
    const results = this.db.exec(`SELECT COUNT(*) as cnt FROM memories${where}`, params);
    if (!results.length || !results[0].values.length) return 0;
    return results[0].values[0][0] as number;
  }

  async clear(filters: MemoryFilter): Promise<number> {
    const count = await this.count(filters);
    const { where, params } = this.buildWhere(filters);
    this.db.run(`DELETE FROM memories${where}`, params);
    scheduleSave();
    return count;
  }

  // ─── Helpers ──────────────────────────────────────────────

  private buildWhere(filters: MemoryFilter): { where: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.agentId) {
      conditions.push("agentId = ?");
      params.push(filters.agentId);
    }
    if (filters.userId) {
      conditions.push("userId = ?");
      params.push(filters.userId);
    }
    if (filters.type) {
      conditions.push("type = ?");
      params.push(filters.type);
    }
    // P2-02: Support metadata filtering via JSON key matching
    if (filters.metadata) {
      for (const [key, value] of Object.entries(filters.metadata)) {
        conditions.push(`json_extract(metadata, '$.' || ?) = ?`);
        params.push(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }

    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    return { where, params };
  }

  private rowToEntry(row: Record<string, unknown>): MemoryEntry {
    // F-2: 根据 embedding_type 列决定反序列化格式
    const embType = (row.embedding_type as string) || "simple";
    let embedding: number[] | undefined;
    if (row.embedding && row.embedding instanceof Uint8Array) {
      // P0-01 fix: Copy to aligned buffer to avoid Float32Array alignment crash.
      const aligned = new ArrayBuffer(row.embedding.byteLength);
      new Uint8Array(aligned).set(row.embedding);
      if (embType === "hrr") {
        // HRR 存储为 Float64（8 bytes per element）
        const float64 = new Float64Array(aligned);
        embedding = Array.from(float64);
      } else {
        // Qwen/Simple 存储为 Float32（4 bytes per element）
        const float32 = new Float32Array(aligned);
        embedding = Array.from(float32);
      }
    }

    return {
      id: row.id as string,
      agentId: row.agentId as string,
      userId: (row.userId as string) || undefined,
      content: row.content as string,
      type: row.type as MemoryEntry["type"],
      embedding,
      embeddingType: embType as MemoryEntry["embeddingType"],
      metadata: JSON.parse((row.metadata as string) || "{}"),
      createdAt: new Date(row.createdAt as string),
      updatedAt: new Date(row.updatedAt as string),
      // C-1: 信任评分字段（学 Hermes trust scoring）
      trustScore: (row.trust_score as number) ?? 0.5,
      helpfulCount: (row.helpful_count as number) ?? 0,
      retrievalCount: (row.retrieval_count as number) ?? 0,
      // ✨ T1: 业务优先级与相关性预留
      priority: ((row.priority as string) ?? "normal") as MemoryEntry["priority"],
      relevanceScore: (row.relevanceScore as number) ?? 0.5,
    };
  }

  private resultToEntries(result: { columns: string[]; values: unknown[][] }): MemoryEntry[] {
    return result.values.map((vals: unknown[]) => {
      const row: Record<string, unknown> = {};
      result.columns.forEach((col: string, i: number) => {
        row[col] = vals[i];
      });
      return this.rowToEntry(row);
    });
  }

  // ─── H-1: 实体解析 CRUD（学 Hermes entities/fact_entities） ──

  /** 按名称精确查找实体 */
  findEntity(name: string): EntityRow | null {
    const stmt = this.db.prepare("SELECT * FROM entities WHERE name = ? COLLATE NOCASE");
    stmt.bind([name]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return this.rowToEntityRow(row);
    }
    stmt.free();
    return null;
  }

  /** 按别名查找实体（搜索 aliases JSON 数组） */
  findEntityByAlias(alias: string): EntityRow | null {
    // aliases 存储为 JSON 数组字符串，使用 LIKE 粗筛 + 精确匹配
    const results = this.db.exec(
      `SELECT * FROM entities WHERE aliases LIKE ?`,
      [`%${alias}%`]
    );
    if (!results.length || !results[0].values.length) return null;
    // 精确检查 JSON 数组内容
    for (const vals of results[0].values) {
      const row: Record<string, unknown> = {};
      results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
      const entity = this.rowToEntityRow(row);
      if (entity.aliases.some((a: string) => a.toLowerCase() === alias.toLowerCase())) {
        return entity;
      }
    }
    return null;
  }

  /** 创建新实体 */
  createEntity(name: string, entityType = "unknown"): EntityRow {
    this.db.run(
      "INSERT INTO entities (name, entityType, aliases, createdAt) VALUES (?, ?, ?, ?)",
      [name, entityType, "[]", new Date().toISOString()]
    );
    scheduleSave();
    // 获取刚插入的实体
    return this.findEntity(name)!;
  }

  /** 为实体添加别名 */
  addAlias(entityId: number, alias: string): void {
    const stmt = this.db.prepare("SELECT aliases FROM entities WHERE id = ?");
    stmt.bind([entityId]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      const aliases: string[] = JSON.parse((row.aliases as string) || "[]");
      if (!aliases.includes(alias)) {
        aliases.push(alias);
        this.db.run("UPDATE entities SET aliases = ? WHERE id = ?", [JSON.stringify(aliases), entityId]);
        scheduleSave();
      }
    }
    stmt.free();
  }

  /** 建立记忆-实体关联 */
  linkMemoryEntity(memoryId: string, entityId: number): void {
    this.db.run(
      "INSERT OR IGNORE INTO memory_entities (memoryId, entityId) VALUES (?, ?)",
      [memoryId, entityId]
    );
    scheduleSave();
  }

  /** 获取记忆关联的所有实体 */
  getMemoryEntities(memoryId: string): EntityRow[] {
    const results = this.db.exec(
      `SELECT e.* FROM entities e
       JOIN memory_entities me ON me.entityId = e.id
       WHERE me.memoryId = ?`,
      [memoryId]
    );
    if (!results.length) return [];
    return results[0].values.map((vals: unknown[]) => {
      const row: Record<string, unknown> = {};
      results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
      return this.rowToEntityRow(row);
    });
  }

  /** 获取实体关联的所有记忆 */
  getEntityMemories(entityId: number): MemoryEntry[] {
    const results = this.db.exec(
      `SELECT m.* FROM memories m
       JOIN memory_entities me ON me.memoryId = m.id
       WHERE me.entityId = ?`,
      [entityId]
    );
    if (!results.length) return [];
    return this.resultToEntries(results[0]);
  }

  /** 解析实体行 */
  private rowToEntityRow(row: Record<string, unknown>): EntityRow {
    return {
      id: row.id as number,
      name: row.name as string,
      entityType: (row.entityType as string) || "unknown",
      aliases: JSON.parse((row.aliases as string) || "[]"),
      createdAt: row.createdAt as string,
    };
  }
}

/** 实体行类型（从 entity-resolver 重导出） */
export type { EntityRow };

// ─── Core Blocks / Audit Log Persistence ────────────────────
// 已迁移至 persistence/sqlite/{core-block-repo,audit-repo}.ts（批 2b）
// 通过 sqlite/index.ts 桶导出提供向后兼容的公开 API。
// 说明：SENSITIVE_KEYS / SENSITIVE_SUFFIXES 就近声明在 audit-repo.ts 内 file-private，
//       constants.ts 保持零依赖纯净（符合低耦合原则）。

// ─── Agent Config / Session Persistence ─────────────────────
// 已迁移至 persistence/sqlite/{agent-config-repo,session-repo}.ts（批 2c）
// 说明：session-repo 仅负责 sessions 表 CRUD，与 FTS 解耦；
//       indexSessionFTS / searchSessionsFTS 在批 3 fts-repo 中处理。

// ─── FTS5 Full-Text Search ──────────────────────────────────

/** P2-1: hasFTS5() 结果缓存 — 避免每次调用都查 sqlite_master */
let _fts5Cache: boolean | null = null;

/** Check if FTS5 tables are available (cached after first check) */
// BUG-2 修复：统一检查 v6 表（内容同步表，更规范的 FTS5 维护模式）
function hasFTS5(): boolean {
  if (_fts5Cache !== null) return _fts5Cache;
  try {
    const db = getDatabase();
    // 优先检查 v6 表，兼容回退到旧表
    const rv6 = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts_v6'");
    if (rv6.length > 0 && rv6[0].values.length > 0) {
      _fts5Cache = true;
      return true;
    }
    const r = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'");
    _fts5Cache = r.length > 0 && r[0].values.length > 0;
  } catch { _fts5Cache = false; }
  return _fts5Cache;
}

/** 检查是否有 v6 版内容同步 FTS5 表（用于选择 JOIN 策略） */
function hasFTS5v6(): boolean {
  try {
    const db = getDatabase();
    const r = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts_v6'");
    return r.length > 0 && r[0].values.length > 0;
  } catch { return false; }
}

/** Index a memory entry into the FTS5 table */
export function indexMemoryFTS(entry: { id: string; agentId: string; content: string; type: string }): void {
  if (!hasFTS5()) return;
  try {
    const db = getDatabase();
    db.run("INSERT OR REPLACE INTO memories_fts (id, agentId, content, type) VALUES (?, ?, ?, ?)",
      [entry.id, entry.agentId, entry.content, entry.type]);
  } catch { /* FTS5 not available */ }
}

/** Remove a memory entry from the FTS5 index */
export function removeMemoryFTS(id: string): void {
  if (!hasFTS5()) return;
  try {
    const db = getDatabase();
    db.run("DELETE FROM memories_fts WHERE id = ?", [id]);
  } catch { /* ignore */ }
}

/** Full-text search memories using FTS5 (falls back to LIKE if FTS5 unavailable) */
export function searchMemoriesFTS(
  query: string,
  options?: { agentId?: string; type?: string; limit?: number },
): Array<{ id: string; agentId: string; content: string; type: string; rank: number }> {
  const db = getDatabase();
  const limit = options?.limit ?? 50;

  if (hasFTS5()) {
    try {
      // P0-A8: FTS5 查询注入防护—双引号转义后包裹
      const safeQuery = '"' + query.replace(/"/g, '""') + '"';
      let sql = `SELECT id, agentId, content, type, rank FROM memories_fts WHERE memories_fts MATCH ?`;
      const params: unknown[] = [safeQuery];
      if (options?.agentId) { sql += " AND agentId = ?"; params.push(options.agentId); }
      if (options?.type) { sql += " AND type = ?"; params.push(options.type); }
      sql += " ORDER BY rank LIMIT ?";
      params.push(limit);
      const results = db.exec(sql, params);
      if (!results.length) return [];
      return results[0].values.map((vals: unknown[]) => ({
        id: vals[0] as string,
        agentId: vals[1] as string,
        content: vals[2] as string,
        type: vals[3] as string,
        rank: vals[4] as number,
      }));
    } catch { /* fall through to LIKE */ }
  }

  // Fallback: LIKE-based search
  let sql = "SELECT id, agentId, content, type FROM memories WHERE content LIKE ?";
  const params: unknown[] = [`%${query}%`];
  if (options?.agentId) { sql += " AND agentId = ?"; params.push(options.agentId); }
  if (options?.type) { sql += " AND type = ?"; params.push(options.type); }
  sql += " ORDER BY updatedAt DESC LIMIT ?";
  params.push(limit);
  const results = db.exec(sql, params);
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => ({
    id: vals[0] as string,
    agentId: vals[1] as string,
    content: vals[2] as string,
    type: vals[3] as string,
    rank: 0,
  }));
}

/** Index session messages into FTS5 for cross-session search */
export function indexSessionFTS(sessionId: string, agentId: string, messages: Array<{ role: string; content: string }>): void {
  if (!hasFTS5()) return;
  try {
    const db = getDatabase();
    // Remove old entries for this session
    db.run("DELETE FROM sessions_fts WHERE sessionId = ?", [sessionId]);
    // Index each user/assistant message
    for (const msg of messages) {
      if (msg.role === "user" || msg.role === "assistant") {
        db.run("INSERT INTO sessions_fts (sessionId, agentId, content) VALUES (?, ?, ?)",
          [sessionId, agentId, getContentText(msg.content)]);
      }
    }
  } catch { /* ignore */ }
}

/** Full-text search across sessions */
export function searchSessionsFTS(
  query: string,
  options?: { agentId?: string; limit?: number },
): Array<{ sessionId: string; agentId: string; content: string; rank: number }> {
  const db = getDatabase();
  const limit = options?.limit ?? 50;

  if (hasFTS5()) {
    try {
      // P0-A8: FTS5 查询注入防护
      const safeQuery = '"' + query.replace(/"/g, '""') + '"';
      let sql = `SELECT sessionId, agentId, content, rank FROM sessions_fts WHERE sessions_fts MATCH ?`;
      const params: unknown[] = [safeQuery];
      if (options?.agentId) { sql += " AND agentId = ?"; params.push(options.agentId); }
      sql += " ORDER BY rank LIMIT ?";
      params.push(limit);
      const results = db.exec(sql, params);
      if (!results.length) return [];
      return results[0].values.map((vals: unknown[]) => ({
        sessionId: vals[0] as string,
        agentId: vals[1] as string,
        content: vals[2] as string,
        rank: vals[3] as number,
      }));
    } catch { /* fall through */ }
  }

  // Fallback: search session messages via JSON content
  let sql = "SELECT id, agentId, messages FROM sessions WHERE messages LIKE ?";
  const params: unknown[] = [`%${query}%`];
  if (options?.agentId) { sql += " AND agentId = ?"; params.push(options.agentId); }
  sql += " LIMIT ?";
  params.push(limit);
  const results = db.exec(sql, params);
  if (!results.length) return [];
  const hits: Array<{ sessionId: string; agentId: string; content: string; rank: number }> = [];
  for (const vals of results[0].values) {
    const msgs = JSON.parse(vals[2] as string) as Array<{ role: string; content: string }>;
    for (const m of msgs) {
      if ((m.role === "user" || m.role === "assistant") && getContentText(m.content).toLowerCase().includes(query.toLowerCase())) {
        hits.push({ sessionId: vals[0] as string, agentId: vals[1] as string, content: getContentText(m.content), rank: 0 });
      }
    }
  }
  return hits.slice(0, limit);
}

// ─── Conversation Persistence ────────────────────────────────

export interface ConversationRecord {
  id: string;
  agentId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
  lastMessageRole: string | null;
  modelOverride: string | null;
}

export interface ConvMessageRecord {
  id: number;
  conversationId: string;
  role: string;
  content: string | null;
  toolCallId: string | null;
  toolCalls: string | null;
  toolName: string | null;
  timestamp: string;
  tokenCount: number | null;
}

/** Create a new conversation */
export function createConversation(id: string, agentId: string, title?: string, modelOverride?: string): ConversationRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO conversations (id, agentId, title, createdAt, updatedAt, modelOverride) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, agentId, title ?? null, now, now, modelOverride ?? null],
  );
  scheduleSave();
  const record: ConversationRecord = { id, agentId, title: title ?? null, createdAt: now, updatedAt: now, messageCount: 0, lastMessagePreview: null, lastMessageRole: null, modelOverride: modelOverride ?? null };

  // JSONL dual-write: update session index
  try {
    getJsonlWriter().updateIndex(id, { agentId, title: title ?? null, model: modelOverride ?? null, createdAt: now });
  } catch { /* best-effort */ }

  return record;
}

/** Get a conversation by ID */
export function getConversation(id: string): ConversationRecord | null {
  const db = getDatabase();
  const results = db.exec(
    "SELECT id, agentId, title, createdAt, updatedAt, messageCount, lastMessagePreview, lastMessageRole, modelOverride FROM conversations WHERE id = ?",
    [id],
  );
  if (!results.length || !results[0].values.length) return null;
  const v = results[0].values[0];
  return {
    id: v[0] as string, agentId: v[1] as string, title: v[2] as string | null,
    createdAt: v[3] as string, updatedAt: v[4] as string,
    messageCount: (v[5] as number) ?? 0, lastMessagePreview: v[6] as string | null,
    lastMessageRole: v[7] as string | null, modelOverride: v[8] as string | null,
  };
}

/** List conversations for an agent, ordered by updatedAt DESC */
export function listConversations(agentId: string): ConversationRecord[] {
  const db = getDatabase();
  const results = db.exec(
    "SELECT id, agentId, title, createdAt, updatedAt, messageCount, lastMessagePreview, lastMessageRole, modelOverride FROM conversations WHERE agentId = ? ORDER BY updatedAt DESC",
    [agentId],
  );
  if (!results.length) return [];
  return results[0].values.map((v: unknown[]) => ({
    id: v[0] as string, agentId: v[1] as string, title: v[2] as string | null,
    createdAt: v[3] as string, updatedAt: v[4] as string,
    messageCount: (v[5] as number) ?? 0, lastMessagePreview: v[6] as string | null,
    lastMessageRole: v[7] as string | null, modelOverride: v[8] as string | null,
  }));
}

/** Update conversation title */
export function updateConversationTitle(id: string, title: string): void {
  const db = getDatabase();
  db.run("UPDATE conversations SET title = ?, updatedAt = ? WHERE id = ?", [title, new Date().toISOString(), id]);
  scheduleSave();
}

/** Update conversation model override (null to clear and use default agent model) */
export function updateConversationModel(id: string, modelOverride: string | null): void {
  const db = getDatabase();
  db.run("UPDATE conversations SET modelOverride = ?, updatedAt = ? WHERE id = ?", [modelOverride, new Date().toISOString(), id]);
  scheduleSave();
}

/** Delete a conversation and all its messages */
export function deleteConversation(id: string): boolean {
  const db = getDatabase();
  const existing = getConversation(id);
  if (!existing) return false;
  // B-14: 事务保护，确保消息和会话原子删除
  db.run("BEGIN TRANSACTION");
  try {
    db.run("DELETE FROM conv_messages WHERE conversationId = ?", [id]);
    db.run("DELETE FROM conversations WHERE id = ?", [id]);
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
  scheduleSave();

  // JSONL dual-write: remove JSONL file and index entry
  try { getJsonlWriter().remove(id); } catch { /* best-effort */ }

  return true;
}

/**
 * 原子替换会话的所有消息 — 用于压缩后持久化。
 * 在事务中先删除旧消息，再批量插入新消息，保证一致性。
 */
export function replaceConvMessages(
  conversationId: string,
  messages: Array<{ role: string; content: string | null; toolCallId?: string; toolCalls?: string; toolName?: string }>,
): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run("BEGIN TRANSACTION");
  try {
    db.run("DELETE FROM conv_messages WHERE conversationId = ?", [conversationId]);
    for (const msg of messages) {
      db.run(
        `INSERT INTO conv_messages (conversationId, role, content, toolCallId, toolCalls, toolName, timestamp, tokenCount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [conversationId, msg.role, msg.content ?? null, msg.toolCallId ?? null,
         msg.toolCalls ?? null, msg.toolName ?? null, now, null],
      );
    }
    const preview = messages.length > 0 ? (messages[messages.length - 1].content ?? "").slice(0, 80) : null;
    db.run(
      "UPDATE conversations SET messageCount = ?, updatedAt = ?, lastMessagePreview = ? WHERE id = ?",
      [messages.length, now, preview, conversationId],
    );
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
  scheduleSave();
}

/** Append a single message to a conversation and update counters */
export function appendConvMessage(
  conversationId: string,
  role: string,
  content: string | null,
  opts?: { toolCallId?: string; toolCalls?: string; toolName?: string; tokenCount?: number },
): number {
  const db = getDatabase();
  const now = new Date().toISOString();
  const stmt = db.run(
    `INSERT INTO conv_messages (conversationId, role, content, toolCallId, toolCalls, toolName, timestamp, tokenCount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [conversationId, role, content ?? null, opts?.toolCallId ?? null, opts?.toolCalls ?? null,
     opts?.toolName ?? null, now, opts?.tokenCount ?? null],
  );
  // Update conversation counters
  const preview = content ? content.slice(0, 80) : null;
  db.run(
    `UPDATE conversations SET messageCount = messageCount + 1, updatedAt = ?, lastMessagePreview = ?, lastMessageRole = ? WHERE id = ?`,
    [now, preview, role, conversationId],
  );
  scheduleSave();
  // Return the inserted row ID
  const idResult = db.exec("SELECT last_insert_rowid()");
  const rowId = idResult.length ? (idResult[0].values[0][0] as number) : 0;

  // JSONL dual-write: append message and increment index counter
  try {
    getJsonlWriter().append(conversationId, {
      id: rowId, conversationId, role, content: content ?? null,
      toolCallId: opts?.toolCallId ?? null, toolCalls: opts?.toolCalls ?? null,
      toolName: opts?.toolName ?? null, timestamp: now, tokenCount: opts?.tokenCount ?? null,
    });
    getJsonlWriter().incrementMessageCount(conversationId);
  } catch { /* best-effort */ }

  return rowId;
}

/** Get messages for a conversation, with optional pagination */
export function getConvMessages(
  conversationId: string,
  opts?: { limit?: number; before?: number },
): ConvMessageRecord[] {
  const db = getDatabase();
  const limit = opts?.limit ?? 200;
  let sql = "SELECT id, conversationId, role, content, toolCallId, toolCalls, toolName, timestamp, tokenCount FROM conv_messages WHERE conversationId = ?";
  const params: unknown[] = [conversationId];
  if (opts?.before) {
    sql += " AND id < ?";
    params.push(opts.before);
  }
  sql += " ORDER BY id ASC";
  // For pagination: get the last N messages
  if (opts?.before) {
    // When paging backward, use a subquery to get the right slice
    sql = `SELECT * FROM (SELECT id, conversationId, role, content, toolCallId, toolCalls, toolName, timestamp, tokenCount FROM conv_messages WHERE conversationId = ? AND id < ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`;
    params.length = 0;
    params.push(conversationId, opts.before, limit);
  } else {
    sql += " LIMIT ?";
    params.push(limit);
  }
  const results = db.exec(sql, params);
  if (!results.length) return [];
  return results[0].values.map((v: unknown[]) => ({
    id: v[0] as number, conversationId: v[1] as string, role: v[2] as string,
    // sql.js 有时会把 TEXT 列返回为 Uint8Array，必须运行时检查并转为字符串
    content: v[3] instanceof Uint8Array ? new TextDecoder().decode(v[3]) : (v[3] as string | null),
    toolCallId: v[4] instanceof Uint8Array ? new TextDecoder().decode(v[4]) : (v[4] as string | null),
    toolCalls: v[5] instanceof Uint8Array ? new TextDecoder().decode(v[5]) : (v[5] as string | null),
    toolName: v[6] instanceof Uint8Array ? new TextDecoder().decode(v[6]) : (v[6] as string | null),
    timestamp: v[7] instanceof Uint8Array ? new TextDecoder().decode(v[7]) : (v[7] as string),
    tokenCount: v[8] as number | null,
  }));
}

/** FTS5 search across conversation messages */
export function searchConvMessages(
  query: string,
  opts?: { agentId?: string; limit?: number },
): Array<{ id: number; conversationId: string; role: string; snippet: string; timestamp: string }> {
  const db = getDatabase();
  const limit = opts?.limit ?? 30;
  // Check if FTS5 table exists
  try {
    const check = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='conv_messages_fts'");
    if (!check.length || !check[0].values.length) throw new Error("no fts");

    let sql: string;
    // P0-A8: FTS5 查询注入防护
    const safeQuery = '"' + query.replace(/"/g, '""') + '"';
    const params: unknown[] = [safeQuery];
    if (opts?.agentId) {
      sql = `SELECT m.id, m.conversationId, m.role, snippet(conv_messages_fts, 0, '>>>', '<<<', '...', 40) AS snip, m.timestamp
             FROM conv_messages_fts
             JOIN conv_messages m ON m.id = conv_messages_fts.rowid
             JOIN conversations c ON c.id = m.conversationId
             WHERE conv_messages_fts MATCH ? AND c.agentId = ?
             ORDER BY rank LIMIT ?`;
      params.push(opts.agentId, limit);
    } else {
      sql = `SELECT m.id, m.conversationId, m.role, snippet(conv_messages_fts, 0, '>>>', '<<<', '...', 40) AS snip, m.timestamp
             FROM conv_messages_fts
             JOIN conv_messages m ON m.id = conv_messages_fts.rowid
             WHERE conv_messages_fts MATCH ?
             ORDER BY rank LIMIT ?`;
      params.push(limit);
    }
    const results = db.exec(sql, params);
    if (!results.length) return [];
    return results[0].values.map((v: unknown[]) => ({
      id: v[0] as number, conversationId: v[1] as string, role: v[2] as string,
      snippet: v[3] as string, timestamp: v[4] as string,
    }));
  } catch {
    // Fallback: LIKE search
    let sql = `SELECT m.id, m.conversationId, m.role, m.content, m.timestamp
               FROM conv_messages m`;
    const params: unknown[] = [];
    if (opts?.agentId) {
      sql += ` JOIN conversations c ON c.id = m.conversationId WHERE m.content LIKE ? AND c.agentId = ?`;
      params.push(`%${query}%`, opts.agentId);
    } else {
      sql += ` WHERE m.content LIKE ?`;
      params.push(`%${query}%`);
    }
    sql += ` ORDER BY m.timestamp DESC LIMIT ?`;
    params.push(limit);
    const results = db.exec(sql, params);
    if (!results.length) return [];
    return results[0].values.map((v: unknown[]) => ({
      id: v[0] as number, conversationId: v[1] as string, role: v[2] as string,
      snippet: ((v[3] as string) ?? "").slice(0, 120), timestamp: v[4] as string,
    }));
  }
}

// ─── Cron Persistence ───────────────────────────────────────
// 已迁移至 persistence/sqlite/cron-repo.ts（批 2c）
// 说明：CronJobInput / CronHistoryInput 为 file-private interface 随函数一并搬走；
//       cleanupOldCronHistory 紧耦合 cron_history 表，同样保留在 cron-repo。

// ─── MCP / Installed Skills / Security Policy Persistence ───
// 已迁移至 persistence/sqlite/{mcp-store,skill-store,security-policy-store}.ts（批 2a）
// 通过 sqlite/index.ts 桶导出提供向后兼容的公开 API。

// ─── Collaboration History Persistence ───────────────────
// 已迁移至 persistence/sqlite/collab-repo.ts（批 2c）

// ─── I-2: Subagent Runs Persistence ────────────────────────────

/**
 * I-2: 保存子代理运行记录到 DB（P1: fire-and-forget 调用，不阻塞 spawn）。
 */
export function saveSubagentRun(entry: {
  id: string;
  sessionId: string;
  parentSessionId: string;
  task: string;
  label?: string;
  depth: number;
  status: string;
  createdAt: string;
}): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO subagent_runs (id, session_id, parent_session_id, task, label, depth, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.sessionId, entry.parentSessionId, entry.task, entry.label ?? null, entry.depth, entry.status, entry.createdAt]
  );
  scheduleSave();
}

/**
 * I-2: 更新子代理运行状态。
 */
export function updateSubagentRunStatus(id: string, status: string, completedAt?: string, result?: string, error?: string): void {
  const db = getDatabase();
  db.run(
    `UPDATE subagent_runs SET status = ?, completed_at = ?, result = ?, error = ? WHERE id = ?`,
    [status, completedAt ?? null, result?.slice(0, 2000) ?? null, error?.slice(0, 1000) ?? null, id]
  );
  scheduleSave();
}

/**
 * I-2/R4: 将某个 parent session 下所有 running 状态的子代理标记为 cancelled。
 * 用于 E-3 abort 时同步更新 DB 状态，防止 reconcileOrphans 误判。
 */
export function markSubagentRunsCancelled(parentSessionId: string): number {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE subagent_runs SET status = 'killed', completed_at = ? WHERE parent_session_id = ? AND status = 'running'`,
    [now, parentSessionId]
  );
  scheduleSave();
  return result.changes ?? 0;
}

/**
 * I-2: 查询孤儿子代理（运行超过指定时间仍为 running 的记录）。
 */
export function findOrphanSubagentRuns(thresholdMs = 30 * 60 * 1000): Array<Record<string, unknown>> {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  const results = db.exec(
    `SELECT * FROM subagent_runs WHERE status = 'running' AND created_at < ?`,
    [cutoff]
  );
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
    return row;
  });
}

/**
 * I-2/M3: 将 DB 中子代理记录标记为 archived（配合 G-4 惰性清理同步）。
 */
export function archiveSubagentRun(id: string): void {
  const db = getDatabase();
  db.run(`UPDATE subagent_runs SET status = 'archived' WHERE id = ?`, [id]);
  scheduleSave();
}

// ─── Evolution Tables Cleanup ────────────────────────────────
// 已迁移至 persistence/sqlite/maintenance-repo.ts（批 2c，purgeEvolutionCases）。
// skill_proposals 清理随批 2a 归入 skill-store.ts（purgeSkillProposals）。

// ─── Credential / Channel Persistence ───────────────────
// 已迁移至 persistence/sqlite/{credential-store,channel-store}.ts（批 2a）
// 通过 sqlite/index.ts 桶导出提供向后兼容的公开 API。

// ─── Config Store / Video Jobs / Provider Templates Persistence ───
// 已迁移至 persistence/sqlite/{config-store-repo,video-job-repo,provider-template-repo}.ts（批 2b）
// 通过 sqlite/index.ts 桶导出提供向后兼容的公开 API。

