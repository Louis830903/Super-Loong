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

// ─── FTS5 探测缓存（better-sqlite3 迁移后 FTS5 保证可用） ───

/** 重置 FTS5 缓存 —— 供 closeDatabase 调用。迁移后 no-op，保留以兼容调用方。 */
export function resetFts5Cache(): void {
  // FTS5 在 better-sqlite3 中始终可用，无需缓存
}

/** FTS5 始终可用（better-sqlite3 自带 FTS5），直接返回 true。
 * @deprecated better-sqlite3 迁移后 FTS5 保证可用，此函数保留仅为 API 兼容 */
export function hasFTS5(): boolean {
  return true;
}

/** v6 版内容同步 FTS5 表检查（迁移后直接返回 true，统一用 v6 模式）。
 * @deprecated better-sqlite3 迁移后统一使用 v6 模式 */
export function hasFTS5v6(): boolean {
  return true;
}

// ─── Memory FTS CRUD ────────────────────────────────────────

/** 将一条 memory 索引到 memories_fts 表。 */
export function indexMemoryFTS(entry: { id: string; agentId: string; content: string; type: string }): void {
  const db = getDatabase();
  db.run("INSERT OR REPLACE INTO memories_fts (id, agentId, content, type) VALUES (?, ?, ?, ?)",
    [entry.id, entry.agentId, entry.content, entry.type]);
}

/** 从 memories_fts 索引里移除一条 memory。 */
export function removeMemoryFTS(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM memories_fts WHERE id = ?", [id]);
}

/** 在 memories_fts 上做全文检索（FTS5 保证可用，无 LIKE fallback）。 */
export function searchMemoriesFTS(
  query: string,
  options?: { agentId?: string; type?: string; limit?: number },
): Array<{ id: string; agentId: string; content: string; type: string; rank: number }> {
  const db = getDatabase();
  const limit = options?.limit ?? 50;

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
}

// ─── Session FTS CRUD ───────────────────────────────────────

/** 将某会话全部 user/assistant 消息索引到 sessions_fts（先删后插）。 */
export function indexSessionFTS(sessionId: string, agentId: string, messages: Array<{ role: string; content: string }>): void {
  const db = getDatabase();
  db.run("DELETE FROM sessions_fts WHERE sessionId = ?", [sessionId]);
  for (const msg of messages) {
    if (msg.role === "user" || msg.role === "assistant") {
      db.run("INSERT INTO sessions_fts (sessionId, agentId, content) VALUES (?, ?, ?)",
        [sessionId, agentId, getContentText(msg.content)]);
    }
  }
}

/** 跨会话全文检索（FTS5 保证可用，无 LIKE fallback）。 */
export function searchSessionsFTS(
  query: string,
  options?: { agentId?: string; limit?: number },
): Array<{ sessionId: string; agentId: string; content: string; rank: number }> {
  const db = getDatabase();
  const limit = options?.limit ?? 50;

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
}
