/**
 * Security Policy 持久化（CORE-P1-02 批 2a）.
 *
 * 职责：security_policies 表的 CRUD。对应字段：
 *   id / name / config / createdAt
 *
 * 零共享状态：不与其他 store 共享表、内存缓存、事务。
 * 依赖：仅 getDatabase + scheduleSave。
 */

import { getDatabase, scheduleSave } from "./client.js";

/**
 * 新增或覆盖写入一条安全策略.
 * createdAt 由本函数赋值为当前时间戳；config 由调用方序列化为字符串。
 */
export function saveSecurityPolicy(id: string, name: string, config: string): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO security_policies (id, name, config, createdAt) VALUES (?, ?, ?, ?)`,
    [id, name, config, new Date().toISOString()],
  );
  scheduleSave();
}

/** 加载全部安全策略（仅 id/name/config 三列）. */
export function loadSecurityPolicies(): Array<{ id: string; name: string; config: string }> {
  const db = getDatabase();
  const results = db.exec("SELECT id, name, config FROM security_policies");
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => ({
    id: vals[0] as string,
    name: vals[1] as string,
    config: vals[2] as string,
  }));
}

/** 按 id 删除安全策略. */
export function deleteSecurityPolicy(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM security_policies WHERE id = ?", [id]);
  scheduleSave();
}
