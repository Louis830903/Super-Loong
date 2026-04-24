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
const CURRENT_SCHEMA_VERSION = 14;

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

  // ── v10: subagent_runs 表（I-2 孤儿回收 + 子代理持久化） ──
  if (currentVersion < 10) migrateV10(db);

  // ── v11: T1 记忆优先级（hello-agents 借鉴）──
  // memories 表新增 priority / relevanceScore 两列，加联合索引
  if (currentVersion < 11) migrateV11(db);

  // ── v12: T6 知识图谱三元组表（hello-agents SemanticMemory 借鉴）──
  // 新建 relations 表 + 三个索引（subject/object/unique triple）
  if (currentVersion < 12) migrateV12(db);

  // ── v13: T5 A2A Agent 注册表（跨进程 Agent 发现） ──
  if (currentVersion < 13) migrateV13(db);

  // ── v14: T5 A2A Task 持久化（Task 状态机 + 产物/历史） ──
  if (currentVersion < 14) migrateV14(db);
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
 * v10: I-2 子代理运行记录表（孤儿回收 + 持久化）。
 * 用于 SubagentManager 将 spawn/complete/kill 状态持久化到 SQLite，
 * 进程重启后通过 reconcileOrphans() 恢复未完成的子代理记录。
 */
function migrateV10(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS subagent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL,
        task TEXT NOT NULL,
        label TEXT,
        depth INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK(status IN ('running','success','error','timeout','killed','orphan_recovered','archived')),
        created_at TEXT NOT NULL,
        completed_at TEXT,
        result TEXT,
        error TEXT
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_subagent_runs_status ON subagent_runs(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON subagent_runs(parent_session_id)`);
    setSchemaVersion(db, 10, "Add subagent_runs table for orphan recovery (I-2)");
    db.run("COMMIT");
    logger.info("Migration v10: Created subagent_runs table (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    if (e.message?.includes("already exists")) {
      setSchemaVersion(db, 10, "subagent_runs table (skipped: already exists)");
      logger.info("Migration v10: skipped (table already exists), version recorded");
    } else {
      logger.error({ err: e.message }, "Migration v10 failed, rolled back");
      throw e;
    }
  }
}

/**
 * v11: T1 记忆优先级字段（参考 hello-agents NoteTool 分类）。
 * - priority TEXT  CHECK 枚举（blocker / action / task_state / conclusion / normal）默认 normal
 * - relevanceScore REAL  与 trustScore 解耦的预留评分，默认 0.5
 * - 联合索引 idx_memories_priority 加速按 agentId+priority 过滤
 * 幂等实现：重复运行不报错（duplicate column 走 skipped 分支）。
 */
function migrateV11(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    // SQLite ALTER TABLE 仅支持 ADD COLUMN，CHECK 约束随列一同创建
    db.run(
      "ALTER TABLE memories ADD COLUMN priority TEXT " +
      "CHECK(priority IN ('blocker','action','task_state','conclusion','normal')) " +
      "DEFAULT 'normal'"
    );
    db.run("ALTER TABLE memories ADD COLUMN relevanceScore REAL DEFAULT 0.5");
    // 加联合索引（检索时常以 agentId 为主过滤 + priority 排序）
    db.run("CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(agentId, priority)");
    setSchemaVersion(db, 11, "Add priority + relevanceScore columns to memories (T1)");
    db.run("COMMIT");
    logger.info("Migration v11: Added priority/relevanceScore columns to memories (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    if (e.message?.includes("duplicate column")) {
      // 列已存在（复跑场景），仅补索引并记录版本
      try {
        db.run("CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(agentId, priority)");
      } catch { /* index may also exist */ }
      setSchemaVersion(db, 11, "Priority columns (skipped: already exist)");
      logger.info("Migration v11: skipped (columns already exist), version recorded");
    } else {
      logger.error({ err: e.message }, "Migration v11 failed, rolled back");
      throw e;
    }
  }
}

/**
 * v12: T6 知识图谱三元组表 + 三个索引
 * 实体间关系建模（主体-谓词-客体），支持递归 CTE 子图查询。
 * 参考 hello-agents 第 8 章 SemanticMemory 设计。
 */
function migrateV12(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        subjectId INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        predicate TEXT NOT NULL,
        objectId INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),
        source TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        metadata TEXT DEFAULT '{}'
      )
    `);
    // 主体+谓词 索引：快速查找某实体的所有出边
    db.run(`CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations(subjectId, predicate)`);
    // 客体+谓词 索引：快速查找某实体的所有入边
    db.run(`CREATE INDEX IF NOT EXISTS idx_relations_object ON relations(objectId, predicate)`);
    // 三元组唯一索引：防止重复插入（upsert 用）
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_triple ON relations(subjectId, predicate, objectId)`);

    setSchemaVersion(db, 12, "Add relations table for knowledge graph triples (T6)");
    db.run("COMMIT");
    logger.info("Migration v12: Created relations table with 3 indexes (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    if (e.message?.includes("already exists")) {
      setSchemaVersion(db, 12, "relations table (skipped: already exists)");
      logger.info("Migration v12: skipped (table already exists), version recorded");
    } else {
      logger.error({ err: e.message }, "Migration v12 failed, rolled back");
      throw e;
    }
  }
}

/**
 * v13: T5 A2A Agent 注册表
 * 跨进程 Agent 发现与注册。支持 online/offline/draining 三态 + 心跳 TTL 过期。
 * 参考 Spec §5.3 Task 5.2 + §7.2 Agent Card 标准。
 */
function migrateV13(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS agent_registry (
        agentId TEXT PRIMARY KEY,
        card TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        lastHeartbeat TEXT NOT NULL,
        ttlMs INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('online','offline','draining'))
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_agent_registry_status ON agent_registry(status)`);

    setSchemaVersion(db, 13, "Add agent_registry table for A2A agent discovery (T5)");
    db.run("COMMIT");
    logger.info("Migration v13: Created agent_registry table with status index (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    if (e.message?.includes("already exists")) {
      setSchemaVersion(db, 13, "agent_registry table (skipped: already exists)");
      logger.info("Migration v13: skipped (table already exists), version recorded");
    } else {
      logger.error({ err: e.message }, "Migration v13 failed, rolled back");
      throw e;
    }
  }
}

/**
 * v14: T5 A2A Task 持久化
 * Task 状态机 8 态 + 完整 JSON payload（artifacts + history）。
 * 参考 Spec §7.3 Task 7.3 + a2a.proto Task message。
 */
function migrateV14(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS a2a_tasks (
        id TEXT PRIMARY KEY,
        contextId TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN
          ('submitted','working','input-required','auth-required',
           'completed','failed','canceled','rejected')),
        payload TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context ON a2a_tasks(contextId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_a2a_tasks_state ON a2a_tasks(state)`);

    setSchemaVersion(db, 14, "Add a2a_tasks table for A2A task persistence (T5)");
    db.run("COMMIT");
    logger.info("Migration v14: Created a2a_tasks table with 2 indexes (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    if (e.message?.includes("already exists")) {
      setSchemaVersion(db, 14, "a2a_tasks table (skipped: already exists)");
      logger.info("Migration v14: skipped (table already exists), version recorded");
    } else {
      logger.error({ err: e.message }, "Migration v14 failed, rolled back");
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

  // [v3 Task 3-8a] 新增调度类型字段（ALTER TABLE ADD COLUMN 仅对已有表有效）
  try { _db.run(`ALTER TABLE cron_jobs ADD COLUMN scheduleType TEXT DEFAULT 'cron'`); } catch {}
  try { _db.run(`ALTER TABLE cron_jobs ADD COLUMN runAt TEXT`); } catch {}
  try { _db.run(`ALTER TABLE cron_jobs ADD COLUMN intervalMs INTEGER`); } catch {}
  try { _db.run(`ALTER TABLE cron_jobs ADD COLUMN timeoutSeconds INTEGER`); } catch {}

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
    // ISSUE-5 修复：重置 FTS5 缓存，确保下次 initDatabase 后重新检测
    _fts5Cache = null;
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
      `INSERT OR REPLACE INTO memories (id, agentId, userId, content, type, embedding, metadata, createdAt, updatedAt, trust_score, helpful_count, retrieval_count, embedding_type, priority, relevanceScore)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        // ✨ T1: 业务优先级（默认 normal，配合 PRIORITY_BOOST 加权）
        entry.priority ?? "normal",
        // ✨ T1: 相关性预留字段（与 trustScore 解耦）
        entry.relevanceScore ?? 0.5,
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

  async update(id: string, updates: Partial<Pick<MemoryEntry, "content" | "metadata" | "embedding" | "trustScore" | "helpfulCount" | "retrievalCount" | "priority" | "relevanceScore">>): Promise<void> {
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
    // ✨ T1: 优先级与相关性写入
    if (updates.priority !== undefined) {
      sets.push("priority = ?");
      params.push(updates.priority);
    }
    if (updates.relevanceScore !== undefined) {
      sets.push("relevanceScore = ?");
      params.push(updates.relevanceScore);
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
    // P0-1: FTS5 优先搜索（BM25 排序，O(log N)），LIKE 兜底
    if (hasFTS5()) {
      try {
        const ftsResults = this.searchViaFTS5(query, filters, topK);
        if (ftsResults.length > 0) return ftsResults;
      } catch { /* FTS5 查询异常，fallback 到 LIKE */ }
    }

    // Fallback: 全表遍历 + JS 层关键词匹配（原有逻辑，保持不变）
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

  /**
   * P0-1: FTS5 搜索内部方法。
   * BUG-2 修复：优先使用 v6 内容同步表（rowid JOIN，更规范），兼容回退旧表（id JOIN）。
   * 安全处理：双引号转义 + 短语包裹，防止 FTS5 语法注入。
   */
  private searchViaFTS5(query: string, filters: MemoryFilter, topK: number): MemorySearchResult[] {
    const safeQuery = '"' + query.replace(/"/g, '""') + '"';

    // BUG-2: 优先使用 v6 内容同步表（rowid 关联，标准 FTS5 维护模式）
    const useV6 = hasFTS5v6();
    let sql: string;
    if (useV6) {
      sql = `
        SELECT m.* FROM memories m
        JOIN memories_fts_v6 f ON m.rowid = f.rowid
        WHERE f.memories_fts_v6 MATCH ?
      `;
    } else {
      sql = `
        SELECT m.* FROM memories m
        JOIN memories_fts f ON m.id = f.id
        WHERE f.memories_fts MATCH ?
      `;
    }
    const params: unknown[] = [safeQuery];

    if (filters.agentId) { sql += " AND m.agentId = ?"; params.push(filters.agentId); }
    if (filters.userId) { sql += " AND m.userId = ?"; params.push(filters.userId); }
    if (filters.type) { sql += " AND m.type = ?"; params.push(filters.type); }

    sql += " ORDER BY f.rank LIMIT ?";
    params.push(topK);

    const results = this.db.exec(sql, params);
    if (!results.length) return [];

    // 利用已有的 resultToEntries 反序列化完整 MemoryEntry
    // ISSUE-6: 用位置倒数近似 BM25 权重（比固定 1.0 更有信息量）
    return this.resultToEntries(results[0]).map((entry, i) => ({
      entry,
      score: 1.0 / (1 + i),
    }));
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
      // ✨ T1: 业务优先级与相关性预留
      priority: ((row.priority as string) ?? "normal") as MemoryEntry["priority"],
      relevanceScore: (row.relevanceScore as number) ?? 0.5,
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

/** P2-1: hasFTS5() 结果缓存 — 避免每次调用都查 sqlite_master */
let _fts5Cache: boolean | null = null;

/** Check if FTS5 tables are available (cached after first check) */
// BUG-2 修复：统一检查 v6 表（内容同步表，更规范的 FTS5 维护模式）
function hasFTS5(): boolean {
  if (_fts5Cache !== null) return _fts5Cache;
  try {
    const db = getDatabase();
    // 优先检查 v6 表，兼容回退到旧表
    const rv6 = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts_v6'");
    if (rv6.length > 0 && rv6[0].values.length > 0) {
      _fts5Cache = true;
      return true;
    }
    const r = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'");
    _fts5Cache = r.length > 0 && r[0].values.length > 0;
  } catch { _fts5Cache = false; }
  return _fts5Cache;
}

/** 检查是否有 v6 版内容同步 FTS5 表（用于选择 JOIN 策略） */
function hasFTS5v6(): boolean {
  try {
    const db = getDatabase();
    const r = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts_v6'");
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
  /** [v3 Task 3-8a] 新增字段 */
  scheduleType?: string | null;
  runAt?: string | null;
  intervalMs?: number | null;
  timeoutSeconds?: number | null;
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
    `INSERT OR REPLACE INTO cron_jobs (id, name, expression, naturalLanguage, agentId, message, deliveryChannel, deliveryChatId, enabled, timezone, maxRetries, createdAt, lastRunAt, nextRunAt, scheduleType, runAt, intervalMs, timeoutSeconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [job.id, job.name, job.expression, job.naturalLanguage ?? null, job.agentId, job.message,
     job.deliveryChannel ?? null, job.deliveryChatId ?? null, job.enabled ? 1 : 0,
     job.timezone ?? "Asia/Shanghai", job.maxRetries ?? 1, job.createdAt, job.lastRunAt ?? null, job.nextRunAt ?? null,
     job.scheduleType ?? "cron", job.runAt ?? null, job.intervalMs ?? null, job.timeoutSeconds ?? null]
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

/** [v3 Task 2-2] 清理超过 retentionDays 天的 cron 执行历史 */
export function cleanupOldCronHistory(retentionDays = 30): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  db.run("DELETE FROM cron_history WHERE startedAt < ?", [cutoff]);
  // sql.js 没有 changes()，返回 -1 表示已执行但无法知道具体数量
  scheduleSave();
  return -1;
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

/** M-2: 按 id 查询单条协作历史记录（用于 getResultById 的 DB fallback） */
export function loadCollabHistoryById(id: string): Record<string, unknown> | undefined {
  const db = getDatabase();
  const results = db.exec("SELECT * FROM collab_history WHERE id = ? LIMIT 1", [id]);
  if (!results.length || !results[0].values.length) return undefined;
  const row: Record<string, unknown> = {};
  results[0].columns.forEach((col: string, i: number) => { row[col] = results[0].values[0][i]; });
  return row;
}

// ─── I-2: Subagent Runs Persistence ────────────────────────────

/**
 * I-2: 保存子代理运行记录到 DB（P1: fire-and-forget 调用，不阻塞 spawn）。
 */
export function saveSubagentRun(entry: {
  id: string;
  sessionId: string;
  parentSessionId: string;
  task: string;
  label?: string;
  depth: number;
  status: string;
  createdAt: string;
}): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO subagent_runs (id, session_id, parent_session_id, task, label, depth, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.sessionId, entry.parentSessionId, entry.task, entry.label ?? null, entry.depth, entry.status, entry.createdAt]
  );
  scheduleSave();
}

/**
 * I-2: 更新子代理运行状态。
 */
export function updateSubagentRunStatus(id: string, status: string, completedAt?: string, result?: string, error?: string): void {
  const db = getDatabase();
  db.run(
    `UPDATE subagent_runs SET status = ?, completed_at = ?, result = ?, error = ? WHERE id = ?`,
    [status, completedAt ?? null, result?.slice(0, 2000) ?? null, error?.slice(0, 1000) ?? null, id]
  );
  scheduleSave();
}

/**
 * I-2/R4: 将某个 parent session 下所有 running 状态的子代理标记为 cancelled。
 * 用于 E-3 abort 时同步更新 DB 状态，防止 reconcileOrphans 误判。
 */
export function markSubagentRunsCancelled(parentSessionId: string): number {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE subagent_runs SET status = 'killed', completed_at = ? WHERE parent_session_id = ? AND status = 'running'`,
    [now, parentSessionId]
  );
  scheduleSave();
  return result.changes ?? 0;
}

/**
 * I-2: 查询孤儿子代理（运行超过指定时间仍为 running 的记录）。
 */
export function findOrphanSubagentRuns(thresholdMs = 30 * 60 * 1000): Array<Record<string, unknown>> {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  const results = db.exec(
    `SELECT * FROM subagent_runs WHERE status = 'running' AND created_at < ?`,
    [cutoff]
  );
  if (!results.length) return [];
  return results[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {};
    results[0].columns.forEach((col: string, i: number) => { row[col] = vals[i]; });
    return row;
  });
}

/**
 * I-2/M3: 将 DB 中子代理记录标记为 archived（配合 G-4 惰性清理同步）。
 */
export function archiveSubagentRun(id: string): void {
  const db = getDatabase();
  db.run(`UPDATE subagent_runs SET status = 'archived' WHERE id = ?`, [id]);
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
