/**
 * SQLite schema migrations v10–v16（子代理 + 记忆优先级 + 知识图谱 + A2A + 视频任务）。
 *
 * 从 migrations.ts 拆分（B3 上帝文件拆分）：
 *   v10 — subagent_runs 子代理运行记录表
 *   v11 — memories.priority + relevanceScore（T1 优先级）
 *   v12 — relations 知识图谱三元组表（T6）
 *   v13 — agent_registry A2A Agent 注册表（T5）
 *   v14 — a2a_tasks A2A Task 持久化（T5）
 *   v15 — video_jobs 视频任务表（§4.4）
 *   v16 — video_jobs 扩列 + agent_provider_templates（§4.4）
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { logger } from "./logger.js";
import { type SqlJsDatabase } from "./constants.js";
import { setSchemaVersion } from "./schema.js";

/**
 * v10: I-2 子代理运行记录表（孤儿回收 + 持久化）。
 */
export function migrateV10(db: SqlJsDatabase): void {
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
 */
export function migrateV11(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run(
      "ALTER TABLE memories ADD COLUMN priority TEXT " +
      "CHECK(priority IN ('blocker','action','task_state','conclusion','normal')) " +
      "DEFAULT 'normal'"
    );
    db.run("ALTER TABLE memories ADD COLUMN relevanceScore REAL DEFAULT 0.5");
    db.run("CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(agentId, priority)");
    setSchemaVersion(db, 11, "Add priority + relevanceScore columns to memories (T1)");
    db.run("COMMIT");
    logger.info("Migration v11: Added priority/relevanceScore columns to memories (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    if (e.message?.includes("duplicate column")) {
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
 */
export function migrateV12(db: SqlJsDatabase): void {
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
    db.run(`CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations(subjectId, predicate)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_relations_object ON relations(objectId, predicate)`);
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
 * v13: T5 A2A Agent 注册表（跨进程 Agent 发现）
 */
export function migrateV13(db: SqlJsDatabase): void {
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
 * v14: T5 A2A Task 持久化（Task 状态机 8 态）
 */
export function migrateV14(db: SqlJsDatabase): void {
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
 */
export function migrateV15(db: SqlJsDatabase): void {
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
 */
export function migrateV16(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    try { db.run("ALTER TABLE video_jobs ADD COLUMN agent_providers TEXT"); } catch { /* 列已存在 */ }
    try { db.run("ALTER TABLE video_jobs ADD COLUMN agent_provider_template_id TEXT"); } catch { /* 列已存在 */ }

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
