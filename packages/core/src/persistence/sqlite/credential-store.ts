/**
 * Credential 持久化（CORE-P1-02 批 2a，B-17）.
 *
 * 职责：credentials 表的 CRUD。对应字段：
 *   name / encrypted_value / iv / description / allowed_agents / allowed_tools / createdAt
 *
 * 注意：本层只做加密值/IV 的字节级存取，不负责加解密（加解密由 core/security 负责）。
 * 零共享状态：不与其他 store 共享表、内存缓存、事务。
 * 依赖：仅 getDatabase + scheduleSave。
 */

import { getDatabase, scheduleSave } from "./client.js";

/**
 * 新增或覆盖写入一条凭据.
 * allowedAgents/allowedTools 为 ACL 白名单，序列化为 JSON。
 */
export function saveCredentialToDB(entry: {
  name: string;
  encryptedValue: string;
  iv: string;
  description?: string;
  allowedAgents?: string[];
  allowedTools?: string[];
}): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO credentials (name, encrypted_value, iv, description, allowed_agents, allowed_tools, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.name,
      entry.encryptedValue,
      entry.iv,
      entry.description ?? null,
      JSON.stringify(entry.allowedAgents ?? []),
      JSON.stringify(entry.allowedTools ?? []),
      new Date().toISOString(),
    ],
  );
  scheduleSave();
}

/** 加载全部凭据；ACL 白名单会反序列化为数组。 */
export function loadCredentialsFromDB(): Array<{
  name: string;
  encryptedValue: string;
  iv: string;
  description?: string;
  allowedAgents?: string[];
  allowedTools?: string[];
  createdAt: string;
}> {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM credentials");
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => {
      row[col] = vals[i];
    });
    return {
      name: row.name as string,
      encryptedValue: row.encrypted_value as string,
      iv: row.iv as string,
      description: row.description as string | undefined,
      allowedAgents: JSON.parse((row.allowed_agents as string) || "[]"),
      allowedTools: JSON.parse((row.allowed_tools as string) || "[]"),
      createdAt: row.createdAt as string,
    };
  });
}

/** 按 name 删除凭据. */
export function deleteCredentialFromDB(name: string): void {
  const db = getDatabase();
  db.run("DELETE FROM credentials WHERE name = ?", [name]);
  scheduleSave();
}
