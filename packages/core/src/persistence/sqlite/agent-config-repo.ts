/**
 * Agent 配置持久化 repo。
 *
 * 抽离自 sqlite.ts（CORE-P1-02 批 2c）。
 * 仅依赖 client（getDatabase / scheduleSave），无共享状态。
 */

import { getDatabase, scheduleSave } from "./client.js";

export function saveAgentConfig(id: string, config: Record<string, unknown>): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  // P1-02: 使用 COALESCE 保留原始 createdAt（与 saveSession 一致的模式）
  db.run(
    `INSERT OR REPLACE INTO agents (id, config, createdAt) VALUES (?, ?, COALESCE((SELECT createdAt FROM agents WHERE id = ?), ?))`,
    [id, JSON.stringify(config), id, now]
  );
  scheduleSave();
}

export function loadAllAgentConfigs(): Array<{ id: string; config: Record<string, unknown> }> {
  const db = getDatabase();
  const results = db.exec("SELECT id, config FROM agents");
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => ({
    id: vals[0] as string,
    config: JSON.parse(vals[1] as string),
  }));
}

export function deleteAgentConfig(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM agents WHERE id = ?", [id]);
  scheduleSave();
}
