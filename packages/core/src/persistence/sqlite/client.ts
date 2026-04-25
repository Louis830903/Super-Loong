/**
 * SQLite 持久化层基础设施：初始化、落盘、备份、关闭、信号钩子。
 *
 * CORE-P1-02 批 1：从原 sqlite.ts 抽出
 *   - L11-17 loadSqlJs
 *   - L18-26 imports（fs/path/paths/jsonl-writer）
 *   - L34-41 模块单例（_db / _dbPath / _SQL / _saveTimer）
 *   - L685-1072 initDatabase（改为调用 schema.ts createInitialSchema + migrations.ts runMigrations）
 *   - L1074-1287 getDatabase / saveDatabase / saveDatabaseSync / scheduleSave /
 *     flushPendingSave / flushPendingSaveSync / closeDatabase / cleanupOldBackups /
 *     registerShutdownHandlers
 *
 * DAG 位置：logger/constants → schema → migrations → **client** → repo
 * 单例语义：`_db / _dbPath / _SQL / _saveTimer` 作为模块级 state，
 *           进程内唯一，生命周期等同 Node.js 进程。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "../../config/paths.js";
import { getJsonlWriter } from "../jsonl-writer.js";
import { logger } from "./logger.js";
import type { SqlJsDatabase, SqlJsStatic } from "./constants.js";
import { createInitialSchema, ensureSchemaVersionTable } from "./schema.js";
import { runMigrations } from "./migrations.js";

// ─── sql.js Loader ────────────────────────────────────────────
async function loadSqlJs(): Promise<SqlJsStatic> {
  const mod = await import("sql.js");
  const init = mod.default ?? mod;
  return init();
}

// ─── Database Singleton ──────────────────────────────────────
// NOTE (P2-03): Module-level singleton pattern limits to one DB per process.
// Future multi-tenant support would require refactoring to a DatabaseManager class.

let _db: SqlJsDatabase | null = null;
let _dbPath: string | null = null;
let _SQL: SqlJsStatic | null = null;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Database Initialization ─────────────────────────────────

/**
 * Initialize the SQLite database. Call once at startup.
 * @param dbPath File path for the database (e.g. "./data/super-agent.db")
 */
export async function initDatabase(dbPath?: string): Promise<SqlJsDatabase> {
  if (_db) return _db;

  _SQL = await loadSqlJs();
  _dbPath = dbPath ?? process.env.SA_DB_PATH ?? paths.db();

  // Ensure directory exists
  const dir = path.dirname(_dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Load existing database or create new (with .bak fallback)
  if (fs.existsSync(_dbPath)) {
    try {
      const fileBuffer = fs.readFileSync(_dbPath);
      _db = new _SQL.Database(fileBuffer);
    } catch (loadErr) {
      logger.error({ err: loadErr }, "Failed to load database, trying .bak fallback");
      const bakPath = _dbPath + ".bak";
      if (fs.existsSync(bakPath)) {
        try {
          _db = new _SQL.Database(fs.readFileSync(bakPath));
          logger.info("Database restored from .bak backup");
        } catch (bakErr) {
          logger.error({ err: bakErr }, "Failed to load .bak, creating fresh database");
          _db = new _SQL.Database();
        }
      } else {
        _db = new _SQL.Database();
      }
    }
  } else {
    _db = new _SQL.Database();
  }

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

  // Persist to disk
  // CORE-P0-08：initDatabase 链路保持同步（避免级联到所有 getDatabase 调用者），
  // 首次落盘使用 saveDatabaseSync 做单次写入。
  saveDatabaseSync();

  return _db;
}

/** Get the current database instance (must call initDatabase first). */
export function getDatabase(): SqlJsDatabase {
  if (!_db) throw new Error("Database not initialized. Call initDatabase() first.");
  return _db;
}

// ─── Persistence (async with retry) ──────────────────────────

/** Persist the in-memory database to disk (immediate) with backup + health check.
 * Uses atomic write pattern (Hermes atomic_json_write): write to tmp → rename to target.
 * On Windows, rename may fail if target exists, so we fall back to copyFileSync.
 * Retry with random jitter on file I/O failures (Hermes WAL retry pattern).
 */

// Retry constants (adapted from Hermes: MAX_WRITE_RETRIES=15, jitter 20-150ms)
const MAX_SAVE_RETRIES = 5;
const INITIAL_RETRY_MS = 50;
const MAX_RETRY_MS = 300;

export async function saveDatabase(): Promise<void> {
  if (!_db || !_dbPath) return;
  const data = _db.export();
  const buffer = Buffer.from(data);
  const dir = path.dirname(_dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // ── Backup & health check (OpenClaw pattern) ──
  if (fs.existsSync(_dbPath)) {
    const oldSize = fs.statSync(_dbPath).size;
    // Health check: flag if new data is >50% smaller than old (potential corruption)
    if (oldSize > 0 && buffer.length < oldSize * 0.5) {
      const clobberedPath = path.join(paths.backups(), `super-agent.db.clobbered.${Date.now()}`);
      logger.warn({ oldSize, newSize: buffer.length, clobberedPath },
        "Database size dropped >50%! Saving clobbered snapshot before overwrite");
      try { fs.copyFileSync(_dbPath, clobberedPath); } catch { /* best-effort */ }
    }
    // Rotate backup: current → .bak
    const bakPath = _dbPath + ".bak";
    try { fs.copyFileSync(_dbPath, bakPath); } catch { /* best-effort */ }
  }

  // ── Atomic write with retry (Hermes pattern) ──
  const tmpPath = _dbPath + ".tmp";
  let attempt = 0;
  while (true) {
    try {
      fs.writeFileSync(tmpPath, buffer);
      try {
        fs.renameSync(tmpPath, _dbPath);
      } catch {
        // Windows fallback: renameSync fails if target exists on some FS
        fs.copyFileSync(tmpPath, _dbPath);
        try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
      }
      return; // success
    } catch (err) {
      attempt++;
      if (attempt >= MAX_SAVE_RETRIES) {
        logger.error({ attempt, err }, "saveDatabase failed after all retries");
        throw err;
      }
      const jitter = INITIAL_RETRY_MS + Math.random() * (MAX_RETRY_MS - INITIAL_RETRY_MS);
      logger.warn({ attempt, jitter: Math.round(jitter) }, "saveDatabase retry after I/O error");
      // CORE-P0-08：改为真正异步延时，不阻塞事件循环
      // （旧实现使用 Atomics.wait + SharedArrayBuffer 做同步阻塞，
      //   会卡住 Node 主线程，高并发下导致所有 HTTP/WS 请求冻结）
      await new Promise<void>((resolve) => setTimeout(resolve, Math.round(jitter)));
    }
  }
}

/**
 * 同步保存（CORE-P0-08）——仅用于"进程退出钩子"与"初始化首次落盘"两个场景。
 *
 * 退出钩子不能 await（SIGINT/SIGTERM/beforeExit 回调即使标 async 也会丢弃
 * 返回 Promise，导致异常被吞）；初始化首次写入在 initDatabase 链路中，
 * 不宜级联到所有 getDatabase 调用者。因此保留一份单次 writeFileSync 的
 * 最小实现，不做重试（退出路径优先保证不卡住，宁可一次写失败由下次启动
 * 从 .bak 恢复）。
 */
export function saveDatabaseSync(): void {
  if (!_db || !_dbPath) return;
  const data = _db.export();
  const buffer = Buffer.from(data);
  const dir = path.dirname(_dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    // 保留 .bak 备份（与 async 版一致），但不做健康检查（退出路径精简）
    if (fs.existsSync(_dbPath)) {
      try { fs.copyFileSync(_dbPath, _dbPath + ".bak"); } catch { /* best-effort */ }
    }
    fs.writeFileSync(_dbPath, buffer);
  } catch (err) {
    logger.error({ err }, "saveDatabaseSync write failed (exit/init path)");
  }
}

/**
 * Schedule a debounced save (P1-01). Merges rapid writes into a single disk flush.
 * @param delayMs Debounce delay in ms (default 1000)
 */
export function scheduleSave(delayMs = 1000): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    // CORE-P0-08：saveDatabase 已 async，setTimeout 回调无法 await，
    // 通过 .catch 捕获保存异常避免 UnhandledPromiseRejection 崩进程
    saveDatabase().catch((err) => {
      logger.error({ err }, "scheduleSave async save failed");
    });
  }, delayMs);
}

/** Flush any pending scheduled save immediately. */
export async function flushPendingSave(): Promise<void> {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
    await saveDatabase();
  }
}

/**
 * 同步兜底：立刻执行 pending save（仅用于退出钩子）。
 * 不能 await，用 saveDatabaseSync 做一次性同步落盘。
 */
export function flushPendingSaveSync(): void {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  saveDatabaseSync();
}

/** Close the database — flush pending saves and release resources. */
export async function closeDatabase(): Promise<void> {
  if (_db) {
    await flushPendingSave();
    await saveDatabase();
    _db.close();
    _db = null;
    _dbPath = null;
    // ISSUE-5 修复：重置 FTS5 缓存，确保下次 initDatabase 后重新检测
    // CORE-P1-02 批 1 临时注释：_fts5Cache 仍在原 sqlite.ts 业务段声明，
    // 待批 3 搬迁到 fts-repo.ts 并 export resetFts5Cache() 后此处恢复调用。
    // 过渡期影响：同进程重开 DB 时 FTS5 探测结果可能残留旧值（仅测试路径受影响，
    // 因为 initDatabase 的 if (_db) return _db 幂等，生产路径不会重开）。
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
      // Extract timestamp from filename: "super-agent.db.clobbered.1713100000000"
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
// Ensure pending writes are flushed before process exits.

let _signalHandlersRegistered = false;

export function registerShutdownHandlers(): void {
  if (_signalHandlersRegistered) return;
  _signalHandlersRegistered = true;

  // Hermes atexit pattern: only flush data, do NOT call process.exit().
  // Let Fastify or the framework control the actual exit flow.
  // CORE-P0-08：信号回调不能 await，使用 Sync 变体确保一次性同步落盘。
  const shutdown = (signal: string) => {
    logger.info({ signal }, "Received signal, flushing database");
    flushPendingSaveSync();
    // Flush JSONL session index
    try { getJsonlWriter().flush(); } catch { /* best-effort */ }
    if (_db) {
      saveDatabaseSync();
      // Do NOT close DB or call process.exit — framework handles graceful shutdown
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Final safety net: flush before Node.js exits naturally
  process.on("beforeExit", () => {
    if (_db) {
      flushPendingSaveSync();
      saveDatabaseSync();
    }
  });
}
