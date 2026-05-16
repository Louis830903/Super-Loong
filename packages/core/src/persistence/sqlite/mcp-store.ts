/**
 * MCP Servers 持久化（CORE-P1-02 批 2a）.
 *
 * 职责：mcp_servers 表的 CRUD。对应 schema 表字段：
 *   id / name / transport / command / args / url / env / auth / enabled / createdAt
 *
 * 零共享状态：不与其他 store 共享表、内存缓存、事务。
 * 依赖：仅 getDatabase + scheduleSave。
 */

import { getDatabase, scheduleSave } from "./client.js";

/**
 * 新增或覆盖写入一条 MCP Server 配置.
 * args/env 以 JSON 字符串存储；auth 为可选对象，存在时序列化为 JSON。
 */
export function saveMCPServer(server: Record<string, unknown>): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO mcp_servers (id, name, transport, command, args, url, env, auth, enabled, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      server.id,
      server.name,
      server.transport,
      server.command ?? null,
      JSON.stringify(server.args ?? []),
      server.url ?? null,
      JSON.stringify(server.env ?? {}),
      server.auth ? JSON.stringify(server.auth) : null,
      server.enabled ? 1 : 0,
      server.createdAt,
    ],
  );
  scheduleSave();
}

/**
 * 加载全部 MCP Server 配置.
 * 反序列化 args/env/auth，并把 enabled 从 0/1 还原为 boolean。
 */
export function loadMCPServers(): Array<Record<string, unknown>> {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM mcp_servers LIMIT 200"); // P3-T6: 防止无限制全表扫描
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => {
      row[col] = vals[i];
    });
    row.args = JSON.parse((row.args as string) || "[]");
    row.env = JSON.parse((row.env as string) || "{}");
    // B-5：反序列化 auth 配置
    if (row.auth && typeof row.auth === "string") {
      try {
        row.auth = JSON.parse(row.auth);
      } catch {
        row.auth = undefined;
      }
    }
    row.enabled = !!(row.enabled as number);
    return row;
  });
}

/** 按 id 删除 MCP Server 配置. */
export function deleteMCPServer(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM mcp_servers WHERE id = ?", [id]);
  scheduleSave();
}
