/**
 * Trace Store — SQLite 持久化存储（使用项目内置的 sql.js）
 *
 * 将完成的 Span 写入共享 SQLite 数据库，支持按 traceId 查询完整调用链，
 * 自动清理 24h 前的过期数据。
 *
 * 注意：依赖 getDatabase()，需在 initDatabase() 之后调用 initTraceStore()
 */

import { onSpan, isTracingEnabled } from "./tracer.js";
import type { Span } from "./types.js";

/** 过期时间：24 小时 */
const EXPIRE_MS = 24 * 60 * 60 * 1000;

/** 清理间隔：1 小时 */
const CLEANUP_INTERVAL = 60 * 60 * 1000;

let initialized = false;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** 延迟获取数据库（避免循环依赖） */
function getDb() {
  try {
    // 动态 import 防止循环依赖
    const { getDatabase } = require("../persistence/sqlite.js");
    return getDatabase();
  } catch {
    return null;
  }
}

/**
 * 初始化 Trace 存储
 * 创建数据库表并注册 Span 回调
 */
export function initTraceStore(): void {
  if (initialized) return;

  // 延迟一下确保主数据库已初始化
  setTimeout(() => {
    try {
      const db = getDb();
      if (!db) return;

      // 创建 spans 表
      db.run(`
        CREATE TABLE IF NOT EXISTS trace_spans (
          id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          parent_span_id TEXT,
          operation TEXT NOT NULL,
          start_time INTEGER NOT NULL,
          end_time INTEGER,
          duration INTEGER,
          status TEXT NOT NULL DEFAULT 'running',
          attributes TEXT DEFAULT '{}',
          events TEXT DEFAULT '[]'
        )
      `);

      db.run("CREATE INDEX IF NOT EXISTS idx_trace_spans_trace_id ON trace_spans(trace_id)");
      db.run("CREATE INDEX IF NOT EXISTS idx_trace_spans_start_time ON trace_spans(start_time)");
    } catch {
      // 表创建失败不影响主流程
    }
  }, 2000);

  // 注册 Span 完成回调 — 自动写入数据库
  onSpan((span) => {
    insertSpan(span);
  });

  // 启动定期清理
  cleanupTimer = setInterval(cleanupExpired, CLEANUP_INTERVAL);
  // [v3 Task 2-6] 不阻止 Node 进程退出
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }

  initialized = true;
}

/**
 * 插入一条完成的 Span
 */
function insertSpan(span: Span): void {
  try {
    const db = getDb();
    if (!db) return;

    db.run(
      `INSERT OR REPLACE INTO trace_spans (id, trace_id, parent_span_id, operation, start_time, end_time, duration, status, attributes, events)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        span.spanId,
        span.traceId,
        span.parentSpanId || null,
        span.operation,
        span.startTime,
        span.endTime || null,
        span.duration || null,
        span.status,
        JSON.stringify(span.attributes),
        JSON.stringify(span.events),
      ],
    );
  } catch {
    // 存储失败不影响主流程
  }
}

/**
 * 按 traceId 查询完整调用链
 */
export function getTraceSpans(traceId: string): Span[] {
  try {
    const db = getDb();
    if (!db) return [];

    const stmt = db.prepare(
      "SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY start_time ASC"
    );
    stmt.bind([traceId]);

    const results: Span[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      results.push(rowToSpan(row));
    }
    stmt.free();
    return results;
  } catch {
    return [];
  }
}

/**
 * 查询最近的 Trace 列表（按第一个 Span 的开始时间倒序）
 */
export function getRecentTraces(limit = 50, offset = 0): TraceListItem[] {
  try {
    const db = getDb();
    if (!db) return [];

    const stmt = db.prepare(`
      SELECT trace_id, MIN(start_time) as first_start, MAX(end_time) as last_end,
             COUNT(*) as span_count,
             GROUP_CONCAT(DISTINCT operation) as operations,
             CASE WHEN SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) > 0 THEN 'error' ELSE 'ok' END as overall_status
      FROM trace_spans
      WHERE end_time IS NOT NULL
      GROUP BY trace_id
      ORDER BY first_start DESC
      LIMIT ? OFFSET ?
    `);
    stmt.bind([limit, offset]);

    const results: TraceListItem[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject() as Record<string, unknown>;
      const firstStart = r.first_start as number;
      const lastEnd = r.last_end as number | null;
      results.push({
        traceId: r.trace_id as string,
        startTime: firstStart,
        endTime: lastEnd,
        spanCount: r.span_count as number,
        operations: (r.operations as string)?.split(",") || [],
        status: (r.overall_status as "ok" | "error") || "ok",
        duration: lastEnd ? lastEnd - firstStart : 0,
      });
    }
    stmt.free();
    return results;
  } catch {
    return [];
  }
}

/**
 * 清理过期数据
 */
function cleanupExpired(): void {
  try {
    const db = getDb();
    if (!db) return;
    const cutoff = Date.now() - EXPIRE_MS;
    db.run("DELETE FROM trace_spans WHERE start_time < ?", [cutoff]);
  } catch {
    // 清理失败不影响主流程
  }
}

/**
 * 关闭存储（优雅退出时调用）
 */
export function closeTraceStore(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  initialized = false;
}

// ---- 内部类型 ----

export interface TraceListItem {
  traceId: string;
  startTime: number;
  endTime: number | null;
  spanCount: number;
  operations: string[];
  status: "ok" | "error";
  duration: number;
}

function rowToSpan(row: Record<string, unknown>): Span {
  return {
    traceId: row.trace_id as string,
    spanId: row.id as string,
    parentSpanId: (row.parent_span_id as string) || undefined,
    operation: row.operation as string,
    startTime: row.start_time as number,
    endTime: (row.end_time as number) || undefined,
    duration: (row.duration as number) || undefined,
    status: (row.status as Span["status"]) || "ok",
    attributes: JSON.parse((row.attributes as string) || "{}"),
    events: JSON.parse((row.events as string) || "[]"),
  };
}
