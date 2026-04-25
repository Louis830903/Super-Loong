/**
 * SQLite 持久化层桶导出。
 *
 * CORE-P1-02 批 1：仅 re-export 基础设施层（logger / constants / schema / migrations / client）。
 * 后续批次会在此处追加各业务 repo 的 re-export：
 *   批 2a：mcp / skill / security / channel / credential
 *   批 2b：config-store / video-job / provider-template / core-block / audit
 *   批 2c：agent-config / session / maintenance / cron / collab
 *   批 3 ：memory-backend / fts / conversation / subagent
 *
 * 设计约束：本文件不 re-export logger / 内部常量（如 CURRENT_SCHEMA_VERSION），
 * 避免污染上游 public API 面。仅 re-export 供外部消费的函数/类/类型。
 */

// ── 批 1：基础设施 ──
export type { SqlJsDatabase, SqlJsStatic } from "./constants.js";
export {
  ensureSchemaVersionTable,
  getSchemaVersion,
  setSchemaVersion,
  createInitialSchema,
} from "./schema.js";
export { runMigrations } from "./migrations.js";
export {
  initDatabase,
  getDatabase,
  saveDatabase,
  saveDatabaseSync,
  scheduleSave,
  flushPendingSave,
  flushPendingSaveSync,
  closeDatabase,
  cleanupOldBackups,
  registerShutdownHandlers,
} from "./client.js";
