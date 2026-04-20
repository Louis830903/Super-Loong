/**
 * SQLite Persistence Layer for Super Agent Platform.
 *
 * Uses sql.js (WASM-based SQLite) for zero-native-dependency persistence.
 * Provides:
 * - SQLiteBackend: MemoryBackend implementation for the memory system
 * - PersistenceManager: Unified persistence for agents, sessions, credentials, etc.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type SqlJsDatabase = any;
type SqlJsStatic = { Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase };
async function loadSqlJs(): Promise<SqlJsStatic> {
  const mod = await import("sql.js");
  const init = mod.default ?? mod;
  return init();
}
import * as fs from "node:fs";
import * as path from "node:path";
import pino from "pino";
import { getContentText } from "../utils/content-helpers.js";
import type { MemoryEntry, MemorySearchResult } from "../types/index.js";
import type { MemoryBackend, MemoryFilter } from "../memory/manager.js";
import type { EntityRow } from "../memory/entity-resolver.js";
import { paths } from "../config/paths.js";
import { getJsonlWriter } from "./jsonl-writer.js";

const logger = pino({ name: "sqlite" });

// ─── Schema Version ─────────────────────────────────────────
// Bump this when adding migrations. Each version corresponds to a migrateVN() function.
const CURRENT_SCHEMA_VERSION = 9;

// ─── Database Singleton ──────────────────────────────────────
// NOTE (P2-03): Module-level singleton pattern limits to one DB per process.
// Future multi-tenant support would require refactoring to a DatabaseManager class.

let _db: SqlJsDatabase | null = null;
let _dbPath: string | null = null;
let _SQL: SqlJsStatic | null = null;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Schema Version Helpers ──────────────────────────────────

/** Ensure the schema_version table exists (called before any migration). */
function ensureSchemaVersionTable(db: SqlJsDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      description TEXT
    )
  `);
}

/** Get the current schema version (0 if no version recorded yet). */
function getSchemaVersion(db: SqlJsDatabase): number {
  try {
    const results = db.exec("SELECT MAX(version) FROM schema_version");
    if (results.length && results[0].values.length && results[0].values[0][0] !== null) {
      return results[0].values[0][0] as number;
    }
  } catch { /* table may not exist yet */ }
  return 0;
}

/** Record a schema version after a successful migration. */
function setSchemaVersion(db: SqlJsDatabase, version: number, description: string): void {
  db.run(
    "INSERT OR REPLACE INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)",
    [version, new Date().toISOString(), description]
  );
}

/**
 * Run all pending schema migrations sequentially.
 * Each migrateVN function is idempotent (uses try/catch for ALTER TABLE).
 * Add new migrations here by bumping CURRENT_SCHEMA_VERSION and adding a migrateVN() call.
 */
function runMigrations(db: SqlJsDatabase): void {
  const currentVersion = getSchemaVersion(db);
  if (currentVersion >= CURRENT_SCHEMA_VERSION) return;

  logger.info({ from: currentVersion, to: CURRENT_SCHEMA_VERSION }, "Running schema migrations");

  // ── v1: baseline (all existing CREATE TABLE IF NOT EXISTS) ──
  // v1 is recorded after the initial table creation block.

  // ── v2: Add api_key_iv column for AES encryption ──
  if (currentVersion < 2) migrateV2(db);

  // ── v3: Add modelOverride column for per-conversation model ──
  if (currentVersion < 3) migrateV3(db);

  // ── v4: FTS5 auto-maintenance triggers (Hermes messages_fts pattern) ──
  if (currentVersion < 4) migrateV4(db);

  // ── v5: Add trust_score / helpful_count columns to memories (Hermes trust scoring) ──
  if (currentVersion < 5) migrateV5(db);

  // ── v6: FTS5 全文索引（学 Hermes store.py facts_fts 模式） ──
  if (currentVersion < 6) migrateV6(db);

  // ── v7: 实体解析表（学 Hermes entities + fact_entities） ──
  if (currentVersion < 7) migrateV7(db);

  // ── v8: 嵌入类型标记列（HRR/Qwen/Simple 区分） ──
  if (currentVersion < 8) migrateV8(db);

  // ── v9: config_store 表（进化引擎 Nudge 配置持久化） ──
  if (currentVersion < 9) migrateV9(db);
}

/** v2: Add api_key_iv column to llm_providers for AES-256-CBC encryption. */
function migrateV2(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run("ALTER TABLE llm_providers ADD COLUMN api_key_iv TEXT DEFAULT ''");
    setSchemaVersion(db, 2, "Add api_key_iv column for AES encryption");
    db.run("COMMIT");
    logger.info("Migration v2: Added api_key_iv column to llm_providers (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    // Column may already exist (idempotent), or table may not exist yet — just record the version
    if (e.message?.includes("duplicate column") || e.message?.includes("no such table")) {
      setSchemaVersion(db, 2, "Add api_key_iv column (skipped: table absent or column exists)");
      logger.info("Migration v2: skipped (table absent or column already exists), version recorded");
    } else {
      logger.error({ err: e.message }, "Migration v2 failed, rolled back");
      throw e;
    }
  }
}

/** v3: Add modelOverride column to conversations for per-session model selection. */
function migrateV3(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run("ALTER TABLE conversations ADD COLUMN modelOverride TEXT");
    setSchemaVersion(db, 3, "Add modelOverride column for per-conversation model override");
    db.run("COMMIT");
    logger.info("Migration v3: Added modelOverride column to conversations (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    if (e.message?.includes("duplicate column")) {
      setSchemaVersion(db, 3, "Add modelOverride column (already existed)");
      logger.info("Migration v3: modelOverride column already exists, version recorded");
    } else {
      logger.error({ err: e.message }, "Migration v3 failed, rolled back");
      throw e;
    }
  }
}

/**
 * v4: Add FTS5 auto-maintenance triggers for conv_messages and memories.
 * Follows Hermes messages_fts trigger pattern: INSERT/DELETE triggers
 * automatically keep FTS5 index in sync without manual indexing calls.
 */
function migrateV4(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    // ── conv_messages FTS5 triggers ──
    // Only create if FTS5 table exists (sql.js may or may not have FTS5 compiled)
    const hasCmFts = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='conv_messages_fts'"
    );
    if (hasCmFts.length > 0 && hasCmFts[0].values.length > 0) {
      // P0-A10: 修复触发器列定义—conv_messages_fts 只有 content 列，不包含 conversationId
      // INSERT trigger: auto-index new messages
      db.run(`CREATE TRIGGER IF NOT EXISTS conv_msg_fts_ai AFTER INSERT ON conv_messages
        BEGIN
          INSERT INTO conv_messages_fts(rowid, content)
          VALUES (NEW.id, NEW.content);
        END`);
      // DELETE trigger: auto-remove from FTS on delete
      db.run(`CREATE TRIGGER IF NOT EXISTS conv_msg_fts_ad AFTER DELETE ON conv_messages
        BEGIN
          INSERT INTO conv_messages_fts(conv_messages_fts, rowid, content)
          VALUES ('delete', OLD.id, OLD.content);
        END`);
      logger.info("Migration v4: Created conv_messages FTS5 triggers");
    }

    // ── memories FTS5 triggers ──
    const hasMemFts = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
    );
    if (hasMemFts.length > 0 && hasMemFts[0].values.length > 0) {
      // INSERT trigger
      db.run(`CREATE TRIGGER IF NOT EXISTS mem_fts_ai AFTER INSERT ON memories
        BEGIN
          INSERT OR REPLACE INTO memories_fts(id, agentId, content, type)
          VALUES (NEW.id, NEW.agentId, NEW.content, NEW.type);
        END`);
      // UPDATE trigger
      db.run(`CREATE TRIGGER IF NOT EXISTS mem_fts_au AFTER UPDATE ON memories
        BEGIN
          INSERT OR REPLACE INTO memories_fts(id, agentId, content, type)
          VALUES (NEW.id, NEW.agentId, NEW.content, NEW.type);
        END`);
      // DELETE trigger
      db.run(`CREATE TRIGGER IF NOT EXISTS mem_fts_ad AFTER DELETE ON memories
        BEGIN
          DELETE FROM memories_fts WHERE id = OLD.id;
        END`);
      logger.info("Migration v4: Created memories FTS5 triggers");
    }

    setSchemaVersion(db, 4, "Add FTS5 auto-maintenance triggers (Hermes pattern)");
    db.run("COMMIT");
    logger.info("Migration v4: FTS5 triggers committed");
  } catch (e: any) {
    db.run("ROLLBACK");
    logger.error({ err: e.message }, "Migration v4 failed, rolled back");
    // Non-fatal: FTS triggers are an optimization, not required
    setSchemaVersion(db, 4, "FTS5 triggers migration failed (non-fatal)");
  }
}

/** v5: Add trust_score and helpful_count columns to memories for trust scoring system (学 Hermes store.py). */
function migrateV5(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run("ALTER TABLE memories ADD COLUMN trust_score REAL DEFAULT 0.5");
    db.run("ALTER TABLE memories ADD COLUMN helpful_count INTEGER DEFAULT 0");
    db.run("ALTER TABLE memories ADD COLUMN retrieval_count INTEGER DEFAULT 0");
    setSchemaVersion(db, 5, "Add trust_score, helpful_count, retrieval_count columns to memories");
    db.run("COMMIT");
    logger.info("Migration v5: Added trust scoring columns to memories (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    if (e.message?.includes("duplicate column")) {
      setSchemaVersion(db, 5, "Trust scoring columns (skipped: already exist)");
      logger.info("Migration v5: skipped (columns already exist), version recorded");
    } else {
      logger.error({ err: e.message }, "Migration v5 failed, rolled back");
      throw e;
    }
  }
}

/**
 * v6: FTS5 全文索引与自动同步触发器（学 Hermes store.py memories_fts 模式）。
 * 注意：sql.js WASM 可能不含 FTS5 扩展，失败时自动跳过。
 */
function migrateV6(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    // 尝试创建 FTS5 虚拟表 — 如果 sql.js 不支持会抛异常
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts_v6
        USING fts5(content, content=memories, content_rowid=rowid)
    `);

    // 自动同步触发器（学 Hermes store.py facts_fts 模式）
    db.run(`CREATE TRIGGER IF NOT EXISTS mem_ftsv6_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts_v6(rowid, content) VALUES (NEW.rowid, NEW.content);
    END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS mem_ftsv6_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts_v6(memories_fts_v6, rowid, content)
        VALUES ('delete', OLD.rowid, OLD.content);
    END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS mem_ftsv6_au AFTER UPDATE OF content ON memories BEGIN
      INSERT INTO memories_fts_v6(memories_fts_v6, rowid, content)
        VALUES ('delete', OLD.rowid, OLD.content);
      INSERT INTO memories_fts_v6(rowid, content) VALUES (NEW.rowid, NEW.content);
    END`);

    // 回填现有数据到 FTS5 索引
    db.run(`INSERT INTO memories_fts_v6(rowid, content) SELECT rowid, content FROM memories`);

    setSchemaVersion(db, 6, "Add memories_fts_v6 FTS5 index with auto-sync triggers");
    db.run("COMMIT");
    logger.info("Migration v6: FTS5 index created with auto-sync triggers (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    // FTS5 不可用是正常情况（sql.js WASM 可能不含该扩展），记录版本并继续
    setSchemaVersion(db, 6, `FTS5 migration skipped: ${e.message?.slice(0, 100)}`);
    logger.warn({ err: e.message }, "Migration v6: FTS5 not available, skipped (non-fatal)");
  }
}

/** v7: 实体解析表（学 Hermes entities + fact_entities 关联模式） */
function migrateV7(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        entityType TEXT DEFAULT 'unknown',
        aliases TEXT DEFAULT '[]',
        createdAt TEXT NOT NULL
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)`);

    db.run(`
      CREATE TABLE IF NOT EXISTS memory_entities (
        memoryId TEXT REFERENCES memories(id) ON DELETE CASCADE,
        entityId INTEGER REFERENCES entities(id) ON DELETE CASCADE,
        PRIMARY KEY (memoryId, entityId)
      )
    `);

    setSchemaVersion(db, 7, "Add entities and memory_entities tables for entity resolution");
    db.run("COMMIT");
    logger.info("Migration v7: Entity tables created (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    if (e.message?.includes("already exists")) {
      setSchemaVersion(db, 7, "Entity tables (skipped: already exist)");
      logger.info("Migration v7: skipped (tables already exist), version recorded");
    } else {
      logger.error({ err: e.message }, "Migration v7 failed, rolled back");
      throw e;
    }
  }
}

/** v8: 添加 embedding_type 列用于区分 HRR/Qwen/Simple 向量类型 */
function migrateV8(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run("ALTER TABLE memories ADD COLUMN embedding_type TEXT DEFAULT 'simple'");
    setSchemaVersion(db, 8, "Add embedding_type column to memories");
    db.run("COMMIT");
    logger.info("Migration v8: Added embedding_type column to memories (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    if (e.message?.includes("duplicate column")) {
      setSchemaVersion(db, 8, "embedding_type column (skipped: already exists)");
      logger.info("Migration v8: skipped (column already exists), version recorded");
    } else {
      logger.error({ err: e.message }, "Migration v8 failed, rolled back");
      throw e;
    }
  }
}

/** v9: 通用配置存储表，用于 Nudge 配置等键值持久化（Phase B-2） */
function migrateV9(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS config_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    setSchemaVersion(db, 9, "Add config_store table for key-value config persistence");
    db.run("COMMIT");
    logger.info("Migration v9: Created config_store table (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    if (e.message?.includes("already exists")) {
      setSchemaVersion(db, 9, "config_store table (skipped: already exists)");
      logger.info("Migration v9: skipped (table already exists), version recorded");
    } else {
      logger.error({ err: e.message }, "Migration v9 failed, rolled back");
      throw e;
    }
  }
}

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

  // Create tables (wrapped in transaction for atomicity — P1-03)
  _db.run("BEGIN TRANSACTION");
  try {

  _db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      agentId TEXT NOT NULL,
      userId TEXT,
      content TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('core','recall','archival')),
      embedding BLOB,
      metadata TEXT DEFAULT '{}',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);

  _db.run(`CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agentId)`);
  _db.run(`CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`);

  _db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);

  _db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agentId TEXT NOT NULL,
      userId TEXT,
      messages TEXT DEFAULT '[]',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);

  _db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agentId)`);

  _db.run(`
    CREATE TABLE IF NOT EXISTS credentials (
      name TEXT PRIMARY KEY,
      encryptedValue TEXT NOT NULL,
      iv TEXT NOT NULL,
      allowedAgents TEXT DEFAULT '[]',
      allowedTools TEXT DEFAULT '[]',
      createdAt TEXT NOT NULL,
      lastAccessedAt TEXT,
      accessCount INTEGER DEFAULT 0
    )
  `);

  _db.run(`
    CREATE TABLE IF NOT EXISTS security_policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);

  _db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      action TEXT NOT NULL,
      agentId TEXT,
      toolName TEXT,
      outcome TEXT,
      details TEXT DEFAULT '{}'
    )
  `);

  _db.run(`CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp)`);

  _db.run(`
    CREATE TABLE IF NOT EXISTS evolution_cases (
      id TEXT PRIMARY KEY,
      agentId TEXT,
      sessionId TEXT,
      userMessage TEXT,
      agentResponse TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      score REAL,
      failureReason TEXT,
      failureCategory TEXT,
      timestamp TEXT NOT NULL,
      metadata TEXT DEFAULT '{}'
    )
  `);

  _db.run(`
    CREATE TABLE IF NOT EXISTS skill_proposals (
      id TEXT PRIMARY KEY,
      skillName TEXT NOT NULL,
      action TEXT NOT NULL,
      description TEXT,
      analysis TEXT DEFAULT '{}',
      basedOnCases TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      createdAt TEXT NOT NULL
    )
  `);

  _db.run(`
    CREATE TABLE IF NOT EXISTS evolution_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stageIndex INTEGER NOT NULL,
      avgScore REAL,
      proposalCount INTEGER DEFAULT 0,
      activeProposals TEXT DEFAULT '[]',
      timestamp TEXT NOT NULL
    )
  `);

  _db.run(`
    CREATE TABLE IF NOT EXISTS core_blocks (
      agentId TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT DEFAULT '',
      value TEXT DEFAULT '',
      limitSize INTEGER DEFAULT 2000,
      readOnly INTEGER DEFAULT 0,
      PRIMARY KEY (agentId, label)
    )
  `);

  // ─── Cron Jobs Tables ──────────────────────────────────────
  _db.run(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      expression TEXT NOT NULL,
      naturalLanguage TEXT,
      agentId TEXT NOT NULL,
      message TEXT NOT NULL,
      deliveryChannel TEXT,
      deliveryChatId TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      maxRetries INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      lastRunAt TEXT,
      nextRunAt TEXT
    )
  `);

  _db.run(`
    CREATE TABLE IF NOT EXISTS cron_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jobId TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      finishedAt TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      response TEXT,
      error TEXT,
      deliveryStatus TEXT
    )
  `);

  _db.run(`CREATE INDEX IF NOT EXISTS idx_cron_history_job ON cron_history(jobId)`);

  // ─── Installed Skills Table ────────────────────────────────
  _db.run(`
    CREATE TABLE IF NOT EXISTS installed_skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'local',
      sourceUrl TEXT,
      version TEXT DEFAULT '1.0.0',
      format TEXT NOT NULL DEFAULT 'super-agent',
      installedAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      metadata TEXT DEFAULT '{}'
    )
  `);

  // ─── MCP Servers Table ─────────────────────────────────────
  _db.run(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'stdio',
      command TEXT,
      args TEXT DEFAULT '[]',
      url TEXT,
      env TEXT DEFAULT '{}',
      auth TEXT DEFAULT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL
    )
  `);

  // ─── Collaboration History Table ───────────────────────────
  _db.run(`
    CREATE TABLE IF NOT EXISTS collab_history (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('crew','groupchat')),
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT NOT NULL,
      durationMs INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL
    )
  `);
  _db.run(`CREATE INDEX IF NOT EXISTS idx_collab_history_type ON collab_history(type)`);
  _db.run(`CREATE INDEX IF NOT EXISTS idx_collab_history_ts ON collab_history(createdAt)`);

  // ─── Credentials Table (B-17) ───────────────────────────────
  _db.run(`
    CREATE TABLE IF NOT EXISTS credentials (
      name TEXT PRIMARY KEY,
      encrypted_value TEXT NOT NULL,
      iv TEXT NOT NULL,
      description TEXT,
      allowed_agents TEXT DEFAULT '[]',
      allowed_tools TEXT DEFAULT '[]',
      createdAt TEXT NOT NULL
    )
  `);

  // ─── Channels Table (B-18) ──────────────────────────────────
  _db.run(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      config TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'configuring',
      createdAt TEXT NOT NULL
    )
  `);

  // ─── Conversations & Messages Tables ────────────────────────
  _db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      agentId TEXT NOT NULL,
      title TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      messageCount INTEGER DEFAULT 0,
      lastMessagePreview TEXT,
      lastMessageRole TEXT,
      metadata TEXT DEFAULT '{}'
    )
  `);
  _db.run(`CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversations(agentId)`);
  _db.run(`CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updatedAt DESC)`);

  _db.run(`
    CREATE TABLE IF NOT EXISTS conv_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversationId TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      toolCallId TEXT,
      toolCalls TEXT,
      toolName TEXT,
      timestamp TEXT NOT NULL,
      tokenCount INTEGER
    )
  `);
  _db.run(`CREATE INDEX IF NOT EXISTS idx_cmsg_conv ON conv_messages(conversationId, timestamp)`);

  // ─── FTS5 Full-Text Search ─────────────────────────────────
  // FTS5 for memories full-text search
  try {
    _db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED, agentId, content, type,
        tokenize='unicode61'
      )
    `);
  } catch (e: any) {
    logger.warn({ err: e.message }, "FTS5 not available in this sql.js build — full-text search will use LIKE fallback");
  }

  // FTS5 for session messages search
  try {
    _db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        sessionId UNINDEXED, agentId, content,
        tokenize='unicode61'
      )
    `);
  } catch (e: any) {
    logger.warn({ err: e.message }, "FTS5 sessions table not available");
  }

  // FTS5 for conversation messages search
  try {
    _db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conv_messages_fts USING fts5(
        content,
        content=conv_messages,
        content_rowid=id,
        tokenize='unicode61'
      )
    `);
    _db.run(`
      CREATE TRIGGER IF NOT EXISTS conv_fts_insert AFTER INSERT ON conv_messages BEGIN
        INSERT INTO conv_messages_fts(rowid, content) VALUES (new.id, new.content);
      END
    `);
    _db.run(`
      CREATE TRIGGER IF NOT EXISTS conv_fts_delete AFTER DELETE ON conv_messages BEGIN
        INSERT INTO conv_messages_fts(conv_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      END
    `);
  } catch (e: any) {
    logger.warn({ err: e.message }, "FTS5 conv_messages table not available");
  }

  _db.run("COMMIT");
  } catch (err) {
    _db.run("ROLLBACK");
    throw err;
  }

  // ── Record baseline schema version if this is a fresh DB ──
  if (getSchemaVersion(_db) < 1) {
    setSchemaVersion(_db, 1, "Baseline: all initial CREATE TABLE IF NOT EXISTS");
    logger.info("Schema version set to 1 (baseline)");
  }

  // ── Run any pending migrations (v2, v3, …) ──
  runMigrations(_db);

  // ── Cleanup old clobbered backups ──
  cleanupOldBackups();

  // ── Register graceful shutdown handlers ──
  registerShutdownHandlers();

  // Persist to disk
  saveDatabase();

  return _db;
}

/** Get the current database instance (must call initDatabase first). */
export function getDatabase(): SqlJsDatabase {
  if (!_db) throw new Error("Database not initialized. Call initDatabase() first.");
  return _db;
}

/** Persist the in-memory database to disk (immediate) with backup + health check.
 * Uses atomic write pattern (Hermes atomic_json_write): write to tmp → rename to target.
 * On Windows, rename may fail if target exists, so we fall back to copyFileSync.
 * Retry with random jitter on file I/O failures (Hermes WAL retry pattern).
 */

// Retry constants (adapted from Hermes: MAX_WRITE_RETRIES=15, jitter 20-150ms)
const MAX_SAVE_RETRIES = 5;
const INITIAL_RETRY_MS = 50;
const MAX_RETRY_MS = 300;

export function saveDatabase(): void {
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
      // B-13: 用 Atomics.wait 替代 busy-wait 自旋，避免阻塞主线程 CPU
      const sharedBuf = new SharedArrayBuffer(4);
      const sharedArr = new Int32Array(sharedBuf);
      Atomics.wait(sharedArr, 0, 0, Math.round(jitter));
    }
  }
}

/**
 * Schedule a debounced save (P1-01). Merges rapid writes into a single disk flush.
 * @param delayMs Debounce delay in ms (default 1000)
 */
export function scheduleSave(delayMs = 1000): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    saveDatabase();
    _saveTimer = null;
  }, delayMs);
}

/** Flush any pending scheduled save immediately. */
export function flushPendingSave(): void {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
    saveDatabase();
  }
}

/** Close the database — flush pending saves and release resources. */
export function closeDatabase(): void {
  if (_db) {
    flushPendingSave();
    saveDatabase();
    _db.close();
    _db = null;
    _dbPath = null;
  }
}

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
  const shutdown = (signal: string) => {
    logger.info({ signal }, "Received signal, flushing database");
    flushPendingSave();
    // Flush JSONL session index
    try { getJsonlWriter().flush(); } catch { /* best-effort */ }
    if (_db) {
      saveDatabase();
      // Do NOT close DB or call process.exit — framework handles graceful shutdown
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Final safety net: flush before Node.js exits naturally
  process.on("beforeExit", () => {
    if (_db) {
      flushPendingSave();
      saveDatabase();
    }
  });
}

// ─── SQLiteBackend: MemoryBackend Implementation ────────────

export class SQLiteBackend implements MemoryBackend {
  private get db() {
    return getDatabase();
  }

  async add(entry: MemoryEntry): Promise<void> {
    // F-2: HRR 用 Float64 存储（保持相位精度），其他用 Float32（节省空间）
    let embBlob: Buffer | null = null;
    if (entry.embedding) {
      if (entry.embeddingType === "hrr") {
        embBlob = Buffer.from(new Float64Array(entry.embedding).buffer);
      } else {
        embBlob = Buffer.from(new Float32Array(entry.embedding).buffer);
      }
    }
    this.db.run(
      `INSERT OR REPLACE INTO memories (id, agentId, userId, content, type, embedding, metadata, createdAt, updatedAt, trust_score, helpful_count, retrieval_count, embedding_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.agentId,
        entry.userId ?? null,
        entry.content,
        entry.type,
        embBlob,
        JSON.stringify(entry.metadata),
        entry.createdAt.toISOString(),
        entry.updatedAt.toISOString(),
        entry.trustScore ?? 0.5,
        entry.helpfulCount ?? 0,
        entry.retrievalCount ?? 0,
        entry.embeddingType ?? "simple",
      ]
    );
    scheduleSave();
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const stmt = this.db.prepare("SELECT * FROM memories WHERE id = ?");
    stmt.bind([id]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return this.rowToEntry(row);
    }
    stmt.free();
    return null;
  }

  async update(id: string, updates: Partial<Pick<MemoryEntry, "content" | "metadata" | "embedding" | "trustScore" | "helpfulCount" | "retrievalCount">>): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Memory ${id} not found`);

    const sets: string[] = ["updatedAt = ?"];
    const params: unknown[] = [new Date().toISOString()];

    if (updates.content !== undefined) {
      sets.push("content = ?");
      params.push(updates.content);
    }
    if (updates.metadata !== undefined) {
      sets.push("metadata = ?");
      params.push(JSON.stringify({ ...existing.metadata, ...updates.metadata }));
    }
    if (updates.embedding !== undefined) {
      sets.push("embedding = ?");
      // F-2: HRR 用 Float64，其他用 Float32
      if (updates.embedding) {
        // 读取当前记忆的 embeddingType 决定存储格式
        const isHRR = existing.embeddingType === "hrr";
        params.push(Buffer.from(
          isHRR ? new Float64Array(updates.embedding).buffer : new Float32Array(updates.embedding).buffer
        ));
      } else {
        params.push(null);
      }
    }
    // C-1: 信任评分字段直写专属列
    if (updates.trustScore !== undefined) {
      sets.push("trust_score = ?");
      params.push(updates.trustScore);
    }
    if (updates.helpfulCount !== undefined) {
      sets.push("helpful_count = ?");
      params.push(updates.helpfulCount);
    }
    if (updates.retrievalCount !== undefined) {
      sets.push("retrieval_count = ?");
      params.push(updates.retrievalCount);
    }

    params.push(id);
    this.db.run(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`, params as any[]);
    scheduleSave();
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    this.db.run("DELETE FROM memories WHERE id = ?", [id]);
    scheduleSave();
    return true;
  }

  async list(filters: MemoryFilter): Promise<MemoryEntry[]> {
    const { where, params } = this.buildWhere(filters);
    const sql = `SELECT * FROM memories${where} ORDER BY createdAt DESC`;
    const results = this.db.exec(sql, params);
    if (!results.length) return [];
    return this.resultToEntries(results[0]);
  }

  async search(query: string, filters: MemoryFilter, topK: number): Promise<MemorySearchResult[]> {
    // Text-based search: use SQL LIKE for keyword matching
    const candidates = await this.list(filters);
    const queryLower = query.toLowerCase();
    const words = queryLower.split(/\W+/).filter(Boolean);

    const scored: MemorySearchResult[] = candidates.map((entry) => {
      const contentLower = entry.content.toLowerCase();
      let hits = 0;
      for (const w of words) {
        if (contentLower.includes(w)) hits++;
      }
      const textScore = words.length > 0 ? hits / words.length : 0;
      return { entry, score: textScore };
    });

    return scored
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async count(filters: MemoryFilter): Promise<number> {
    const { where, params } = this.buildWhere(filters);
    const results = this.db.exec(`SELECT COUNT(*) as cnt FROM memories${where}`, params);
    if (!results.length || !results[0].values.length) return 0;
    return results[0].values[0][0] as number;
  }

  async clear(filters: MemoryFilter): Promise<number> {
    const count = await this.count(filters);
    const { where, params } = this.buildWhere(filters);
    this.db.run(`DELETE FROM memories${where}`, params);
    scheduleSave();
    return count;
  }

  // ─── Helpers ──────────────────────────────────────────────

  private buildWhere(filters: MemoryFilter): { where: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.agentId) {
      conditions.push("agentId = ?");
      params.push(filters.agentId);
    }
    if (filters.userId) {
      conditions.push("userId = ?");
      params.push(filters.userId);
    }
    if (filters.type) {
      conditions.push("type = ?");
      params.push(filters.type);
    }
    // P2-02: Support metadata filtering via JSON key matching
    if (filters.metadata) {
      for (const [key, value] of Object.entries(filters.metadata)) {
        conditions.push(`json_extract(metadata, '$.' || ?) = ?`);
        params.push(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }

    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    return { where, params };
  }

  private rowToEntry(row: Record<string, unknown>): MemoryEntry {
    // F-2: 根据 embedding_type 列决定反序列化格式
    const embType = (row.embedding_type as string) || "simple";
    let embedding: number[] | undefined;
    if (row.embedding && row.embedding instanceof Uint8Array) {
      // P0-01 fix: Copy to aligned buffer to avoid Float32Array alignment crash.
      const aligned = new ArrayBuffer(row.embedding.byteLength);
      new Uint8Array(aligned).set(row.embedding);
      if (embType === "hrr") {
        // HRR 存储为 Float64（8 bytes per element）
        const float64 = new Float64Array(aligned);
        embedding = Array.from(float64);
      } else {
        // Qwen/Simple 存储为 Float32（4 bytes per element）
        const float32 = new Float32Array(aligned);
        embedding = Array.from(float32);
      }
    }

    return {
      id: row.id as string,
      agentId: row.agentId as string,
      userId: (row.userId as string) || undefined,
      content: row.content as string,
      type: row.type as MemoryEntry["type"],
      embedding,
      embeddingType: embType as MemoryEntry["embeddingType"],
      metadata: JSON.parse((row.metadata as string) || "{}"),
      createdAt: new Date(row.createdAt as string),
      updatedAt: new Date(row.updatedAt as string),
      // C-1: 信任评分字段（学 Hermes trust scoring）
      trustScore: (row.trust_score as number) ?? 0.5,
      helpfulCount: (row.helpful_count as number) ?? 0,
      retrievalCount: (row.retrieval_count as number) ?? 0,
    };
  }

  private resultToEntries(result: { columns: string[]; values: unknown[][] }): MemoryEntry[] {
    return result.values.map((vals: unknown[]) => {
      const row: Record<string, unknown> = {};
      result.columns.forEach((col: string, i: number) => {
        row[col] = vals[i];
      });
      return this.rowToEntry(row);
    });
  }

  // ─── H-1: 实体解析 CRUD（学 Hermes entities/fact_entities） ──

  /** 按名称精确查找实体 */
  findEntity(name: string): EntityRow | null {
    const stmt = this.db.prepare("SELECT * FROM entities WHERE name = ? COLLATE NOCASE");
    stmt.bind([name]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return this.rowToEntityRow(row);
    }
    stmt.free();
    return null;
  }

  /** 按别名查找实体（搜索 aliases JSON 数组） */
  findEntityByAlias(alias: string): EntityRow | null {
    // aliases 存储为 JSON 数组字符串，使用 LIKE 粗筛 + 精确匹配
    const results = this.db.exec(
      `SELECT * FROM entities WHERE aliases LIKE ?`,
      [`%${alias}%`]
    );
    if (!results.length || !results[0].values.length) return null;
    // 精确检查 JSON 数组内容
    for (const vals of results[0].values) {
      const row: Record<string, unknown> = {};
      results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
      const entity = this.rowToEntityRow(row);
      if (entity.aliases.some((a: string) => a.toLowerCase() === alias.toLowerCase())) {
        return entity;
      }
    }
    return null;
  }

  /** 创建新实体 */
  createEntity(name: string, entityType = "unknown"): EntityRow {
    this.db.run(
      "INSERT INTO entities (name, entityType, aliases, createdAt) VALUES (?, ?, ?, ?)",
      [name, entityType, "[]", new Date().toISOString()]
    );
    scheduleSave();
    // 获取刚插入的实体
    return this.findEntity(name)!;
  }

  /** 为实体添加别名 */
  addAlias(entityId: number, alias: string): void {
    const stmt = this.db.prepare("SELECT aliases FROM entities WHERE id = ?");
    stmt.bind([entityId]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      const aliases: string[] = JSON.parse((row.aliases as string) || "[]");
      if (!aliases.includes(alias)) {
        aliases.push(alias);
        this.db.run("UPDATE entities SET aliases = ? WHERE id = ?", [JSON.stringify(aliases), entityId]);
        scheduleSave();
      }
    }
    stmt.free();
  }

  /** 建立记忆-实体关联 */
  linkMemoryEntity(memoryId: string, entityId: number): void {
    this.db.run(
      "INSERT OR IGNORE INTO memory_entities (memoryId, entityId) VALUES (?, ?)",
      [memoryId, entityId]
    );
    scheduleSave();
  }

  /** 获取记忆关联的所有实体 */
  getMemoryEntities(memoryId: string): EntityRow[] {
    const results = this.db.exec(
      `SELECT e.* FROM entities e
       JOIN memory_entities me ON me.entityId = e.id
       WHERE me.memoryId = ?`,
      [memoryId]
    );
    if (!results.length) return [];
    return results[0].values.map((vals: unknown[]) => {
      const row: Record<string, unknown> = {};
      results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
      return this.rowToEntityRow(row);
    });
  }

  /** 获取实体关联的所有记忆 */
  getEntityMemories(entityId: number): MemoryEntry[] {
    const results = this.db.exec(
      `SELECT m.* FROM memories m
       JOIN memory_entities me ON me.memoryId = m.id
       WHERE me.entityId = ?`,
      [entityId]
    );
    if (!results.length) return [];
    return this.resultToEntries(results[0]);
  }

  /** 解析实体行 */
  private rowToEntityRow(row: Record<string, unknown>): EntityRow {
    return {
      id: row.id as number,
      name: row.name as string,
      entityType: (row.entityType as string) || "unknown",
      aliases: JSON.parse((row.aliases as string) || "[]"),
      createdAt: row.createdAt as string,
    };
  }
}

/** 实体行类型（从 entity-resolver 重导出） */
export type { EntityRow };

// ─── Core Blocks Persistence ─────────────────────────────────

export interface CoreBlockRow {
  agentId: string;
  label: string;
  description: string;
  value: string;
  limitSize: number;
  readOnly: boolean;
}

export function saveCoreBlock(agentId: string, block: { label: string; description: string; value: string; limit: number; readOnly: boolean }): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO core_blocks (agentId, label, description, value, limitSize, readOnly)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [agentId, block.label, block.description, block.value, block.limit, block.readOnly ? 1 : 0]
  );
  scheduleSave();
}

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

// ─── Audit Log Sanitization ─────────────────────────────────
// Inspired by mem0 _is_sensitive_field() three-layer detection pattern.
// Prevents API keys and other secrets from leaking into audit_log entries.

const SENSITIVE_KEYS = new Set([
  "apikey", "api_key", "password", "secret", "token",
  "credentials", "authorization", "private_key", "secret_key",
]);
const SENSITIVE_SUFFIXES = ["_key", "_secret", "_token", "_password", "_credential"];

/**
 * Deep-clone an object and redact any sensitive fields before writing to audit log.
 * Uses exact-match + suffix-match strategy (mem0 pattern).
 */
export function sanitizeForAudit(obj: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lower) || SENSITIVE_SUFFIXES.some(s => lower.endsWith(s))) {
      clone[key] = "***REDACTED***";
    } else if (obj[key] !== null && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
      clone[key] = sanitizeForAudit(obj[key] as Record<string, unknown>);
    } else {
      clone[key] = obj[key];
    }
  }
  return clone;
}

// ─── Config Change Audit Log ─────────────────────────────────
// Reuses the existing audit_log table with config.* action prefixes.
// Action conventions:
//   config.agent.create / config.agent.update / config.agent.delete
//   config.provider.upsert / config.provider.delete
//   config.mcp.create / config.mcp.delete
//   config.cron.create / config.cron.update / config.cron.delete

/**
 * Log a configuration change to the audit_log table.
 * @param action  Dot-notation action, e.g. "config.agent.create"
 * @param details  Arbitrary JSON payload (before/after snapshots, etc.)
 * @param agentId  Optional agent ID associated with the change
 */
export function logConfigChange(action: string, details: Record<string, unknown>, agentId?: string): void {
  try {
    const db = getDatabase();
    db.run(
      "INSERT INTO audit_log (timestamp, action, agentId, details) VALUES (?, ?, ?, ?)",
      [new Date().toISOString(), action, agentId ?? null, JSON.stringify(details)]
    );
    scheduleSave();
  } catch (err) {
    logger.warn({ action, err }, "Failed to write config change audit log");
  }
}

/** Query config change audit logs with optional filtering. */
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
    results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
    try { row.details = JSON.parse((row.details as string) || "{}"); } catch { /* keep as string */ }
    return row;
  });
}

// ─── Agent Config Persistence ────────────────────────────────

export function saveAgentConfig(id: string, config: Record<string, unknown>): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  // P1-02: Preserve original createdAt using COALESCE (same pattern as saveSession)
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

// ─── Session Persistence ─────────────────────────────────────

export function saveSession(id: string, agentId: string, messages: unknown[], userId?: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO sessions (id, agentId, userId, messages, createdAt, updatedAt) VALUES (?, ?, ?, ?, COALESCE((SELECT createdAt FROM sessions WHERE id = ?), ?), ?)`,
    [id, agentId, userId ?? null, JSON.stringify(messages), id, now, now]
  );
  scheduleSave();
}

export function loadSession(id: string): { id: string; agentId: string; messages: unknown[] } | null {
  const db = getDatabase();
  const results = db.exec("SELECT id, agentId, messages FROM sessions WHERE id = ?", [id]);
  if (!results.length || !results[0].values.length) return null;
  const vals = results[0].values[0];
  return {
    id: vals[0] as string,
    agentId: vals[1] as string,
    messages: JSON.parse(vals[2] as string),
  };
}

export function deleteSession(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM sessions WHERE id = ?", [id]);
  scheduleSave();
}

export function listSessionsByAgent(agentId: string): Array<{ id: string; agentId: string; messageCount: number }> {
  const db = getDatabase();
  const results = db.exec("SELECT id, agentId, messages FROM sessions WHERE agentId = ?", [agentId]);
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => ({
    id: vals[0] as string,
    agentId: vals[1] as string,
    messageCount: JSON.parse(vals[2] as string).length,
  }));
}

// ─── FTS5 Full-Text Search ──────────────────────────────────

/** Check if FTS5 tables are available */
function hasFTS5(): boolean {
  try {
    const db = getDatabase();
    const r = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'");
    return r.length > 0 && r[0].values.length > 0;
  } catch { return false; }
}

/** Index a memory entry into the FTS5 table */
export function indexMemoryFTS(entry: { id: string; agentId: string; content: string; type: string }): void {
  if (!hasFTS5()) return;
  try {
    const db = getDatabase();
    db.run("INSERT OR REPLACE INTO memories_fts (id, agentId, content, type) VALUES (?, ?, ?, ?)",
      [entry.id, entry.agentId, entry.content, entry.type]);
  } catch { /* FTS5 not available */ }
}

/** Remove a memory entry from the FTS5 index */
export function removeMemoryFTS(id: string): void {
  if (!hasFTS5()) return;
  try {
    const db = getDatabase();
    db.run("DELETE FROM memories_fts WHERE id = ?", [id]);
  } catch { /* ignore */ }
}

/** Full-text search memories using FTS5 (falls back to LIKE if FTS5 unavailable) */
export function searchMemoriesFTS(
  query: string,
  options?: { agentId?: string; type?: string; limit?: number },
): Array<{ id: string; agentId: string; content: string; type: string; rank: number }> {
  const db = getDatabase();
  const limit = options?.limit ?? 50;

  if (hasFTS5()) {
    try {
      // P0-A8: FTS5 查询注入防护—双引号转义后包裹
      const safeQuery = '"' + query.replace(/"/g, '""') + '"';
      let sql = `SELECT id, agentId, content, type, rank FROM memories_fts WHERE memories_fts MATCH ?`;
      const params: unknown[] = [safeQuery];
      if (options?.agentId) { sql += " AND agentId = ?"; params.push(options.agentId); }
      if (options?.type) { sql += " AND type = ?"; params.push(options.type); }
      sql += " ORDER BY rank LIMIT ?";
      params.push(limit);
      const results = db.exec(sql, params);
      if (!results.length) return [];
      return results[0].values.map((vals: unknown[]) => ({
        id: vals[0] as string,
        agentId: vals[1] as string,
        content: vals[2] as string,
        type: vals[3] as string,
        rank: vals[4] as number,
      }));
    } catch { /* fall through to LIKE */ }
  }

  // Fallback: LIKE-based search
  let sql = "SELECT id, agentId, content, type FROM memories WHERE content LIKE ?";
  const params: unknown[] = [`%${query}%`];
  if (options?.agentId) { sql += " AND agentId = ?"; params.push(options.agentId); }
  if (options?.type) { sql += " AND type = ?"; params.push(options.type); }
  sql += " ORDER BY updatedAt DESC LIMIT ?";
  params.push(limit);
  const results = db.exec(sql, params);
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => ({
    id: vals[0] as string,
    agentId: vals[1] as string,
    content: vals[2] as string,
    type: vals[3] as string,
    rank: 0,
  }));
}

/** Index session messages into FTS5 for cross-session search */
export function indexSessionFTS(sessionId: string, agentId: string, messages: Array<{ role: string; content: string }>): void {
  if (!hasFTS5()) return;
  try {
    const db = getDatabase();
    // Remove old entries for this session
    db.run("DELETE FROM sessions_fts WHERE sessionId = ?", [sessionId]);
    // Index each user/assistant message
    for (const msg of messages) {
      if (msg.role === "user" || msg.role === "assistant") {
        db.run("INSERT INTO sessions_fts (sessionId, agentId, content) VALUES (?, ?, ?)",
          [sessionId, agentId, getContentText(msg.content)]);
      }
    }
  } catch { /* ignore */ }
}

/** Full-text search across sessions */
export function searchSessionsFTS(
  query: string,
  options?: { agentId?: string; limit?: number },
): Array<{ sessionId: string; agentId: string; content: string; rank: number }> {
  const db = getDatabase();
  const limit = options?.limit ?? 50;

  if (hasFTS5()) {
    try {
      // P0-A8: FTS5 查询注入防护
      const safeQuery = '"' + query.replace(/"/g, '""') + '"';
      let sql = `SELECT sessionId, agentId, content, rank FROM sessions_fts WHERE sessions_fts MATCH ?`;
      const params: unknown[] = [safeQuery];
      if (options?.agentId) { sql += " AND agentId = ?"; params.push(options.agentId); }
      sql += " ORDER BY rank LIMIT ?";
      params.push(limit);
      const results = db.exec(sql, params);
      if (!results.length) return [];
      return results[0].values.map((vals: unknown[]) => ({
        sessionId: vals[0] as string,
        agentId: vals[1] as string,
        content: vals[2] as string,
        rank: vals[3] as number,
      }));
    } catch { /* fall through */ }
  }

  // Fallback: search session messages via JSON content
  let sql = "SELECT id, agentId, messages FROM sessions WHERE messages LIKE ?";
  const params: unknown[] = [`%${query}%`];
  if (options?.agentId) { sql += " AND agentId = ?"; params.push(options.agentId); }
  sql += " LIMIT ?";
  params.push(limit);
  const results = db.exec(sql, params);
  if (!results.length) return [];
  const hits: Array<{ sessionId: string; agentId: string; content: string; rank: number }> = [];
  for (const vals of results[0].values) {
    const msgs = JSON.parse(vals[2] as string) as Array<{ role: string; content: string }>;
    for (const m of msgs) {
      if ((m.role === "user" || m.role === "assistant") && getContentText(m.content).toLowerCase().includes(query.toLowerCase())) {
        hits.push({ sessionId: vals[0] as string, agentId: vals[1] as string, content: getContentText(m.content), rank: 0 });
      }
    }
  }
  return hits.slice(0, limit);
}

// ─── Conversation Persistence ────────────────────────────────

export interface ConversationRecord {
  id: string;
  agentId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
  lastMessageRole: string | null;
  modelOverride: string | null;
}

export interface ConvMessageRecord {
  id: number;
  conversationId: string;
  role: string;
  content: string | null;
  toolCallId: string | null;
  toolCalls: string | null;
  toolName: string | null;
  timestamp: string;
  tokenCount: number | null;
}

/** Create a new conversation */
export function createConversation(id: string, agentId: string, title?: string, modelOverride?: string): ConversationRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO conversations (id, agentId, title, createdAt, updatedAt, modelOverride) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, agentId, title ?? null, now, now, modelOverride ?? null],
  );
  scheduleSave();
  const record: ConversationRecord = { id, agentId, title: title ?? null, createdAt: now, updatedAt: now, messageCount: 0, lastMessagePreview: null, lastMessageRole: null, modelOverride: modelOverride ?? null };

  // JSONL dual-write: update session index
  try {
    getJsonlWriter().updateIndex(id, { agentId, title: title ?? null, model: modelOverride ?? null, createdAt: now });
  } catch { /* best-effort */ }

  return record;
}

/** Get a conversation by ID */
export function getConversation(id: string): ConversationRecord | null {
  const db = getDatabase();
  const results = db.exec(
    "SELECT id, agentId, title, createdAt, updatedAt, messageCount, lastMessagePreview, lastMessageRole, modelOverride FROM conversations WHERE id = ?",
    [id],
  );
  if (!results.length || !results[0].values.length) return null;
  const v = results[0].values[0];
  return {
    id: v[0] as string, agentId: v[1] as string, title: v[2] as string | null,
    createdAt: v[3] as string, updatedAt: v[4] as string,
    messageCount: (v[5] as number) ?? 0, lastMessagePreview: v[6] as string | null,
    lastMessageRole: v[7] as string | null, modelOverride: v[8] as string | null,
  };
}

/** List conversations for an agent, ordered by updatedAt DESC */
export function listConversations(agentId: string): ConversationRecord[] {
  const db = getDatabase();
  const results = db.exec(
    "SELECT id, agentId, title, createdAt, updatedAt, messageCount, lastMessagePreview, lastMessageRole, modelOverride FROM conversations WHERE agentId = ? ORDER BY updatedAt DESC",
    [agentId],
  );
  if (!results.length) return [];
  return results[0].values.map((v: unknown[]) => ({
    id: v[0] as string, agentId: v[1] as string, title: v[2] as string | null,
    createdAt: v[3] as string, updatedAt: v[4] as string,
    messageCount: (v[5] as number) ?? 0, lastMessagePreview: v[6] as string | null,
    lastMessageRole: v[7] as string | null, modelOverride: v[8] as string | null,
  }));
}

/** Update conversation title */
export function updateConversationTitle(id: string, title: string): void {
  const db = getDatabase();
  db.run("UPDATE conversations SET title = ?, updatedAt = ? WHERE id = ?", [title, new Date().toISOString(), id]);
  scheduleSave();
}

/** Update conversation model override (null to clear and use default agent model) */
export function updateConversationModel(id: string, modelOverride: string | null): void {
  const db = getDatabase();
  db.run("UPDATE conversations SET modelOverride = ?, updatedAt = ? WHERE id = ?", [modelOverride, new Date().toISOString(), id]);
  scheduleSave();
}

/** Delete a conversation and all its messages */
export function deleteConversation(id: string): boolean {
  const db = getDatabase();
  const existing = getConversation(id);
  if (!existing) return false;
  // B-14: 事务保护，确保消息和会话原子删除
  db.run("BEGIN TRANSACTION");
  try {
    db.run("DELETE FROM conv_messages WHERE conversationId = ?", [id]);
    db.run("DELETE FROM conversations WHERE id = ?", [id]);
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
  scheduleSave();

  // JSONL dual-write: remove JSONL file and index entry
  try { getJsonlWriter().remove(id); } catch { /* best-effort */ }

  return true;
}

/**
 * 原子替换会话的所有消息 — 用于压缩后持久化。
 * 在事务中先删除旧消息，再批量插入新消息，保证一致性。
 */
export function replaceConvMessages(
  conversationId: string,
  messages: Array<{ role: string; content: string | null; toolCallId?: string; toolCalls?: string; toolName?: string }>,
): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run("BEGIN TRANSACTION");
  try {
    db.run("DELETE FROM conv_messages WHERE conversationId = ?", [conversationId]);
    for (const msg of messages) {
      db.run(
        `INSERT INTO conv_messages (conversationId, role, content, toolCallId, toolCalls, toolName, timestamp, tokenCount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [conversationId, msg.role, msg.content ?? null, msg.toolCallId ?? null,
         msg.toolCalls ?? null, msg.toolName ?? null, now, null],
      );
    }
    const preview = messages.length > 0 ? (messages[messages.length - 1].content ?? "").slice(0, 80) : null;
    db.run(
      "UPDATE conversations SET messageCount = ?, updatedAt = ?, lastMessagePreview = ? WHERE id = ?",
      [messages.length, now, preview, conversationId],
    );
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
  scheduleSave();
}

/** Append a single message to a conversation and update counters */
export function appendConvMessage(
  conversationId: string,
  role: string,
  content: string | null,
  opts?: { toolCallId?: string; toolCalls?: string; toolName?: string; tokenCount?: number },
): number {
  const db = getDatabase();
  const now = new Date().toISOString();
  const stmt = db.run(
    `INSERT INTO conv_messages (conversationId, role, content, toolCallId, toolCalls, toolName, timestamp, tokenCount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [conversationId, role, content ?? null, opts?.toolCallId ?? null, opts?.toolCalls ?? null,
     opts?.toolName ?? null, now, opts?.tokenCount ?? null],
  );
  // Update conversation counters
  const preview = content ? content.slice(0, 80) : null;
  db.run(
    `UPDATE conversations SET messageCount = messageCount + 1, updatedAt = ?, lastMessagePreview = ?, lastMessageRole = ? WHERE id = ?`,
    [now, preview, role, conversationId],
  );
  scheduleSave();
  // Return the inserted row ID
  const idResult = db.exec("SELECT last_insert_rowid()");
  const rowId = idResult.length ? (idResult[0].values[0][0] as number) : 0;

  // JSONL dual-write: append message and increment index counter
  try {
    getJsonlWriter().append(conversationId, {
      id: rowId, conversationId, role, content: content ?? null,
      toolCallId: opts?.toolCallId ?? null, toolCalls: opts?.toolCalls ?? null,
      toolName: opts?.toolName ?? null, timestamp: now, tokenCount: opts?.tokenCount ?? null,
    });
    getJsonlWriter().incrementMessageCount(conversationId);
  } catch { /* best-effort */ }

  return rowId;
}

/** Get messages for a conversation, with optional pagination */
export function getConvMessages(
  conversationId: string,
  opts?: { limit?: number; before?: number },
): ConvMessageRecord[] {
  const db = getDatabase();
  const limit = opts?.limit ?? 200;
  let sql = "SELECT id, conversationId, role, content, toolCallId, toolCalls, toolName, timestamp, tokenCount FROM conv_messages WHERE conversationId = ?";
  const params: unknown[] = [conversationId];
  if (opts?.before) {
    sql += " AND id < ?";
    params.push(opts.before);
  }
  sql += " ORDER BY id ASC";
  // For pagination: get the last N messages
  if (opts?.before) {
    // When paging backward, use a subquery to get the right slice
    sql = `SELECT * FROM (SELECT id, conversationId, role, content, toolCallId, toolCalls, toolName, timestamp, tokenCount FROM conv_messages WHERE conversationId = ? AND id < ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`;
    params.length = 0;
    params.push(conversationId, opts.before, limit);
  } else {
    sql += " LIMIT ?";
    params.push(limit);
  }
  const results = db.exec(sql, params);
  if (!results.length) return [];
  return results[0].values.map((v: unknown[]) => ({
    id: v[0] as number, conversationId: v[1] as string, role: v[2] as string,
    // sql.js 有时会把 TEXT 列返回为 Uint8Array，必须运行时检查并转为字符串
    content: v[3] instanceof Uint8Array ? new TextDecoder().decode(v[3]) : (v[3] as string | null),
    toolCallId: v[4] instanceof Uint8Array ? new TextDecoder().decode(v[4]) : (v[4] as string | null),
    toolCalls: v[5] instanceof Uint8Array ? new TextDecoder().decode(v[5]) : (v[5] as string | null),
    toolName: v[6] instanceof Uint8Array ? new TextDecoder().decode(v[6]) : (v[6] as string | null),
    timestamp: v[7] instanceof Uint8Array ? new TextDecoder().decode(v[7]) : (v[7] as string),
    tokenCount: v[8] as number | null,
  }));
}

/** FTS5 search across conversation messages */
export function searchConvMessages(
  query: string,
  opts?: { agentId?: string; limit?: number },
): Array<{ id: number; conversationId: string; role: string; snippet: string; timestamp: string }> {
  const db = getDatabase();
  const limit = opts?.limit ?? 30;
  // Check if FTS5 table exists
  try {
    const check = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='conv_messages_fts'");
    if (!check.length || !check[0].values.length) throw new Error("no fts");

    let sql: string;
    // P0-A8: FTS5 查询注入防护
    const safeQuery = '"' + query.replace(/"/g, '""') + '"';
    const params: unknown[] = [safeQuery];
    if (opts?.agentId) {
      sql = `SELECT m.id, m.conversationId, m.role, snippet(conv_messages_fts, 0, '>>>', '<<<', '...', 40) AS snip, m.timestamp
             FROM conv_messages_fts
             JOIN conv_messages m ON m.id = conv_messages_fts.rowid
             JOIN conversations c ON c.id = m.conversationId
             WHERE conv_messages_fts MATCH ? AND c.agentId = ?
             ORDER BY rank LIMIT ?`;
      params.push(opts.agentId, limit);
    } else {
      sql = `SELECT m.id, m.conversationId, m.role, snippet(conv_messages_fts, 0, '>>>', '<<<', '...', 40) AS snip, m.timestamp
             FROM conv_messages_fts
             JOIN conv_messages m ON m.id = conv_messages_fts.rowid
             WHERE conv_messages_fts MATCH ?
             ORDER BY rank LIMIT ?`;
      params.push(limit);
    }
    const results = db.exec(sql, params);
    if (!results.length) return [];
    return results[0].values.map((v: unknown[]) => ({
      id: v[0] as number, conversationId: v[1] as string, role: v[2] as string,
      snippet: v[3] as string, timestamp: v[4] as string,
    }));
  } catch {
    // Fallback: LIKE search
    let sql = `SELECT m.id, m.conversationId, m.role, m.content, m.timestamp
               FROM conv_messages m`;
    const params: unknown[] = [];
    if (opts?.agentId) {
      sql += ` JOIN conversations c ON c.id = m.conversationId WHERE m.content LIKE ? AND c.agentId = ?`;
      params.push(`%${query}%`, opts.agentId);
    } else {
      sql += ` WHERE m.content LIKE ?`;
      params.push(`%${query}%`);
    }
    sql += ` ORDER BY m.timestamp DESC LIMIT ?`;
    params.push(limit);
    const results = db.exec(sql, params);
    if (!results.length) return [];
    return results[0].values.map((v: unknown[]) => ({
      id: v[0] as number, conversationId: v[1] as string, role: v[2] as string,
      snippet: ((v[3] as string) ?? "").slice(0, 120), timestamp: v[4] as string,
    }));
  }
}

// ─── Cron Persistence ───────────────────────────────────────

/** Typed input for saveCronJob — compatible with CronJobConfig via structural typing */
interface CronJobInput {
  id: string;
  name: string;
  expression: string;
  naturalLanguage?: string | null;
  agentId: string;
  message: string;
  deliveryChannel?: string | null;
  deliveryChatId?: string | null;
  enabled: boolean;
  timezone?: string;
  maxRetries?: number;
  createdAt: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
}

/** Typed input for addCronHistory — compatible with CronHistory via structural typing */
interface CronHistoryInput {
  jobId: string;
  startedAt: string;
  finishedAt?: string | null;
  status: string;
  response?: string | null;
  error?: string | null;
  deliveryStatus?: string | null;
}

export function saveCronJob(job: CronJobInput): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO cron_jobs (id, name, expression, naturalLanguage, agentId, message, deliveryChannel, deliveryChatId, enabled, timezone, maxRetries, createdAt, lastRunAt, nextRunAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [job.id, job.name, job.expression, job.naturalLanguage ?? null, job.agentId, job.message,
     job.deliveryChannel ?? null, job.deliveryChatId ?? null, job.enabled ? 1 : 0,
     job.timezone ?? "Asia/Shanghai", job.maxRetries ?? 1, job.createdAt, job.lastRunAt ?? null, job.nextRunAt ?? null]
  );
  scheduleSave();
}

export function loadCronJobs(): Array<Record<string, unknown>> {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM cron_jobs");
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
    row.enabled = !!(row.enabled as number);
    return row;
  });
}

export function deleteCronJob(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM cron_jobs WHERE id = ?", [id]);
  scheduleSave();
}

export function addCronHistory(entry: CronHistoryInput): void {
  const db = getDatabase();
  db.run(
    "INSERT INTO cron_history (jobId, startedAt, finishedAt, status, response, error, deliveryStatus) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [entry.jobId, entry.startedAt, entry.finishedAt ?? null, entry.status, entry.response ?? null, entry.error ?? null, entry.deliveryStatus ?? null]
  );
  scheduleSave();
}

export function loadCronHistory(jobId: string, limit = 20): Array<Record<string, unknown>> {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM cron_history WHERE jobId = ? ORDER BY startedAt DESC LIMIT ?", [jobId, limit]);
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
    return row;
  });
}

// ─── MCP Servers Persistence ────────────────────────────────

export function saveMCPServer(server: Record<string, unknown>): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO mcp_servers (id, name, transport, command, args, url, env, auth, enabled, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [server.id, server.name, server.transport, server.command ?? null,
     JSON.stringify(server.args ?? []), server.url ?? null,
     JSON.stringify(server.env ?? {}), server.auth ? JSON.stringify(server.auth) : null,
     server.enabled ? 1 : 0, server.createdAt]
  );
  scheduleSave();
}

export function loadMCPServers(): Array<Record<string, unknown>> {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM mcp_servers");
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
    row.args = JSON.parse((row.args as string) || "[]");
    row.env = JSON.parse((row.env as string) || "{}");
    // B-5: 反序列化 auth 配置
    if (row.auth && typeof row.auth === "string") {
      try { row.auth = JSON.parse(row.auth); } catch { row.auth = undefined; }
    }
    row.enabled = !!(row.enabled as number);
    return row;
  });
}

export function deleteMCPServer(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM mcp_servers WHERE id = ?", [id]);
  scheduleSave();
}

// ─── Installed Skills Persistence ───────────────────────────

export function saveInstalledSkill(skill: Record<string, unknown>): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO installed_skills (id, name, source, sourceUrl, version, format, installedAt, updatedAt, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [skill.id, skill.name, skill.source, skill.sourceUrl ?? null, skill.version ?? "1.0.0",
     skill.format ?? "super-agent", skill.installedAt, skill.updatedAt, JSON.stringify(skill.metadata ?? {})]
  );
  scheduleSave();
}

export function loadInstalledSkills(): Array<Record<string, unknown>> {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM installed_skills");
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
    row.metadata = JSON.parse((row.metadata as string) || "{}");
    return row;
  });
}

export function deleteInstalledSkill(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM installed_skills WHERE id = ?", [id]);
  scheduleSave();
}

// ─── Security Policy Persistence ──────────────────────────────

export function saveSecurityPolicy(id: string, name: string, config: string): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO security_policies (id, name, config, createdAt) VALUES (?, ?, ?, ?)`,
    [id, name, config, new Date().toISOString()]
  );
  scheduleSave();
}

export function loadSecurityPolicies(): Array<{ id: string; name: string; config: string }> {
  const db = getDatabase();
  const results = db.exec("SELECT id, name, config FROM security_policies");
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => ({
    id: vals[0] as string,
    name: vals[1] as string,
    config: vals[2] as string,
  }));
}

export function deleteSecurityPolicy(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM security_policies WHERE id = ?", [id]);
  scheduleSave();
}

// ─── Collaboration History Persistence ───────────────────

export function saveCollabHistory(entry: {
  id: string;
  type: "crew" | "groupchat";
  name: string;
  status: string;
  result: string;
  durationMs: number;
}): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO collab_history (id, type, name, status, result, durationMs, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.type, entry.name, entry.status, entry.result, entry.durationMs, new Date().toISOString()]
  );
  scheduleSave();
}

export function loadCollabHistory(limit = 100): Array<Record<string, unknown>> {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM collab_history ORDER BY createdAt DESC LIMIT ?", [limit]);
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
    return row;
  });
}

export function deleteCollabHistory(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM collab_history WHERE id = ?", [id]);
  scheduleSave();
}

// ─── Evolution Tables Cleanup ────────────────────────────────

/**
 * Purge old evolution_cases that exceed either the maximum count or the
 * retention window.
 *
 * @param maxRows  Keep at most this many rows (default 500)
 * @param retentionDays  Delete rows older than this many days (default 30)
 * @returns Number of rows deleted
 */
export function purgeEvolutionCases(maxRows = 500, retentionDays = 30): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();

  // 1. Delete rows older than retention window
  db.run("DELETE FROM evolution_cases WHERE timestamp < ?", [cutoff]);

  // 2. Keep only the newest maxRows
  db.run(
    `DELETE FROM evolution_cases WHERE id NOT IN (
       SELECT id FROM evolution_cases ORDER BY timestamp DESC LIMIT ?
     )`,
    [maxRows],
  );

  const countRes = db.exec("SELECT changes()");
  const deleted = countRes.length ? (countRes[0].values[0][0] as number) : 0;
  if (deleted > 0) scheduleSave();
  return deleted;
}

/**
 * Purge old skill_proposals that are no longer relevant.
 *
 * @param maxRows  Keep at most this many rows (default 300)
 * @param retentionDays  Delete rows older than this many days (default 60)
 * @returns Number of rows deleted
 */
export function purgeSkillProposals(maxRows = 300, retentionDays = 60): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();

  db.run("DELETE FROM skill_proposals WHERE createdAt < ?", [cutoff]);
  db.run(
    `DELETE FROM skill_proposals WHERE id NOT IN (
       SELECT id FROM skill_proposals ORDER BY createdAt DESC LIMIT ?
     )`,
    [maxRows],
  );

  const countRes = db.exec("SELECT changes()");
  const deleted = countRes.length ? (countRes[0].values[0][0] as number) : 0;
  if (deleted > 0) scheduleSave();
  return deleted;
}

// ─── Credential Persistence (B-17) ───────────────────────

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
    [entry.name, entry.encryptedValue, entry.iv, entry.description ?? null,
     JSON.stringify(entry.allowedAgents ?? []), JSON.stringify(entry.allowedTools ?? []),
     new Date().toISOString()]
  );
  scheduleSave();
}

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
    results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
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

export function deleteCredentialFromDB(name: string): void {
  const db = getDatabase();
  db.run("DELETE FROM credentials WHERE name = ?", [name]);
  scheduleSave();
}

// ─── Channel Persistence (B-18) ─────────────────────────

export function saveChannel(channel: { id: string; config: Record<string, unknown>; status: string }): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO channels (id, config, status, createdAt)
     VALUES (?, ?, ?, ?)`,
    [channel.id, JSON.stringify(channel.config), channel.status, new Date().toISOString()]
  );
  scheduleSave();
}

export function loadChannels(): Array<{ id: string; config: Record<string, unknown>; status: string }> {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM channels");
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
    return {
      id: row.id as string,
      config: JSON.parse((row.config as string) || "{}"),
      status: row.status as string,
    };
  });
}

export function deleteChannel(id: string): boolean {
  const db = getDatabase();
  db.run("DELETE FROM channels WHERE id = ?", [id]);
  scheduleSave();
  return true;
}

// ─── Config Store (Phase B-2: Nudge 配置持久化) ───────────

/** 从 config_store 加载 Nudge 配置（启动时调用） */
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
    ["nudge_config", JSON.stringify(config), new Date().toISOString()]
  );
  scheduleSave();
}
