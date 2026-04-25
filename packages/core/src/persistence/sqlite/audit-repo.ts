/**
 * 审计日志持久化（sanitize + 配置变更写入/查询）。
 *
 * CORE-P1-02 批 2b：从原 sqlite.ts L473-566 抽离。
 * SENSITIVE_KEYS / SENSITIVE_SUFFIXES 作为 file-private 就近声明（原批 1 决策）—
 *   唯一消费者是 sanitizeForAudit，避免 constants.ts 污染。
 *
 * 表结构：audit_log (id, timestamp, action, agentId, toolName, outcome, details)
 */

import { getDatabase, scheduleSave } from "./client.js";
import { logger } from "./logger.js";

// ─── Audit Log Sanitization（三层检测，借鉴 mem0 _is_sensitive_field） ───────

/** 敏感字段精确命中表 */
const SENSITIVE_KEYS = new Set([
  "apikey", "api_key", "password", "secret", "token",
  "credentials", "authorization", "private_key", "secret_key",
]);

/** 敏感字段后缀命中表 */
const SENSITIVE_SUFFIXES = ["_key", "_secret", "_token", "_password", "_credential"];

/**
 * 深克隆对象并脱敏敏感字段，然后才写入 audit_log。
 * 策略：精确匹配 + 后缀匹配（mem0 模式）；对象递归遍历。
 */
export function sanitizeForAudit(obj: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lower) || SENSITIVE_SUFFIXES.some((s) => lower.endsWith(s))) {
      clone[key] = "***REDACTED***";
    } else if (obj[key] !== null && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
      clone[key] = sanitizeForAudit(obj[key] as Record<string, unknown>);
    } else {
      clone[key] = obj[key];
    }
  }
  return clone;
}

// ─── Config Change Audit Log ─────────────────────────────────────────────────
// 复用既有 audit_log 表，通过 action 前缀 `config.*` 区分。
// Action 约定：
//   config.agent.create / config.agent.update / config.agent.delete
//   config.provider.upsert / config.provider.delete
//   config.mcp.create / config.mcp.delete
//   config.cron.create / config.cron.update / config.cron.delete

/**
 * 记录一次配置变更。
 * @param action  点号分隔的 action，例如 "config.agent.create"
 * @param details 任意 JSON 载荷（before/after 快照等）
 * @param agentId 可选关联的 agentId
 */
export function logConfigChange(
  action: string,
  details: Record<string, unknown>,
  agentId?: string,
): void {
  try {
    const db = getDatabase();
    db.run(
      "INSERT INTO audit_log (timestamp, action, agentId, details) VALUES (?, ?, ?, ?)",
      [new Date().toISOString(), action, agentId ?? null, JSON.stringify(details)],
    );
    scheduleSave();
  } catch (err) {
    logger.warn({ action, err }, "Failed to write config change audit log");
  }
}

/** 查询配置变更审计日志（支持按 category / action / agentId 过滤 + limit） */
export function queryConfigAuditLog(opts?: {
  category?: string;
  action?: string;
  agentId?: string;
  limit?: number;
}): Array<Record<string, unknown>> {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.category) {
    conditions.push("action LIKE ?");
    params.push(`${opts.category}.%`);
  }
  if (opts?.action) {
    conditions.push("action = ?");
    params.push(opts.action);
  }
  if (opts?.agentId) {
    conditions.push("agentId = ?");
    params.push(opts.agentId);
  }

  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts?.limit ?? 100;
  const sql = `SELECT id, timestamp, action, agentId, toolName, outcome, details FROM audit_log${where} ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);

  const results = db.exec(sql, params);
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => {
      row[col] = vals[i];
    });
    try {
      row.details = JSON.parse((row.details as string) || "{}");
    } catch {
      /* keep as string */
    }
    return row;
  });
}
