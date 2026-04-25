/**
 * Provider Templates 持久化（视频 Agent 模型配置模板）。
 *
 * CORE-P1-02 批 2b：从原 sqlite.ts L1489-1585 抽离。
 * 表结构：migrations.ts v16（id/name/description/providers_json/is_preset/created_at）
 * 系统预设 is_preset=1（migrations 内建 4 条），用户模板 is_preset=0。
 */

import { getDatabase, scheduleSave } from "./client.js";

/** agent_provider_templates 行类型 */
export interface ProviderTemplateRow {
  id: string;
  name: string;
  description: string | null;
  providers_json: string;
  is_preset: number;
  created_at: number;
}

/** 行内部反序列化 */
function rowToProviderTemplate(cols: string[], vals: unknown[]): ProviderTemplateRow {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < cols.length; i++) obj[cols[i]] = vals[i];
  return obj as unknown as ProviderTemplateRow;
}

/** 列表所有模板（系统预设优先，按 created_at DESC） */
export function getProviderTemplates(): ProviderTemplateRow[] {
  const db = getDatabase();
  const res = db.exec(
    "SELECT * FROM agent_provider_templates ORDER BY is_preset DESC, created_at DESC",
  );
  if (!res.length) return [];
  return res[0].values.map((row: unknown[]) => rowToProviderTemplate(res[0].columns, row));
}

/** 插入用户模板（系统预设由 migrations 写入，不应走此函数） */
export function insertProviderTemplate(row: ProviderTemplateRow): void {
  const db = getDatabase();
  db.run(
    `INSERT INTO agent_provider_templates (
      id, name, description, providers_json, is_preset, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.name,
      row.description ?? null,
      row.providers_json,
      row.is_preset,
      row.created_at,
    ],
  );
  scheduleSave();
}

/**
 * 更新用户模板（系统预设 is_preset=1 受 WHERE 拦截，返回 false）。
 * patch 可选字段：name / description / providers_json，至少提供一个。
 */
export function updateProviderTemplate(
  id: string,
  patch: { name?: string; description?: string; providers_json?: string },
): boolean {
  const keys = Object.keys(patch).filter(
    (k) => (patch as Record<string, unknown>)[k] !== undefined,
  );
  if (keys.length === 0) return false;
  const db = getDatabase();
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const params: (string | number | null)[] = keys.map(
    (k) => (patch as Record<string, unknown>)[k] as string,
  );
  params.push(id);
  db.run(
    `UPDATE agent_provider_templates SET ${sets} WHERE id = ? AND is_preset = 0`,
    params,
  );
  // sql.js 无 changes()，通过回查判断是否生效
  const check = db.exec(
    "SELECT id FROM agent_provider_templates WHERE id = ? AND is_preset = 0",
    [id],
  );
  const hit = check.length > 0 && check[0].values.length > 0;
  if (hit) scheduleSave();
  return hit;
}

/** 删除用户模板（系统预设 is_preset=1 受 WHERE 拦截，返回 false） */
export function deleteProviderTemplate(id: string): boolean {
  const db = getDatabase();
  // 先查是否存在且非预设
  const pre = db.exec(
    "SELECT id FROM agent_provider_templates WHERE id = ? AND is_preset = 0",
    [id],
  );
  const exists = pre.length > 0 && pre[0].values.length > 0;
  if (!exists) return false;
  db.run("DELETE FROM agent_provider_templates WHERE id = ? AND is_preset = 0", [id]);
  scheduleSave();
  return true;
}
