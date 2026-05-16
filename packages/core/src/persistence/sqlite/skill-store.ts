/**
 * Installed Skills 持久化（CORE-P1-02 批 2a）.
 *
 * 职责：
 *   - installed_skills 表的 CRUD
 *   - skill_proposals 表的清理任务（purgeSkillProposals）
 *
 * 零共享状态：不与其他 store 共享表、内存缓存、事务。
 * 依赖：仅 getDatabase + scheduleSave。
 */

import { getDatabase, scheduleSave } from "./client.js";

/**
 * 新增或覆盖写入一条已安装技能记录.
 * metadata 以 JSON 字符串存储；format 默认 "super-agent"；version 默认 "1.0.0"。
 */
export function saveInstalledSkill(skill: Record<string, unknown>): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO installed_skills (id, name, source, sourceUrl, version, format, installedAt, updatedAt, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      skill.id,
      skill.name,
      skill.source,
      skill.sourceUrl ?? null,
      skill.version ?? "1.0.0",
      skill.format ?? "super-agent",
      skill.installedAt,
      skill.updatedAt,
      JSON.stringify(skill.metadata ?? {}),
    ],
  );
  scheduleSave();
}

/** 加载全部已安装技能；metadata 会反序列化为对象。 */
export function loadInstalledSkills(): Array<Record<string, unknown>> {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM installed_skills LIMIT 200"); // P3-T6: 防止无限制全表扫描
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => {
      row[col] = vals[i];
    });
    row.metadata = JSON.parse((row.metadata as string) || "{}");
    return row;
  });
}

/** 按 id 删除已安装技能. */
export function deleteInstalledSkill(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM installed_skills WHERE id = ?", [id]);
  scheduleSave();
}

/**
 * 清理过期的 skill_proposals 记录.
 *
 * 规则：
 *   1. 先按时间删除（createdAt < 今天 - retentionDays）
 *   2. 再按数量保留（最多保留 maxRows 条，按 createdAt 倒序）
 *
 * @param maxRows  最多保留条数（默认 300）
 * @param retentionDays  保留天数（默认 60）
 * @returns 被删除的行数（通过 sqlite changes() 读取）
 */
export function purgeSkillProposals(maxRows = 300, retentionDays = 60): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();

  // better-sqlite3 迁移：直接用 .run().changes 替代 SELECT changes()
  let deleted = 0;
  deleted += (db.run("DELETE FROM skill_proposals WHERE createdAt < ?", [cutoff])).changes;
  deleted += (db.run(
    `DELETE FROM skill_proposals WHERE id NOT IN (
       SELECT id FROM skill_proposals ORDER BY createdAt DESC LIMIT ?
     )`,
    [maxRows],
  )).changes;

  if (deleted > 0) scheduleSave();
  return deleted;
}
