/**
 * Channel 持久化（CORE-P1-02 批 2a，B-18）.
 *
 * 职责：channels 表的 CRUD。对应字段：
 *   id / config / status / createdAt
 *
 * 零共享状态：不与其他 store 共享表、内存缓存、事务。
 * 依赖：仅 getDatabase + scheduleSave。
 */

import { getDatabase, scheduleSave } from "./client.js";

/**
 * 新增或覆盖写入一条 IM 通道配置.
 * config 序列化为 JSON；createdAt 由本函数赋值为当前时间戳。
 */
export function saveChannel(channel: {
  id: string;
  config: Record<string, unknown>;
  status: string;
}): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO channels (id, config, status, createdAt)
     VALUES (?, ?, ?, ?)`,
    [channel.id, JSON.stringify(channel.config), channel.status, new Date().toISOString()],
  );
  scheduleSave();
}

/** 加载全部 IM 通道配置；config 会反序列化为对象。 */
export function loadChannels(): Array<{
  id: string;
  config: Record<string, unknown>;
  status: string;
}> {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM channels");
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => {
      row[col] = vals[i];
    });
    return {
      id: row.id as string,
      config: JSON.parse((row.config as string) || "{}"),
      status: row.status as string,
    };
  });
}

/**
 * 按 id 删除 IM 通道配置.
 *
 * better-sqlite3 迁移：用 .run().changes 精确判断是否真删除行。
 */
export function deleteChannel(id: string): boolean {
  const db = getDatabase();
  const result = db.run("DELETE FROM channels WHERE id = ?", [id]);
  scheduleSave();
  return result.changes > 0;
}
