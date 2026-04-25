/**
 * 持久化层维护性函数 repo（集中存放跨表的清理/归档类函数）。
 *
 * 抽离自 sqlite.ts（CORE-P1-02 批 2c）。
 * 当前仅承载 Evolution 表清理；skill_proposals 清理随批 2a skill-store 同步搬走，
 * cron_history 清理紧耦合 cron 表保留在 cron-repo。
 */

import { getDatabase, scheduleSave } from "./client.js";

/**
 * 清理超过保留策略的 evolution_cases：
 *   1. 先按 retentionDays 删掉过期数据
 *   2. 再按 maxRows 限制最新条数
 *
 * @param maxRows        最多保留多少行（默认 500）
 * @param retentionDays  保留多少天内的数据（默认 30）
 * @returns 本次删除的行数
 */
export function purgeEvolutionCases(maxRows = 500, retentionDays = 30): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();

  // 1. 先删过期数据
  db.run("DELETE FROM evolution_cases WHERE timestamp < ?", [cutoff]);

  // 2. 再保留最新的 maxRows 条
  db.run(
    `DELETE FROM evolution_cases WHERE id NOT IN (
       SELECT id FROM evolution_cases ORDER BY timestamp DESC LIMIT ?
     )`,
    [maxRows],
  );

  const countRes = db.exec("SELECT changes()");
  const deleted = countRes.length ? (countRes[0].values[0][0] as number) : 0;
  if (deleted > 0) scheduleSave();
  return deleted;
}
