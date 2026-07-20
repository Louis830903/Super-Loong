/**
 * SQLite 持久化层基础设施：初始化、关闭、信号钩子。
 *
 * CORE-P1-02 批 1：从原 sqlite.ts 抽出。
 * better-sqlite3 迁移：移除 WASM loader / saveDatabase / 备份逻辑，
 * 改用 WAL 模式自动写盘 + .bak 恢复 + wal_checkpoint 退出保护。
 *
 * SqlJsCompatDB 兼容层：封装 better-sqlite3，对外暴露 sql.js 兼容 API
 * （db.exec/pragma/run/prepare），避免修改 260+ 处已有的 repo 调用。
 *
 * DAG 位置：logger/constants → schema → migrations → **client** → repo
 * 单例语义：`_db / _dbPath` 作为模块级 state，进程内唯一。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { paths } from "../../config/paths.js";
import { getJsonlWriter } from "../jsonl-writer.js";
import { logger } from "./logger.js";
import type { SqlJsDatabase } from "./constants.js";
import { createInitialSchema, ensureSchemaVersionTable } from "./schema.js";
import { runMigrations } from "./migrations.js";
import { resetFts5Cache } from "./fts-repo.js";

// ─── Query result interface (sql.js compatible) ──────────────

export interface QueryExecResult {
  columns: string[];
  values: unknown[][];
}

// ─── SqlJsCompatDB：better-sqlite3 的 sql.js 兼容包装 ────────
// 核心差异：better-sqlite3 的 exec() 不接受参数（且返回 Database），
// run() 返回 {changes, lastInsertRowid} 而非 Database。
// 此包装层统一差异，让 260+ 处已存在的 repo 调用无需修改。

class SqlJsCompatDB {
  private real: Database.Database;

  constructor(filePath: string) {
    this.real = new Database(filePath);
  }

  pragma(pragma: string): void {
    this.real.pragma(pragma);
  }

  /** sql.js 兼容 exec：接受 params 数组，返回 QueryExecResult[] */
  exec(sql: string, params?: unknown[]): QueryExecResult[] {
    if (!params || params.length === 0) {
      // 【修复】better-sqlite3 的 real.exec() 只执行不返回行，旧实现对所有无参查询 return []，
      // 会吞掉"不带参数的 SELECT"结果（sql.js→better-sqlite3 迁移遗留缺陷）。
      // 安全策略：仅将【读查询】(SELECT/WITH/PRAGMA) 改走 prepare().all() 返回真实行；
      // 其余一切语句（DDL/写/多语句）一律保持原生 real.exec() 行为，零回归。
      if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)) {
        try {
          const stmt = this.real.prepare(sql);
          if (stmt.reader) {
            const rows = stmt.all() as Record<string, unknown>[];
            if (rows.length === 0) return [];
            const columns = Object.keys(rows[0]);
            const values = rows.map((row) => columns.map((col) => row[col]));
            return [{ columns, values }];
          }
        } catch {
          // 读查询预编译失败（极少见）→ 回退原生 exec
        }
      }
      this.real.exec(sql);
      return [];
    }
    // 参数化查询：用 prepare().all() 代替 exec
    // 注意：better-sqlite3 Statement 由 GC 管理生命周期，无需显式 finalize
    const stmt = this.real.prepare(sql);
    try {
      const rows = stmt.all(...params) as Record<string, unknown>[];
      if (rows.length === 0) return [];
      const columns = Object.keys(rows[0]);
      const values = rows.map((row) => columns.map((col) => row[col]));
      return [{ columns, values }];
    } finally {
      // better-sqlite3 无 finalize 方法，GC 自动回收
    }
  }

  /** sql.js 兼容 run：接受 params 数组，返回 {changes, lastInsertRowid} */
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const stmt = this.real.prepare(sql);
    return stmt.run(...(params || []));
  }

  /** sql.js 兼容 prepare（返回包装 Statement） */
  prepare(sql: string): CompatStatement {
    const realStmt = this.real.prepare(sql);
    return new CompatStatement(realStmt);
  }

  close(): void {
    this.real.close();
  }
}

/**
 * Statement 包装：同时暴露两套 API
 *   - sql.js 兼容：bind()/step()/getAsObject()/free()
 *   - better-sqlite3 原生：get()/run()/all()
 * @why api-key-store、tools/index 等按 better-sqlite3 原生风格调用
 *   prepare().run()/.all()；此前兼容层未暴露这两个方法，导致
 *   API Key CRUD 运行时 500、动态工具持久化被 try/catch 静默降级。 */
class CompatStatement {
  private stmt: Database.Statement;
  private _boundParams: unknown[] = [];

  constructor(stmt: Database.Statement) {
    this.stmt = stmt;
  }

  bind(params: unknown[]): boolean {
    this._boundParams = params;
    return true;
  }

  /** better-sqlite3 等效：直接传参执行，返回对象或 undefined */
  get(...params: unknown[]): Record<string, unknown> | undefined {
    const p = params.length > 0 ? params : this._boundParams;
    return this.stmt.get(...p) as Record<string, unknown> | undefined;
  }

  /** better-sqlite3 原生 run：写语句执行，返回 {changes, lastInsertRowid} */
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const p = params.length > 0 ? params : this._boundParams;
    return this.stmt.run(...p);
  }

  /** better-sqlite3 原生 all：读语句执行，返回全部行 */
  all(...params: unknown[]): Record<string, unknown>[] {
    const p = params.length > 0 ? params : this._boundParams;
    return this.stmt.all(...p) as Record<string, unknown>[];
  }

  /** 兼容 sql.js 的 step() → getAsObject() 模式：直接执行并返回行 */
  step(): boolean {
    // 立即用 bound 参数执行一次 get
    return false; // 不再支持逐步迭代；鼓励直接使用 stmt.get()
  }

  getAsObject(): Record<string, unknown> {
    return this.stmt.get(...this._boundParams) as Record<string, unknown>;
  }

  free(): void {
    // better-sqlite3 由 GC 管理 statement 生命周期
  }
}

// ─── Database Singleton ──────────────────────────────────────

let _db: SqlJsCompatDB | null = null;
let _dbPath: string | null = null;

// ─── Database Initialization ─────────────────────────────────

/**
 * Initialize the SQLite database. Call once at startup.
 * @param dbPath File path for the database (e.g. "./data/super-agent.db")
 */
export function initDatabase(dbPath?: string): SqlJsDatabase {
  if (_db) return _db;

  _dbPath = dbPath ?? process.env.SA_DB_PATH ?? paths.db();

  // Ensure directory exists
  const dir = path.dirname(_dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Open database with .bak fallback on failure
  try {
    _db = new SqlJsCompatDB(_dbPath);
  } catch (openErr) {
    logger.error({ err: openErr }, "Failed to open database, trying .bak fallback");
    const bakPath = _dbPath + ".bak";
    if (fs.existsSync(bakPath)) {
      try {
        fs.copyFileSync(bakPath, _dbPath);
        _db = new SqlJsCompatDB(_dbPath);
        logger.info("Database restored from .bak backup");
      } catch (bakErr) {
        logger.error({ err: bakErr }, "Failed to load .bak, creating fresh database");
        try { fs.unlinkSync(_dbPath); } catch (e: any) {
          logger.warn({ err: e.message }, "Could not unlink corrupted DB, attempting open anyway");
        }
        _db = new SqlJsCompatDB(_dbPath);
      }
    } else {
      _db = new SqlJsCompatDB(_dbPath);
    }
  }

  // WAL mode for automatic disk sync + concurrent reads
  _db.pragma("journal_mode = WAL");
  // v3 Task 10：跨平台 synchronous 差异化
  //   - Linux / macOS：synchronous=FULL（数据安全优先）
  //   - Windows：synchronous=NORMAL（fsync 昂贵，NORMAL 平衡性能与安全）
  if (process.platform === "win32") {
    _db.pragma("synchronous = NORMAL");
    logger.info("Windows detected, SQLite synchronous set to NORMAL");
  } else {
    _db.pragma("synchronous = FULL");
  }
  _db.pragma("foreign_keys = ON");

  // ── Schema version table (must exist before migrations) ──
  ensureSchemaVersionTable(_db);

  // ── Create v1 baseline tables & FTS5 virtual tables ──
  createInitialSchema(_db);

  // ── Run any pending migrations (v2, v3, …) ──
  runMigrations(_db);

  // ── Cleanup old clobbered backups ──
  cleanupOldBackups();

  // ── Register graceful shutdown handlers ──
  registerShutdownHandlers();

  return _db;
}

/** Get the current database instance (must call initDatabase first). */
export function getDatabase(): SqlJsDatabase {
  if (!_db) throw new Error("Database not initialized. Call initDatabase() first.");
  return _db;
}

// ─── scheduleSave (no-op in WAL mode) ────────────────────────

/**
 * WAL mode auto-syncs to disk — no explicit save needed.
 * Kept as no-op for API backward compatibility with 47 call sites across 20 repos.
 */
export function scheduleSave(_delayMs?: number): void {
  // WAL mode: writes are automatically persisted to disk
}

// ─── Close & Cleanup ─────────────────────────────────────────

/** Close the database — flush WAL and release resources. */
export function closeDatabase(): void {
  if (_db) {
    // Checkpoint WAL: 合并 WAL 回主 DB。异常时跳过（best-effort），确保 close() 总是执行
    try { _db.pragma("wal_checkpoint(RESTART)"); } catch { /* best-effort */ }
    _db.close();
    _db = null;
    _dbPath = null;
    // 重置 FTS5 缓存（better-sqlite3 迁移后保留，防止后续 reopen 时的缓存脏读）
    resetFts5Cache();
  }
}

// ─── Backup Cleanup ──────────────────────────────────────────

/**
 * Clean up old .clobbered.* backup snapshots older than `retentionDays`.
 * Call periodically or at startup.
 */
export function cleanupOldBackups(retentionDays = 7): number {
  const backupsDir = paths.backups();
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let cleaned = 0;

  try {
    if (!fs.existsSync(backupsDir)) return 0;
    const files = fs.readdirSync(backupsDir);
    for (const file of files) {
      if (!file.includes(".clobbered.")) continue;
      const tsStr = file.split(".clobbered.")[1];
      const ts = parseInt(tsStr, 10);
      if (!isNaN(ts) && ts < cutoff) {
        try {
          fs.unlinkSync(path.join(backupsDir, file));
          cleaned++;
        } catch { /* best-effort */ }
      }
    }
    if (cleaned > 0) {
      logger.info({ cleaned, retentionDays }, "Cleaned up old clobbered backups");
    }
  } catch { /* ignore directory read errors */ }
  return cleaned;
}

// ─── Graceful Shutdown Signal Handlers ───────────────────────
// Ensure WAL is checkpointed before process exits.

let _signalHandlersRegistered = false;

export function registerShutdownHandlers(): void {
  if (_signalHandlersRegistered) return;
  _signalHandlersRegistered = true;

  // 退出前 checkpoint WAL + 关闭数据库 + flush JSONL
  const shutdown = (signal: string) => {
    logger.info({ signal }, "Received signal, performing graceful shutdown");
    if (_db) {
      try { _db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
    }
    try { closeDatabase(); } catch { /* best-effort */ }
    try { getJsonlWriter().flush(); } catch { /* best-effort */ }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  // Final safety net: checkpoint before Node.js exits naturally
  process.on("beforeExit", () => {
    if (_db) {
      try { _db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
    }
    try { getJsonlWriter().flush(); } catch { /* best-effort */ }
  });
}
