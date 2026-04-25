/**
 * FTS5 全文检索持久化层（CORE-P1-02 批 3 抽离）。
 *
 * 承载：
 *   - memories_fts / memories_fts_v6 的探测缓存与 CRUD
 *   - sessions_fts 的 CRUD
 *
 * 导出语义：
 *   - public（经 sqlite/index.ts 桶导出）：indexMemoryFTS / removeMemoryFTS /
 *     searchMemoriesFTS / indexSessionFTS / searchSessionsFTS
 *   - 内部消费（memory-backend 直接 import，不经桶导出）：hasFTS5 / hasFTS5v6
 *   - 基础设施消费（client.ts closeDatabase 恢复调用）：resetFts5Cache
 *
 * 与 session-repo 的关系：session-repo 仅负责 sessions 表 CRUD，FTS 索引与检索
 *   归本 repo，避免交叉依赖。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getContentText } from "../../utils/content-helpers.js";
import { getDatabase } from "./client.js";

// ─── FTS5 探测缓存 ──────────────────────────────────────────
// P2-1: hasFTS5() 结果缓存 — 避免每次调用都查 sqlite_master
let _fts5Cache: boolean | null = null;

/**
 * 重置 FTS5 缓存 —— 供 closeDatabase 调用，确保下次 initDatabase 后重新探测。
 * ISSUE-5 修复：CORE-P1-02 批 1 过渡期临时注释的调用，批 3 恢复为真实调用。
 */
export function resetFts5Cache(): void {
  _fts5Cache = null;
}

/** 检测 memories_fts 或 memories_fts_v6 是否存在（缓存结果）。 */
// BUG-2 修复：统一检查 v6 表（内容同步表，更规范的 FTS5 维护模式）
export function hasFTS5(): boolean {
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

/** 检查是否有 v6 版内容同步 FTS5 表（用于选择 JOIN 策略）。 */
export function hasFTS5v6(): boolean {
  try {
    const db = getDatabase();
    const r = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts_v6'");
    return r.length > 0 && r[0].values.length > 0;
  } catch { return false; }
}

// ─── Memory FTS CRUD ────────────────────────────────────────

/** 将一条 memory 索引到 memories_fts 表。 */
export function indexMemoryFTS(entry: { id: string; agentId: string; content: string; type: string }): void {
  if (!hasFTS5()) return;
  try {
    const db = getDatabase();
    db.run("INSERT OR REPLACE INTO memories_fts (id, agentId, content, type) VALUES (?, ?, ?, ?)",
      [entry.id, entry.agentId, entry.content, entry.type]);
  } catch { /* FTS5 not available */ }
}

/** 从 memories_fts 索引里移除一条 memory。 */
export function removeMemoryFTS(id: string): void {
  if (!hasFTS5()) return;
  try {
    const db = getDatabase();
    db.run("DELETE FROM memories_fts WHERE id = ?", [id]);
  } catch { /* ignore */ }
}

/** 在 memories_fts 上做全文检索（失败回退 LIKE）。 */
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

// ─── Session FTS CRUD ───────────────────────────────────────

/** 将某会话全部 user/assistant 消息索引到 sessions_fts（先删后插）。 */
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

/** 跨会话全文检索（失败回退 LIKE + JSON 展开）。 */
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
