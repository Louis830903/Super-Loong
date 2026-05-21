/**
 * SQLite schema migrations v2–v9（基础字段 + FTS + 实体 + 配置存储）。
 *
 * 从 migrations.ts 拆分（B3 上帝文件拆分）：
 *   v2  — llm_providers.api_key_iv（AES 加密列）
 *   v3  — conversations.modelOverride
 *   v4  — FTS5 auto-maintenance triggers
 *   v5  — memories 信任评分列
 *   v6  — memories_fts_v6 全文索引
 *   v7  — entities + memory_entities 实体解析表
 *   v8  — memories.embedding_type 嵌入类型标记
 *   v9  — config_store 键值持久化表
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { logger } from "./logger.js";
import { type SqlJsDatabase } from "./constants.js";
import { setSchemaVersion } from "./schema.js";

/** v2: Add api_key_iv column to llm_providers for AES-256-CBC encryption. */
export function migrateV2(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run("ALTER TABLE llm_providers ADD COLUMN api_key_iv TEXT DEFAULT ''");
    setSchemaVersion(db, 2, "Add api_key_iv column for AES encryption");
    db.run("COMMIT");
    logger.info("Migration v2: Added api_key_iv column to llm_providers (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
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
export function migrateV3(db: SqlJsDatabase): void {
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
 * Follows Hermes messages_fts trigger pattern.
 */
export function migrateV4(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`CREATE TRIGGER IF NOT EXISTS conv_msg_fts_ai AFTER INSERT ON conv_messages
      BEGIN
        INSERT INTO conv_messages_fts(rowid, content)
        VALUES (NEW.id, NEW.content);
      END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS conv_msg_fts_ad AFTER DELETE ON conv_messages
      BEGIN
        INSERT INTO conv_messages_fts(conv_messages_fts, rowid, content)
        VALUES ('delete', OLD.id, OLD.content);
      END`);
    logger.info("Migration v4: Created conv_messages FTS5 triggers");

    db.run(`CREATE TRIGGER IF NOT EXISTS mem_fts_ai AFTER INSERT ON memories
      BEGIN
        INSERT OR REPLACE INTO memories_fts(id, agentId, content, type)
        VALUES (NEW.id, NEW.agentId, NEW.content, NEW.type);
      END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS mem_fts_au AFTER UPDATE ON memories
      BEGIN
        INSERT OR REPLACE INTO memories_fts(id, agentId, content, type)
        VALUES (NEW.id, NEW.agentId, NEW.content, NEW.type);
      END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS mem_fts_ad AFTER DELETE ON memories
      BEGIN
        DELETE FROM memories_fts WHERE id = OLD.id;
      END`);
    logger.info("Migration v4: Created memories FTS5 triggers");

    setSchemaVersion(db, 4, "Add FTS5 auto-maintenance triggers (Hermes pattern)");
    db.run("COMMIT");
    logger.info("Migration v4: FTS5 triggers committed");
  } catch (e: any) {
    db.run("ROLLBACK");
    logger.error({ err: e.message }, "Migration v4 failed, rolled back");
    setSchemaVersion(db, 4, "FTS5 triggers migration failed (non-fatal)");
  }
}

/** v5: Add trust_score and helpful_count columns to memories for trust scoring system (学 Hermes store.py). */
export function migrateV5(db: SqlJsDatabase): void {
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
 */
export function migrateV6(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts_v6
        USING fts5(content, content=memories, content_rowid=rowid)
    `);
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
    db.run(`INSERT INTO memories_fts_v6(rowid, content) SELECT rowid, content FROM memories`);
    setSchemaVersion(db, 6, "Add memories_fts_v6 FTS5 index with auto-sync triggers");
    db.run("COMMIT");
    logger.info("Migration v6: FTS5 index created with auto-sync triggers (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    setSchemaVersion(db, 6, `FTS5 migration skipped: ${e.message?.slice(0, 100)}`);
    logger.warn({ err: e.message }, "Migration v6: FTS5 not available, skipped (non-fatal)");
  }
}

/** v7: 实体解析表（学 Hermes entities + fact_entities 关联模式） */
export function migrateV7(db: SqlJsDatabase): void {
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
export function migrateV8(db: SqlJsDatabase): void {
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
export function migrateV9(db: SqlJsDatabase): void {
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
