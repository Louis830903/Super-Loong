/**
 * SQLiteBackend：MemoryBackend 接口的 SQLite 实现（CORE-P1-02 批 3 抽离）。
 *
 * 承载：
 *   - MemoryEntry 的 CRUD / list / search / count / clear
 *   - H-1 实体解析相关 CRUD（entities / memory_entities）
 *
 * 依赖：
 *   - getDatabase / scheduleSave 来自 client.ts
 *   - hasFTS5 / hasFTS5v6 直接 import 自 fts-repo.ts（不经桶导出，保持 public API 面最小）
 *   - EntityRow 类型来自 memory/entity-resolver，随本 repo re-export 以兼容上游
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { MemoryEntry, MemorySearchResult } from "../../types/index.js";
import type { MemoryBackend, MemoryFilter } from "../../memory/manager.js";
import type { EntityRow } from "../../memory/entity-resolver.js";
import { getDatabase, scheduleSave } from "./client.js";
import { hasFTS5, hasFTS5v6 } from "./fts-repo.js";

/** 实体行类型（从 entity-resolver 重导出以保持上游兼容） */
export type { EntityRow };

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
