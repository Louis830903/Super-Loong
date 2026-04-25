/**
 * Collaboration（多 Agent 协作）历史持久化 repo。
 *
 * 抽离自 sqlite.ts（CORE-P1-02 批 2c）。
 */

import { getDatabase, scheduleSave } from "./client.js";

export function saveCollabHistory(entry: {
  id: string;
  type: "crew" | "groupchat";
  name: string;
  status: string;
  result: string;
  durationMs: number;
}): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO collab_history (id, type, name, status, result, durationMs, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.type, entry.name, entry.status, entry.result, entry.durationMs, new Date().toISOString()]
  );
  scheduleSave();
}

export function loadCollabHistory(limit = 100): Array<Record<string, unknown>> {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM collab_history ORDER BY createdAt DESC LIMIT ?", [limit]);
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
    return row;
  });
}

export function deleteCollabHistory(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM collab_history WHERE id = ?", [id]);
  scheduleSave();
}

/** M-2: 按 id 查询单条协作历史记录（用于 getResultById 的 DB fallback） */
export function loadCollabHistoryById(id: string): Record<string, unknown> | undefined {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM collab_history WHERE id = ? LIMIT 1", [id]);
  if (!results.length || !results[0].values.length) return undefined;
  const row: Record<string, unknown> = {};
  results[0].columns.forEach((col: string, i: number) => { row[col] = results[0].values[0][i]; });
  return row;
}
