/**
 * SQLite schema migrations v19–v20（实体去重 + 时间戳类型统一）。
 *
 * 从 migrations.ts 拆分（B3 上帝文件拆分）：
 *   v19 — entities.name UNIQUE COLLATE NOCASE（P2-T13 大小写重复实体修复）
 *   v20 — 时间戳 INTEGER → TEXT（P3-T9，video_jobs/agent_provider_templates/kb_documents/kb_chunks）
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { logger } from "./logger.js";
import { type SqlJsDatabase } from "./constants.js";
import { setSchemaVersion } from "./schema.js";
// v3 Task 1：SQL 标识符白名单防御，所有动态拼接的表名/列名必须走 safeIdent
import { safeIdent, assertSafeIdentifiers } from "./sql-safe.js";

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
export function migrateV19(db: SqlJsDatabase): void {
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
export function migrateV20(db: SqlJsDatabase): void {
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

    // video_jobs (v15/v16)：【修复】不纳入 TEXT 转换。
    // video-job-repo 的 VideoJobRow.created_at/updated_at 契约是 number（epoch ms），
    // 应用写入 Date.now() 数字；若转 TEXT 亲和性会把数字强制存成字符串，
    // 违背 number 契约并破坏数值比较。历史上 v20 因 exec() 缺陷从未真正转过
    // video_jobs，故排除零影响（时间戳统一由 repo 层保证）。

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

    // kb_documents / kb_chunks (v17)：【修复】不纳入 TEXT 转换。
    // 两点原因：
    //   1) kb_chunks 是 external-content FTS5 表 kb_chunks_fts 的内容源，其同步依赖
    //      挂在 kb_chunks 上的 INSERT/DELETE/UPDATE 触发器（v17 创建）。v20 的"重建表"
    //      （RENAME→CREATE→INSERT→DROP 旧表）会连带删除这些触发器且不重建，导致 FTS5
    //      不再自动同步、BM25 检索全空。
    //   2) kb-repo 的 KBDocument/KBChunk.createdAt 契约为 number（epoch ms），转 TEXT
    //      亲和性会把数字强制存成字符串，违背 number 契约。
    // v20 历史上因 exec() 缺陷从未真正运行过，故排除零影响。

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
      // 【修复】显式列名插入（位置无关）：避免新表列数与旧表 SELECT 列数不一致时报
      // "N columns but M values"（如 v16 给 video_jobs ALTER 补列后，v20 建表 SQL 未同步）。
      db.run(`INSERT INTO ${tName} (${allCols.join(", ")}) SELECT ${selectCols} FROM ${oldName}`);

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
