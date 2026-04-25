/**
 * Session 会话持久化 repo。
 *
 * 抽离自 sqlite.ts（CORE-P1-02 批 2c）。
 * 说明：本文件只负责 sessions 表的 CRUD，与 FTS5 解耦；
 *       indexSessionFTS / searchSessionsFTS 属于批 3 fts-repo 的共享 FTS 层。
 */

import { getDatabase, scheduleSave } from "./client.js";

export function saveSession(id: string, agentId: string, messages: unknown[], userId?: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO sessions (id, agentId, userId, messages, createdAt, updatedAt) VALUES (?, ?, ?, ?, COALESCE((SELECT createdAt FROM sessions WHERE id = ?), ?), ?)`,
    [id, agentId, userId ?? null, JSON.stringify(messages), id, now, now]
  );
  scheduleSave();
}

export function loadSession(id: string): { id: string; agentId: string; messages: unknown[] } | null {
  const db = getDatabase();
  const results = db.exec("SELECT id, agentId, messages FROM sessions WHERE id = ?", [id]);
  if (!results.length || !results[0].values.length) return null;
  const vals = results[0].values[0];
  return {
    id: vals[0] as string,
    agentId: vals[1] as string,
    messages: JSON.parse(vals[2] as string),
  };
}

export function deleteSession(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM sessions WHERE id = ?", [id]);
  scheduleSave();
}

export function listSessionsByAgent(agentId: string): Array<{ id: string; agentId: string; messageCount: number }> {
  const db = getDatabase();
  const results = db.exec("SELECT id, agentId, messages FROM sessions WHERE agentId = ?", [agentId]);
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => ({
    id: vals[0] as string,
    agentId: vals[1] as string,
    messageCount: JSON.parse(vals[2] as string).length,
  }));
}
