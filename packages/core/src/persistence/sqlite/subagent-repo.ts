/**
 * Subagent 运行记录持久化（CORE-P1-02 批 3 抽离）。
 *
 * 承载：subagent_runs 表的 CRUD（I-2 子代理管理能力）。
 *   - saveSubagentRun: fire-and-forget 插入（spawn 时调用）
 *   - updateSubagentRunStatus: 状态流转（running → completed/failed/killed/archived）
 *   - markSubagentRunsCancelled: 父会话 abort 时批量取消（R4）
 *   - findOrphanSubagentRuns: 孤儿侦测（reconcileOrphans 定期清理）
 *   - archiveSubagentRun: M3 惰性清理同步
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getDatabase, scheduleSave } from "./client.js";

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
