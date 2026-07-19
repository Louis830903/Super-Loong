/**
 * 工具骨架提案持久化（P1-2）。
 *
 * 职责：tool_proposals 表的 CRUD。
 * 零共享状态：仅依赖 getDatabase + scheduleSave。
 *
 * 安全边界：提案仅存储候选代码（source_code），status 生命周期
 *   pending_review → approved / rejected。绝不在此层注册/热加载工具。
 */

import { getDatabase, scheduleSave } from "./client.js";

/** 新增或覆盖一条工具提案（按 id 幂等）。 */
export function saveToolProposal(row: Record<string, unknown>): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO tool_proposals
       (id, tool_name, category, description, gap_id, source_code, file_path,
        feature_flag, dependencies, validation_json, status, review_note,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.tool_name,
      row.category,
      row.description,
      row.gap_id ?? null,
      row.source_code,
      row.file_path ?? null,
      row.feature_flag ?? null,
      row.dependencies ?? "[]",
      row.validation_json ?? null,
      row.status ?? "pending_review",
      row.review_note ?? null,
      row.created_at,
      row.updated_at,
    ],
  );
  scheduleSave();
}

/** 加载全部工具提案（默认按创建时间倒序，P3-T6 限制上限）。 */
export function loadToolProposals(status?: string): Array<Record<string, unknown>> {
  const db = getDatabase();
  const results = status
    ? db.exec("SELECT * FROM tool_proposals WHERE status = ? ORDER BY created_at DESC LIMIT 300", [status])
    : db.exec("SELECT * FROM tool_proposals ORDER BY created_at DESC LIMIT 300");
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const obj: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => {
      obj[col] = vals[i];
    });
    return obj;
  });
}

/** 按 id 获取单条工具提案。 */
export function getToolProposal(id: string): Record<string, unknown> | null {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM tool_proposals WHERE id = ? LIMIT 1", [id]);
  if (!results.length || !results[0].values.length) return null;
  const obj: Record<string, unknown> = {};
  results[0].columns.forEach((col: string, i: number) => {
    obj[col] = results[0].values[0][i];
  });
  return obj;
}

/** 更新提案状态（审核结果）。 */
export function updateToolProposalStatus(id: string, status: string, reviewNote?: string): void {
  const db = getDatabase();
  db.run(
    "UPDATE tool_proposals SET status = ?, review_note = ?, updated_at = ? WHERE id = ?",
    [status, reviewNote ?? null, new Date().toISOString(), id],
  );
  scheduleSave();
}

/** 按 id 删除工具提案。 */
export function deleteToolProposal(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM tool_proposals WHERE id = ?", [id]);
  scheduleSave();
}
