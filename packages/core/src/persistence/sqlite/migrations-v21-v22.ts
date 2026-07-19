/**
 * SQLite schema migrations v21–v22（进化引擎持久化）。
 *
 * 从 migrations.ts 拆分（延续 B3 上帝文件拆分约定）：
 *   v21 — capability_gaps 表（P1-1 能力缺口持久化，重启不丢失）
 *   v22 — tool_proposals 表（P1-2 工具骨架生成提案，人工审核）
 *
 * 两张表均为进化引擎"自我感知/自我扩展"能力的落地存储，
 * 默认由 Feature Flag / STAGE 控制是否写入，零回归。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { logger } from "./logger.js";
import { type SqlJsDatabase } from "./constants.js";
import { setSchemaVersion } from "./schema.js";

/**
 * v21: capability_gaps 表（P1-1）
 *
 * 背景：CapabilityGapDetector 原本纯内存，进程重启即丢失已发现的能力缺口。
 * 本迁移建表，使缺口检测结果可持久化、跨重启累积频次与优先级。
 *
 * 字段与 CapabilityGap 接口一一对应；数组字段（attempted_tools/session_ids）
 * 以 JSON 字符串存储，solvable 以 0/1 存储。
 */
export function migrateV21(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS capability_gaps (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        agent_id TEXT,
        detected_at TEXT NOT NULL,
        last_detected_at TEXT NOT NULL,
        frequency INTEGER NOT NULL DEFAULT 1,
        attempted_tools TEXT NOT NULL DEFAULT '[]',
        session_ids TEXT NOT NULL DEFAULT '[]',
        detected_by TEXT NOT NULL,
        sample_response TEXT,
        solvable INTEGER NOT NULL DEFAULT 1,
        suggested_fix TEXT,
        priority INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'open',
        resolution_note TEXT,
        metadata TEXT DEFAULT '{}'
      )
    `);
    db.run("CREATE INDEX IF NOT EXISTS idx_capability_gaps_status ON capability_gaps(status)");
    db.run("CREATE INDEX IF NOT EXISTS idx_capability_gaps_priority ON capability_gaps(priority)");

    setSchemaVersion(db, 21, "capability_gaps table (P1-1 gap persistence)");
    db.run("COMMIT");
    logger.info("Migration v21: capability_gaps table created (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    logger.error({ err: e.message }, "Migration v21 failed, rolled back");
    throw e;
  }
}

/**
 * v22: tool_proposals 表（P1-2）
 *
 * 背景：能力缺口达阈值时，进化引擎生成"工具骨架提案"（LLM 填充函数体），
 * 但绝不自动注册/热加载——先存为 pending_review，人工审核 + 沙箱验证后才批准。
 *
 * source_code 存完整候选 .ts 代码；status 生命周期：
 *   pending_review → approved / rejected。
 */
export function migrateV22(db: SqlJsDatabase): void {
  db.run("BEGIN TRANSACTION");
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS tool_proposals (
        id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        gap_id TEXT,
        source_code TEXT NOT NULL,
        file_path TEXT,
        feature_flag TEXT,
        dependencies TEXT NOT NULL DEFAULT '[]',
        validation_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending_review',
        review_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.run("CREATE INDEX IF NOT EXISTS idx_tool_proposals_status ON tool_proposals(status)");

    setSchemaVersion(db, 22, "tool_proposals table (P1-2 tool skeleton proposals)");
    db.run("COMMIT");
    logger.info("Migration v22: tool_proposals table created (committed)");
  } catch (e: any) {
    db.run("ROLLBACK");
    logger.error({ err: e.message }, "Migration v22 failed, rolled back");
    throw e;
  }
}
