/**
 * Video Jobs 持久化（ShortVideoCrew 视频任务）。
 *
 * CORE-P1-02 批 2b：从原 sqlite.ts L1378-1487 抽离。
 * 表结构：migrations.ts v15（基础字段）+ v16（agent_providers / template_id 扩列）
 */

import { getDatabase, scheduleSave } from "./client.js";

/**
 * video_jobs 行类型。
 * - 必需字段：id/status/input_json/cost_estimate_cny/cost_limit_cny/created_at/updated_at
 * - 可选字段：progress_json/output_json/error/workspace_dir/cost_actual_cny/concurrency_slot
 * - 扩展字段（v16）：agent_providers / agent_provider_template_id
 */
export interface VideoJobRow {
  id: string;
  status: string;
  input_json: string;
  progress_json?: string | null;
  output_json?: string | null;
  error?: string | null;
  workspace_dir?: string | null;
  cost_estimate_cny: number;
  cost_actual_cny?: number | null;
  cost_limit_cny: number;
  concurrency_slot?: number | null;
  created_at: number;
  updated_at: number;
  agent_providers?: string | null;
  agent_provider_template_id?: string | null;
}

/** 视频任务行内部反序列化（sql.js 的 values 是数组形式） */
function rowToVideoJob(cols: string[], vals: unknown[]): VideoJobRow {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < cols.length; i++) obj[cols[i]] = vals[i];
  return obj as unknown as VideoJobRow;
}

/** 插入视频任务行（upsert） */
export function insertVideoJob(row: VideoJobRow): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO video_jobs (
      id, status, input_json, progress_json, output_json, error,
      workspace_dir, cost_estimate_cny, cost_actual_cny, cost_limit_cny,
      concurrency_slot, created_at, updated_at,
      agent_providers, agent_provider_template_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.status,
      row.input_json,
      row.progress_json ?? null,
      row.output_json ?? null,
      row.error ?? null,
      row.workspace_dir ?? null,
      row.cost_estimate_cny,
      row.cost_actual_cny ?? null,
      row.cost_limit_cny,
      row.concurrency_slot ?? null,
      row.created_at,
      row.updated_at,
      row.agent_providers ?? null,
      row.agent_provider_template_id ?? null,
    ],
  );
  scheduleSave();
}

/** 部分更新视频任务行（只更新 patch 中提供的字段） */
export function updateVideoJob(id: string, patch: Partial<VideoJobRow>): void {
  const keys = Object.keys(patch).filter((k) => k !== "id") as (keyof VideoJobRow)[];
  if (keys.length === 0) return;
  const db = getDatabase();
  const sets = keys.map((k) => `${String(k)} = ?`).join(", ");
  const params = keys.map((k) => {
    const v = (patch as Record<string, unknown>)[k as string];
    return v === undefined ? null : (v as string | number | null);
  });
  params.push(id);
  db.run(`UPDATE video_jobs SET ${sets} WHERE id = ?`, params);
  scheduleSave();
}

/** 按 id 获取单条视频任务；不存在返回 null */
export function getVideoJob(id: string): VideoJobRow | null {
  const db = getDatabase();
  const res = db.exec("SELECT * FROM video_jobs WHERE id = ?", [id]);
  if (!res.length || !res[0].values.length) return null;
  return rowToVideoJob(res[0].columns, res[0].values[0]);
}

/** 列表查询：支持 status 过滤 + 分页（按 created_at DESC） */
export function listVideoJobs(
  opts: {
    status?: string;
    limit?: number;
    offset?: number;
  } = {},
): VideoJobRow[] {
  const db = getDatabase();
  const { status, limit = 20, offset = 0 } = opts;
  let sql = "SELECT * FROM video_jobs";
  const params: (string | number)[] = [];
  if (status) {
    sql += " WHERE status = ?";
    params.push(status);
  }
  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  const res = db.exec(sql, params);
  if (!res.length) return [];
  return res[0].values.map((row: unknown[]) => rowToVideoJob(res[0].columns, row));
}
