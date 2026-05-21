/**
 * SQLite schema migrations v17–v18（知识库 + credentials 修复）。
 *
 * 从 migrations.ts 拆分（B3 上帝文件拆分）：
 *   v17 — kb_documents / kb_chunks / kb_chunks_fts（知识库 Spec §5.1）
 *   v18 — credentials 列名 camelCase → snake_case（P0 安全加固）
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { logger } from "./logger.js";
import { type SqlJsDatabase } from "./constants.js";
import { setSchemaVersion } from "./schema.js";
// v3 Task 1：SQL 标识符白名单防御
import { safeIdent } from "./sql-safe.js";

/**
 * v17: 知识库 kb_documents / kb_chunks 表 + FTS5 索引（知识库 Spec §5.1）
 *
 * 核心建表：
 *   1. kb_documents：文档元数据（agentId + userId 两级隔离，nullable；content_hash 去重）
 *   2. kb_chunks   ：分块 + 向量（embedding BLOB，embedding_type 标记 Qwen/Simple）
 *   3. kb_chunks_fts：FTS5 虚拟表（BM25 混合检索用）+ insert/delete 触发器
 *   4. 部分唯一索引：UNIQUE(user_id, content_hash) WHERE user_id IS NOT NULL
 *      —— 决策 #3「同 user 内去重」（全局库 user_id=NULL 不约束，业务层补）
 */
export function migrateV17(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    // ── 1. kb_documents：文档元数据 ──
    db.run(`
      CREATE TABLE IF NOT EXISTS kb_documents (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        user_id TEXT,
        filename TEXT NOT NULL,
        mime TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        source_path TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        metadata TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_kb_docs_agent   ON kb_documents(agent_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_kb_docs_user    ON kb_documents(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_kb_docs_hash    ON kb_documents(content_hash)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_kb_docs_status  ON kb_documents(status)`);
    // 决策 #3：同 user 内去重（相同 user_id 下 content_hash 唯一；user_id=NULL 时不约束）
    // 注：SQLite NULL ≠ NULL，WHERE user_id IS NOT NULL 让全局库（user_id=NULL）不受限
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_docs_user_hash
        ON kb_documents(user_id, content_hash)
        WHERE user_id IS NOT NULL
    `);

    // ── 2. kb_chunks：分块 + 向量 ──
    db.run(`
      CREATE TABLE IF NOT EXISTS kb_chunks (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        embedding_type TEXT DEFAULT 'simple',
        token_count INTEGER DEFAULT 0,
        metadata TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id)`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_chunks_doc_idx ON kb_chunks(doc_id, chunk_index)`);

    // ── 3. kb_chunks_fts：FTS5 全文索引（BM25 用） ──
    // 用 content=kb_chunks + content_rowid=rowid 方式维护；rowid 由 SQLite 自动分配
    try {
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
          content,
          content=kb_chunks,
          content_rowid=rowid,
          tokenize='unicode61'
        )
      `);
      // insert 触发器：将 rowid + content 同步到 FTS5
      db.run(`
        CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_insert AFTER INSERT ON kb_chunks BEGIN
          INSERT INTO kb_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
        END
      `);
      // delete 触发器：删除时通知 FTS5（delete 命令写法）
      db.run(`
        CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_delete AFTER DELETE ON kb_chunks BEGIN
          INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        END
      `);
      // update 触发器：内容变化时先删后插
      db.run(`
        CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_update AFTER UPDATE OF content ON kb_chunks BEGIN
          INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
          INSERT INTO kb_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
        END
      `);
    } catch (e: any) {
      // FTS5 不可用时降级（仅向量检索，无 BM25）——不算致命错误
      logger.warn({ err: e.message }, "Migration v17: FTS5 kb_chunks_fts not available, BM25 search disabled");
    }

    setSchemaVersion(db, 17, "Add kb_documents + kb_chunks + kb_chunks_fts (知识库 Spec §5.1)");
    db.run("COMMIT");
    logger.info("Migration v17: Created kb_documents + kb_chunks + FTS5 triggers (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    if (e.message?.includes("already exists")) {
      setSchemaVersion(db, 17, "kb_documents/kb_chunks (skipped: already exists)");
      logger.info("Migration v17: skipped (already exists), version recorded");
    } else {
      logger.error({ err: e.message }, "Migration v17 failed, rolled back");
      throw e;
    }
  }
}

/**
 * v18: credentials 表列名统一为 snake_case（P0 安全加固 — 清除双定义遗留）
 *
 * 背景：schema.ts 中 credentials 表曾有两套定义（camelCase + snake_case），
 * IF NOT EXISTS 导致旧列名 DB 与新列名代码不匹配。
 *
 * 迁移步骤：
 *   1. 检测旧 camelCase 列是否存在（encryptedValue）
 *   2. 存在则 RENAME COLUMN encryptedValue → encrypted_value 等
 *   3. 添加旧 schema 中缺失的 description 列
 *   4. 幂等：新 DB 跳过 RENAME（列不存在则 catch 跳过）
 */
export function migrateV18(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    // 检测旧列是否存在（通过 PRAGMA table_info）
    const cols = db.exec("PRAGMA table_info(credentials)");
    const colNames = cols.length ? cols[0].values.map((v: unknown[]) => v[1] as string) : [];

    if (colNames.includes("encryptedValue")) {
      // 旧 camelCase → 新 snake_case 列重命名（每个 ALTER 独立 try-catch 确保幂等）
      const renames: [string, string][] = [
        ["encryptedValue", "encrypted_value"],
        ["allowedAgents", "allowed_agents"],
        ["allowedTools", "allowed_tools"],
      ];
      for (const [oldCol, newCol] of renames) {
        try {
          // v3 Task 1：表示识符白名单 —— oldCol/newCol 均为代码常量，步骤仅作防御深度
          db.run(`ALTER TABLE credentials RENAME COLUMN ${safeIdent(oldCol, "column")} TO ${safeIdent(newCol, "column")}`);
          logger.info({ oldCol, newCol }, "Migration v18: renamed credentials column");
        } catch { /* 列已重命名或不存在，幂等跳过 */ }
      }
    }

    // 添加 description 列（旧 schema 无此列）
    if (!colNames.includes("description")) {
      try {
        db.run("ALTER TABLE credentials ADD COLUMN description TEXT");
        logger.info("Migration v18: added description column to credentials");
      } catch { /* 列已存在 */ }
    }

    setSchemaVersion(db, 18, "credentials: camelCase → snake_case column rename (P0 fix)");
    db.run("COMMIT");
    logger.info("Migration v18: credentials columns normalized to snake_case (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    logger.error({ err: e.message }, "Migration v18 failed, rolled back");
    throw e;
  }
}
