/**
 * SQLite v1 baseline 表结构 + Schema 版本 helpers。
 *
 * CORE-P1-02 批 1：从原 sqlite.ts 抽出
 *   - L46-73 ensureSchemaVersionTable / getSchemaVersion / setSchemaVersion（原 file-private → export）
 *   - L724-1055 initDatabase 内 v1 baseline 事务块（16 CREATE TABLE + 3 FTS5 + triggers + cron ALTER + 基线标记）
 *     抽成 createInitialSchema(db) 函数，由 client.ts 的 initDatabase 调用。
 *
 * 历史遗留：credentials 表在本文件内存在双定义（L766-777 旧列 vs L942-952 新列），
 * IF NOT EXISTS 保护下后定义被跳过。本次拆分原样保留，不改 SQL 语义。
 *
 * DAG 位置：logger/constants → **schema** → migrations → client → repo
 */

import { logger } from "./logger.js";
import type { SqlJsDatabase } from "./constants.js";

// ─── Schema Version Helpers ──────────────────────────────────

/** Ensure the schema_version table exists (called before any migration). */
export function ensureSchemaVersionTable(db: SqlJsDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      description TEXT
    )
  `);
}

/** Get the current schema version (0 if no version recorded yet). */
export function getSchemaVersion(db: SqlJsDatabase): number {
  try {
    const results = db.exec("SELECT MAX(version) FROM schema_version");
    if (results.length && results[0].values.length && results[0].values[0][0] !== null) {
      return results[0].values[0][0] as number;
    }
  } catch { /* table may not exist yet */ }
  return 0;
}

/** Record a schema version after a successful migration. */
export function setSchemaVersion(db: SqlJsDatabase, version: number, description: string): void {
  db.run(
    "INSERT OR REPLACE INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)",
    [version, new Date().toISOString(), description]
  );
}

// ─── v1 Baseline Schema ──────────────────────────────────────

/**
 * 创建 v1 baseline 表结构与 FTS5 虚表（幂等，IF NOT EXISTS 保护）。
 * 调用方：client.ts 的 initDatabase()，在 ensureSchemaVersionTable 之后、runMigrations 之前调用。
 *
 * 内容：
 *   - 16 个业务表：memories / agents / sessions / credentials(旧+新) / security_policies /
 *     audit_log / evolution_cases / skill_proposals / evolution_snapshots / core_blocks /
 *     cron_jobs / cron_history / installed_skills / mcp_servers / collab_history / channels /
 *     conversations / conv_messages
 *   - 4 条 ALTER TABLE cron_jobs ADD COLUMN（v3 Task 3-8a 遗留）
 *   - 3 个 FTS5 虚表：memories_fts / sessions_fts / conv_messages_fts
 *   - 2 个 conv_messages FTS triggers：conv_fts_insert / conv_fts_delete
 *   - 基线标记：setSchemaVersion(db, 1, "Baseline: ...")
 */
export function createInitialSchema(db: SqlJsDatabase): void {
  // Create tables (wrapped in transaction for atomicity — P1-03)
  db.run("BEGIN TRANSACTION");
  try {

    db.run(`
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

    db.run(`CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agentId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`);

    db.run(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        createdAt TEXT NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        userId TEXT,
        messages TEXT DEFAULT '[]',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agentId)`);

    // P0 修复：旧 camelCase credentials 定义已删除，统一使用下方的 snake_case 版本
    // 历史 DB 通过 Migration 18 自动重命名列

    db.run(`
      CREATE TABLE IF NOT EXISTS security_policies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        config TEXT NOT NULL,
        createdAt TEXT NOT NULL
      )
    `);

    db.run(`
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

    db.run(`CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp)`);

    db.run(`
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

    db.run(`
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

    db.run(`
      CREATE TABLE IF NOT EXISTS evolution_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stageIndex INTEGER NOT NULL,
        avgScore REAL,
        proposalCount INTEGER DEFAULT 0,
        activeProposals TEXT DEFAULT '[]',
        timestamp TEXT NOT NULL
      )
    `);

    db.run(`
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
    db.run(`
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
    // @why 列已存在时 SQLite 会抛 "duplicate column name"，这是幂等迁移的预期行为；
    //       仅在 debug 级别记录，避免日志噪声但保留可观察性。
    const tryAlter = (sql: string, col: string) => {
      try { db.run(sql); }
      catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // duplicate column 是预期：列已存在；其他错误才需关注
        if (!/duplicate column/i.test(msg)) {
          logger.debug({ col, err: msg }, "ALTER TABLE cron_jobs ADD COLUMN failed (non-fatal)");
        }
      }
    };
    tryAlter(`ALTER TABLE cron_jobs ADD COLUMN scheduleType TEXT DEFAULT 'cron'`, "scheduleType");
    tryAlter(`ALTER TABLE cron_jobs ADD COLUMN runAt TEXT`, "runAt");
    tryAlter(`ALTER TABLE cron_jobs ADD COLUMN intervalMs INTEGER`, "intervalMs");
    tryAlter(`ALTER TABLE cron_jobs ADD COLUMN timeoutSeconds INTEGER`, "timeoutSeconds");

    db.run(`
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

    db.run(`CREATE INDEX IF NOT EXISTS idx_cron_history_job ON cron_history(jobId)`);
    // P3-T8: 补充 startedAt 索引（按时间范围查询 cron 历史记录）
    db.run(`CREATE INDEX IF NOT EXISTS idx_cron_history_started ON cron_history(startedAt)`);

    // ─── Installed Skills Table ────────────────────────────────
    db.run(`
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
    db.run(`
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
    db.run(`
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
    db.run(`CREATE INDEX IF NOT EXISTS idx_collab_history_type ON collab_history(type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_collab_history_ts ON collab_history(createdAt)`);

    // ─── Credentials Table (B-17) ───────────────────────────────
    // 历史遗留：本段与上方 L766-777 旧定义重复，IF NOT EXISTS 保护下本段被跳过。
    // 保留原样，不在本次拆分范畴。
    db.run(`
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
    db.run(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        config TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'configuring',
        createdAt TEXT NOT NULL
      )
    `);

    // ─── Conversations & Messages Tables ────────────────────────
    db.run(`
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
    db.run(`CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversations(agentId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updatedAt DESC)`);

    db.run(`
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
    db.run(`CREATE INDEX IF NOT EXISTS idx_cmsg_conv ON conv_messages(conversationId, timestamp)`);

    // ─── FTS5 Full-Text Search（better-sqlite3 原生支持 FTS5，直接创建） ───
    // FTS5 for memories full-text search
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED, agentId, content, type,
        tokenize='unicode61'
      )
    `);

    // FTS5 for session messages search
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        sessionId UNINDEXED, agentId, content,
        tokenize='unicode61'
      )
    `);

    // FTS5 for conversation messages search (content-sync table with triggers)
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conv_messages_fts USING fts5(
        content,
        content=conv_messages,
        content_rowid=id,
        tokenize='unicode61'
      )
    `);
    db.run(`
      CREATE TRIGGER IF NOT EXISTS conv_fts_insert AFTER INSERT ON conv_messages BEGIN
        INSERT INTO conv_messages_fts(rowid, content) VALUES (new.id, new.content);
      END
    `);
    db.run(`
      CREATE TRIGGER IF NOT EXISTS conv_fts_delete AFTER DELETE ON conv_messages BEGIN
        INSERT INTO conv_messages_fts(conv_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      END
    `);

    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }

  // ── Record baseline schema version if this is a fresh DB ──
  if (getSchemaVersion(db) < 1) {
    setSchemaVersion(db, 1, "Baseline: all initial CREATE TABLE IF NOT EXISTS");
    logger.info("Schema version set to 1 (baseline)");
  }
}
