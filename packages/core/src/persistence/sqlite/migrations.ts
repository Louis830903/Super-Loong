/**
 * SQLite schema migrations（v2..v20）调度器。
 *
 * CORE-P1-02 批 1：从原 sqlite.ts L80-683 抽出。
 * B3 上帝文件拆分：各 migrateVN 函数已迁移至 4 个子文件：
 *   - migrations-v2-v9.ts     (v2–v9   基础字段 / FTS / 实体 / 配置)
 *   - migrations-v10-v16.ts   (v10–v16 子代理 / 记忆 / A2A / 视频)
 *   - migrations-v17-v18.ts   (v17–v18 知识库 / credentials 修复)
 *   - migrations-v19-v20.ts   (v19–v20 实体去重 / 时间戳类型统一)
 *
 * 新增 migration 步骤：
 *   1. 在对应子文件（或新建子文件）中添加 migrateV{N} 导出函数
 *   2. 在本文件 runMigrations 末尾新增 `if (currentVersion < N) migrateVN(db);`
 *   3. 将 constants.ts 的 `CURRENT_SCHEMA_VERSION` bump 到 N
 *
 * DAG 位置：logger/constants/schema → migrations-vX-vY → **migrations** → client → repo
 */

import { logger } from "./logger.js";
import { CURRENT_SCHEMA_VERSION, type SqlJsDatabase } from "./constants.js";
import { getSchemaVersion } from "./schema.js";

// ── B3 拆分：各版本迁移函数从子文件导入 ──
import { migrateV2, migrateV3, migrateV4, migrateV5, migrateV6, migrateV7, migrateV8, migrateV9 } from "./migrations-v2-v9.js";
import { migrateV10, migrateV11, migrateV12, migrateV13, migrateV14, migrateV15, migrateV16 } from "./migrations-v10-v16.js";
import { migrateV17, migrateV18 } from "./migrations-v17-v18.js";
import { migrateV19, migrateV20 } from "./migrations-v19-v20.js";
import { migrateV21, migrateV22 } from "./migrations-v21-v22.js";

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

  // ── v21: capability_gaps 表（P1-1 能力缺口持久化）──
  if (currentVersion < 21) migrateV21(db);

  // ── v22: tool_proposals 表（P1-2 工具骨架提案）──
  if (currentVersion < 22) migrateV22(db);
}
