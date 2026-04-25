/**
 * Core Blocks 持久化（letta 借鉴 - 人格/记忆核心块）。
 *
 * CORE-P1-02 批 2b：从原 sqlite.ts L432-471 抽离。
 * 表结构：core_blocks (agentId, label, description, value, limitSize, readOnly)
 */

import { getDatabase, scheduleSave } from "./client.js";

/** core_blocks 行类型 */
export interface CoreBlockRow {
  agentId: string;
  label: string;
  description: string;
  value: string;
  limitSize: number;
  readOnly: boolean;
}

/**
 * 保存（upsert）单个 core block。
 * 注意：入参字段 limit 会映射到表列 limitSize；readOnly 布尔值序列化为 0/1。
 */
export function saveCoreBlock(
  agentId: string,
  block: { label: string; description: string; value: string; limit: number; readOnly: boolean },
): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO core_blocks (agentId, label, description, value, limitSize, readOnly)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [agentId, block.label, block.description, block.value, block.limit, block.readOnly ? 1 : 0],
  );
  scheduleSave();
}

/** 按 agentId 加载全部 core blocks */
export function loadCoreBlocks(agentId: string): CoreBlockRow[] {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM core_blocks WHERE agentId = ?", [agentId]);
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => {
      row[col] = vals[i];
    });
    return {
      agentId: row.agentId as string,
      label: row.label as string,
      description: row.description as string,
      value: row.value as string,
      limitSize: row.limitSize as number,
      readOnly: !!(row.readOnly as number),
    };
  });
}
