/**
 * SQLite schema migrations (v2..v16)。
 *
 * CORE-P1-02 批 1：从原 sqlite.ts L80-683 抽出。
 *   - runMigrations：纯调度器，按版本号依次调用各 migrateVN
 *   - migrateV2..V16：独立的版本升级函数，每个函数自带事务 + 幂等保护
 *
 * 新增 migration 步骤：
 *   1. 在本文件末尾新增 migrateV17 函数
 *   2. 在 runMigrations 内新增 `if (currentVersion < 17) migrateV17(db);`
 *   3. 将 constants.ts 的 `CURRENT_SCHEMA_VERSION` bump 到 17
 *
 * DAG 位置：logger/constants/schema → **migrations** → client → repo
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { logger } from "./logger.js";
import { CURRENT_SCHEMA_VERSION, type SqlJsDatabase } from "./constants.js";
import { getSchemaVersion, setSchemaVersion } from "./schema.js";
// v3 Task 1：SQL 标识符白名单防御，所有动态拼接的表名/列名必须走 safeIdent
import { safeIdent, assertSafeIdentifiers } from "./sql-safe.js";

/**
 * Run all pending schema migrations sequentially.
 * Each migrateVN function is idempotent (uses try/catch for ALTER TABLE).
 * Add new migrations here by bumping CURRENT_SCHEMA_VERSION and adding a migrateVN() call.
 */
export function runMigrations(db: SqlJsDatabase): void {
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

  // ── v15: video_jobs 表（Spec §4.4 视频任务持久化） ──
  if (currentVersion < 15) migrateV15(db);

  // ── v16: video_jobs 扩列 + agent_provider_templates 表（Spec §4.4 模型配置模板） ──
  if (currentVersion < 16) migrateV16(db);

  // ── v17: 知识库 kb_documents / kb_chunks 表 + FTS5 索引（知识库 Spec §5.1） ──
  if (currentVersion < 17) migrateV17(db);

  // ── v18: credentials 表列名统一 snake_case（P0 修复） ──
  if (currentVersion < 18) migrateV18(db);

  // ── v19: entities.name UNIQUE COLLATE NOCASE（P1 大小写重复实体修复） ──
  if (currentVersion < 19) migrateV19(db);

  // ── v20: 时间戳类型统一 INTEGER → TEXT（P3-T9）──
  if (currentVersion < 20) migrateV20(db);
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
    // ── conv_messages FTS5 triggers（better-sqlite3 原生支持 FTS5，表保证存在）──
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

    // ── memories FTS5 triggers（better-sqlite3 原生支持 FTS5，表保证存在）──
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
 * 注意：better-sqlite3 原生支持 FTS5，try/catch 为防御性保护。
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
    // better-sqlite3 原生支持 FTS5，此 catch 仅作防御性保护
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
 * v15: 视频任务表（Spec §4.4 video_jobs）
 * 不含 agent_providers 列（V16 再加），保持版本递进。
 */
function migrateV15(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS video_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        input_json TEXT,
        progress_json TEXT,
        output_json TEXT,
        error TEXT,
        workspace_dir TEXT,
        cost_estimate_cny REAL DEFAULT 0,
        cost_actual_cny REAL,
        cost_limit_cny REAL DEFAULT 5.0,
        concurrency_slot INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_video_jobs_created ON video_jobs(created_at)`);

    setSchemaVersion(db, 15, "Add video_jobs table (Spec §4.4)");
    db.run("COMMIT");
    logger.info("Migration v15: Created video_jobs table with 2 indexes (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    if (e.message?.includes("already exists")) {
      setSchemaVersion(db, 15, "video_jobs table (skipped: already exists)");
      logger.info("Migration v15: skipped (table already exists), version recorded");
    } else {
      logger.error({ err: e.message }, "Migration v15 failed, rolled back");
      throw e;
    }
  }
}

/**
 * v16: video_jobs 扩列 + agent_provider_templates 模板表（Spec §4.4）
 * 1. ALTER TABLE video_jobs ADD COLUMN agent_providers / agent_provider_template_id
 * 2. CREATE TABLE agent_provider_templates + 4 条系统预设
 */
function migrateV16(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    // 扩列 video_jobs（ALTER TABLE ADD COLUMN 幂等：已有则 catch 跳过）
    try { db.run("ALTER TABLE video_jobs ADD COLUMN agent_providers TEXT"); } catch { /* 列已存在 */ }
    try { db.run("ALTER TABLE video_jobs ADD COLUMN agent_provider_template_id TEXT"); } catch { /* 列已存在 */ }

    // 创建模板表
    db.run(`
      CREATE TABLE IF NOT EXISTS agent_provider_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        providers_json TEXT NOT NULL,
        is_preset INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);

    // 4 条系统预设（INSERT OR IGNORE 幂等）
    const now = Date.now();
    const presets = [
      { id: "preset_balanced", name: "均衡推荐", desc: "性价比最优，DeepSeek+Qwen 组合", key: "balanced" },
      { id: "preset_cheap", name: "最省成本", desc: "全部使用最低价模型", key: "cheap" },
      { id: "preset_zh_best", name: "中文最优", desc: "中文能力最强模型组合", key: "zh_best" },
      { id: "preset_local", name: "本地部署", desc: "全部使用 Ollama 本地模型", key: "local" },
    ];
    for (const p of presets) {
      db.run(
        `INSERT OR IGNORE INTO agent_provider_templates (id, name, description, providers_json, is_preset, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
        [p.id, p.name, p.desc, JSON.stringify({ preset: p.key }), now]
      );
    }

    setSchemaVersion(db, 16, "Add agent_providers columns to video_jobs + agent_provider_templates table (Spec §4.4)");
    db.run("COMMIT");
    logger.info("Migration v16: Extended video_jobs + created agent_provider_templates with 4 presets (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    if (e.message?.includes("already exists")) {
      setSchemaVersion(db, 16, "agent_provider_templates (skipped: already exists)");
      logger.info("Migration v16: skipped (already exists), version recorded");
    } else {
      logger.error({ err: e.message }, "Migration v16 failed, rolled back");
      throw e;
    }
  }
}

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
function migrateV17(db: SqlJsDatabase): void {
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
function migrateV18(db: SqlJsDatabase): void {
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

/**
 * v19: entities.name UNIQUE COLLATE NOCASE（P2-T13 知识图谱大小写重复实体修复）
 *
 * 背景：entities 表使用 INSERT OR IGNORE 写入，但 name 列无 UNIQUE 约束，
 * COLLATE NOCASE 查询能找到已有记录，但 INSERT 仍会创建大小写变体重复行。
 *
 * 迁移步骤：
 *   1. 去重：为每个不区分大小写的 name 保留 id 最小的记录，删除其余
 *   2. 重建索引：DROP 旧 idx_entities_name，新建 UNIQUE COLLATE NOCASE 索引
 */
function migrateV19(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    // Step 1: 检测表是否存在（v7 创建，但极端情况可能不存在）
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='entities'");
    if (!tables.length || !tables[0].values.length) {
      // 表不存在，直接标记版本（后续 v7 创建时一并处理）
      setSchemaVersion(db, 19, "entities.name UNIQUE COLLATE NOCASE (skipped: table not found)");
      db.run("COMMIT");
      logger.info("Migration v19: skipped (entities table not found), version recorded");
      return;
    }

    // Step 2: 去重 — 为每个 LOWER(name) 组保留 id 最小的记录
    // 使用子查询找到每组的最小 id，删除不在该集合中的记录
    db.run(`
      DELETE FROM entities
      WHERE id NOT IN (
        SELECT MIN(id) FROM entities GROUP BY LOWER(name)
      )
    `);
    // 获取删除行数（通过 changes() 函数）
    const changesRes = db.exec("SELECT changes()");
    const deletedCount = changesRes.length ? changesRes[0].values[0][0] as number : 0;
    if (deletedCount > 0) {
      logger.info({ deletedCount }, "Migration v19: deduplicated entities by case-insensitive name");
    }

    // Step 3: 删除旧普通索引，替换为 UNIQUE COLLATE NOCASE 索引
    // DROP INDEX IF EXISTS 幂等：已不存在时跳过
    db.run("DROP INDEX IF EXISTS idx_entities_name");

    // 重新创建索引，带 UNIQUE + COLLATE NOCASE 约束
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_unique
      ON entities(name COLLATE NOCASE)
    `);

    setSchemaVersion(db, 19, "entities.name UNIQUE COLLATE NOCASE (P1 case-insensitive dedup fix)");
    db.run("COMMIT");
    logger.info("Migration v19: entities deduplicated + UNIQUE COLLATE NOCASE index created (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    logger.error({ err: e.message }, "Migration v19 failed, rolled back");
    throw e;
  }
}

/**
 * v20: 时间戳类型统一 INTEGER → TEXT（P3-T9）
 *
 * 将 video_jobs、agent_provider_templates、kb_documents、kb_chunks
 * 四表的 created_at/updated_at 从 INTEGER（epoch ms）转换为 TEXT（ISO 8601）。
 * 
 * SQLite 不直接支持 ALTER COLUMN TYPE，因此通过"重建表"方式实现：
 *   1. RENAME old table → _old
 *   2. CREATE new table with TEXT columns
 *   3. INSERT INTO new ... SELECT ... CAST/CONVERT from _old
 *   4. DROP _old table
 *   5. 重建索引
 */
function migrateV20(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    // 辅助函数：将 INTEGER epoch ms 转换为 ISO 8601 TEXT
    // 若值已经是 ISO 8601 字符串（未来的幂等调用），保持原样
    // v3 Task 1：col 走 safeIdent 防御（实际来源是 tablesToConvert 常量数组）
    const toIsoExpr = (col: string) => {
      const c = safeIdent(col, "column");
      return `CASE WHEN typeof(${c}) = 'integer' THEN datetime(${c}/1000, 'unixepoch') ELSE ${c} END`;
    };

    const tablesToConvert: Array<{
      name: string;
      createSql: string;
      indexSqls: string[];
      timestampCols: string[];
    }> = [];

    // Check which tables exist and need conversion
    const existingTables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const tableNames = new Set(existingTables.length ? existingTables[0].values.map((v: unknown[]) => v[0] as string) : []);

    // video_jobs (v15)
    if (tableNames.has("video_jobs")) {
      tablesToConvert.push({
        name: "video_jobs",
        createSql: `CREATE TABLE video_jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending',
          input_json TEXT,
          progress_json TEXT,
          output_json TEXT,
          error TEXT,
          workspace_dir TEXT,
          cost_estimate_cny REAL DEFAULT 0,
          cost_actual_cny REAL,
          cost_limit_cny REAL DEFAULT 5.0,
          concurrency_slot INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        indexSqls: [
          "CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs(status)",
          "CREATE INDEX IF NOT EXISTS idx_video_jobs_created ON video_jobs(created_at)",
        ],
        timestampCols: ["created_at", "updated_at"],
      });
    }

    // agent_provider_templates (v16)
    if (tableNames.has("agent_provider_templates")) {
      tablesToConvert.push({
        name: "agent_provider_templates",
        createSql: `CREATE TABLE agent_provider_templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          providers_json TEXT NOT NULL,
          is_preset INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        )`,
        indexSqls: [],
        timestampCols: ["created_at"],
      });
    }

    // kb_documents (v17)
    if (tableNames.has("kb_documents")) {
      tablesToConvert.push({
        name: "kb_documents",
        createSql: `CREATE TABLE kb_documents (
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
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        indexSqls: [
          "CREATE INDEX IF NOT EXISTS idx_kb_docs_agent ON kb_documents(agent_id)",
          "CREATE INDEX IF NOT EXISTS idx_kb_docs_user ON kb_documents(user_id)",
          "CREATE INDEX IF NOT EXISTS idx_kb_docs_hash ON kb_documents(content_hash)",
          "CREATE INDEX IF NOT EXISTS idx_kb_docs_status ON kb_documents(status)",
        ],
        timestampCols: ["created_at", "updated_at"],
      });
    }

    // kb_chunks (v17)
    if (tableNames.has("kb_chunks")) {
      tablesToConvert.push({
        name: "kb_chunks",
        createSql: `CREATE TABLE kb_chunks (
          id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          content TEXT NOT NULL,
          embedding BLOB,
          embedding_type TEXT DEFAULT 'simple',
          token_count INTEGER DEFAULT 0,
          metadata TEXT DEFAULT '{}',
          created_at TEXT NOT NULL
        )`,
        indexSqls: [
          "CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id)",
          "CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_chunks_doc_idx ON kb_chunks(doc_id, chunk_index)",
        ],
        timestampCols: ["created_at"],
      });
    }

    let convertedCount = 0;
    for (const table of tablesToConvert) {
      // v3 Task 1：表名走白名单（防 tablesToConvert 未来被动态填充时夹带注入）
      const tName = safeIdent(table.name, "table");
      // 检查列类型是否已经是 TEXT（幂等保护）
      const colInfo = db.exec(`PRAGMA table_info(${tName})`);
      if (!colInfo.length) continue;
      const cols = colInfo[0].values.map((v: unknown[]) => ({ name: v[1] as string, type: (v[2] as string).toUpperCase() }));
      const needsConvert = table.timestampCols.some(tc => {
        const col = cols.find((c: { name: string; type: string }) => c.name === tc);
        return col && col.type === "INTEGER";
      });
      if (!needsConvert) continue;

      // Build SELECT column list with conversion
      // v3 Task 1：PRAGMA 返回的列名受信，但批量走白名单仅作防御深度
      const allCols = assertSafeIdentifiers(cols.map((c: { name: string }) => c.name), "column");
      const selectCols = allCols.map((c: string) =>
        table.timestampCols.includes(c) ? toIsoExpr(c) : c
      ).join(", ");

      const oldName = safeIdent(`${table.name}_v20_old`, "table");

      // Step 1: Rename old table
      db.run(`ALTER TABLE ${tName} RENAME TO ${oldName}`);

      // Step 2: Create new table with TEXT types
      db.run(table.createSql);

      // Step 3: Copy data with conversion
      db.run(`INSERT INTO ${tName} SELECT ${selectCols} FROM ${oldName}`);

      // Step 4: Drop old table
      db.run(`DROP TABLE ${oldName}`);

      // Step 5: Recreate indexes
      for (const idxSql of table.indexSqls) {
        db.run(idxSql);
      }

      convertedCount++;
      logger.info({ table: table.name }, "Migration v20: converted timestamp columns to TEXT");
    }

    setSchemaVersion(db, 20, "Timestamp columns: INTEGER → TEXT (video_jobs/agent_provider_templates/kb_documents/kb_chunks)");
    db.run("COMMIT");
    logger.info({ convertedCount }, "Migration v20: timestamp type unification complete");
  } catch (e: any) {
    db.run("ROLLBACK");
    logger.error({ err: e.message }, "Migration v20 failed, rolled back");
    throw e;
  }
}
