/**
 * Config Store 持久化（Phase B-2：Nudge 配置）。
 *
 * CORE-P1-02 批 2b：从原 sqlite.ts L1354-1376 抽离。
 * 表结构：config_store (key PRIMARY KEY, value, updatedAt)；本模块仅操作 key='nudge_config'。
 */

import { getDatabase, scheduleSave } from "./client.js";

/** 从 config_store 加载 Nudge 配置（启动时调用）；不存在或解析失败返回 null。 */
export function loadNudgeConfig(): Record<string, unknown> | null {
  const db = getDatabase();
  const results = db.exec("SELECT value FROM config_store WHERE key = 'nudge_config'");
  if (!results.length || !results[0].values.length) return null;
  try {
    return JSON.parse(results[0].values[0][0] as string);
  } catch {
    return null;
  }
}

/** 保存 Nudge 配置到 config_store（每次 updateConfig 时调用） */
export function saveNudgeConfig(config: Record<string, unknown>): void {
  const db = getDatabase();
  db.run(
    "INSERT OR REPLACE INTO config_store (key, value, updatedAt) VALUES (?, ?, ?)",
    ["nudge_config", JSON.stringify(config), new Date().toISOString()],
  );
  scheduleSave();
}
