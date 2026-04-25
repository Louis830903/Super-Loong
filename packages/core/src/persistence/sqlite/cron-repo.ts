/**
 * Cron 定时任务持久化 repo。
 *
 * 抽离自 sqlite.ts（CORE-P1-02 批 2c）。
 * 说明：CronJobInput / CronHistoryInput 为 file-private interface，
 *       仅供本文件内部函数签名使用，上游通过 structural typing 传入 CronJobConfig / CronHistory。
 *       cleanupOldCronHistory 紧耦合 cron_history 表，保留在本 repo 而非 maintenance-repo。
 */

import { getDatabase, scheduleSave } from "./client.js";

/** saveCronJob 的结构化入参 — 与 CronJobConfig 通过 structural typing 兼容 */
interface CronJobInput {
  id: string;
  name: string;
  expression: string;
  naturalLanguage?: string | null;
  agentId: string;
  message: string;
  deliveryChannel?: string | null;
  deliveryChatId?: string | null;
  enabled: boolean;
  timezone?: string;
  maxRetries?: number;
  createdAt: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  /** [v3 Task 3-8a] 新增字段 */
  scheduleType?: string | null;
  runAt?: string | null;
  intervalMs?: number | null;
  timeoutSeconds?: number | null;
}

/** addCronHistory 的结构化入参 — 与 CronHistory 通过 structural typing 兼容 */
interface CronHistoryInput {
  jobId: string;
  startedAt: string;
  finishedAt?: string | null;
  status: string;
  response?: string | null;
  error?: string | null;
  deliveryStatus?: string | null;
}

export function saveCronJob(job: CronJobInput): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO cron_jobs (id, name, expression, naturalLanguage, agentId, message, deliveryChannel, deliveryChatId, enabled, timezone, maxRetries, createdAt, lastRunAt, nextRunAt, scheduleType, runAt, intervalMs, timeoutSeconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [job.id, job.name, job.expression, job.naturalLanguage ?? null, job.agentId, job.message,
     job.deliveryChannel ?? null, job.deliveryChatId ?? null, job.enabled ? 1 : 0,
     job.timezone ?? "Asia/Shanghai", job.maxRetries ?? 1, job.createdAt, job.lastRunAt ?? null, job.nextRunAt ?? null,
     job.scheduleType ?? "cron", job.runAt ?? null, job.intervalMs ?? null, job.timeoutSeconds ?? null]
  );
  scheduleSave();
}

export function loadCronJobs(): Array<Record<string, unknown>> {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM cron_jobs");
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
    row.enabled = !!(row.enabled as number);
    return row;
  });
}

export function deleteCronJob(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM cron_jobs WHERE id = ?", [id]);
  scheduleSave();
}

export function addCronHistory(entry: CronHistoryInput): void {
  const db = getDatabase();
  db.run(
    "INSERT INTO cron_history (jobId, startedAt, finishedAt, status, response, error, deliveryStatus) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [entry.jobId, entry.startedAt, entry.finishedAt ?? null, entry.status, entry.response ?? null, entry.error ?? null, entry.deliveryStatus ?? null]
  );
  scheduleSave();
}

export function loadCronHistory(jobId: string, limit = 20): Array<Record<string, unknown>> {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM cron_history WHERE jobId = ? ORDER BY startedAt DESC LIMIT ?", [jobId, limit]);
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
    return row;
  });
}

/** [v3 Task 2-2] 清理超过 retentionDays 天的 cron 执行历史 */
export function cleanupOldCronHistory(retentionDays = 30): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  db.run("DELETE FROM cron_history WHERE startedAt < ?", [cutoff]);
  // sql.js 没有 changes()，返回 -1 表示已执行但无法知道具体数量
  scheduleSave();
  return -1;
}
