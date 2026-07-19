/**
 * 能力缺口持久化（P1-1）。
 *
 * 职责：capability_gaps 表的 CRUD。
 * 零共享状态：仅依赖 getDatabase + scheduleSave。
 *
 * 行对象采用 snake_case 列名，与 CapabilityGap 接口的映射由
 * CapabilityGapDetector 负责（避免 persistence → evolution 的反向依赖）。
 */

import { getDatabase, scheduleSave } from "./client.js";

/** 新增或覆盖一条能力缺口记录（按 id 幂等）。 */
export function saveCapabilityGap(row: Record<string, unknown>): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO capability_gaps
       (id, category, description, agent_id, detected_at, last_detected_at,
        frequency, attempted_tools, session_ids, detected_by, sample_response,
        solvable, suggested_fix, priority, status, resolution_note, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.category,
      row.description,
      row.agent_id ?? null,
      row.detected_at,
      row.last_detected_at,
      row.frequency ?? 1,
      row.attempted_tools ?? "[]",
      row.session_ids ?? "[]",
      row.detected_by,
      row.sample_response ?? null,
      row.solvable ?? 1,
      row.suggested_fix ?? null,
      row.priority ?? 1,
      row.status ?? "open",
      row.resolution_note ?? null,
      row.metadata ?? "{}",
    ],
  );
  scheduleSave();
}

/** 加载全部能力缺口（P3-T6：限制上限防全表扫描）。 */
export function loadCapabilityGaps(): Array<Record<string, unknown>> {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM capability_gaps ORDER BY priority DESC LIMIT 500");
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const obj: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => {
      obj[col] = vals[i];
    });
    return obj;
  });
}

/** 按 id 删除能力缺口。 */
export function deleteCapabilityGap(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM capability_gaps WHERE id = ?", [id]);
  scheduleSave();
}
