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

// ── 批 2a：无共享状态 CRUD ──
export { saveMCPServer, loadMCPServers, deleteMCPServer } from "./mcp-store.js";
export {
  saveInstalledSkill,
  loadInstalledSkills,
  deleteInstalledSkill,
  purgeSkillProposals,
} from "./skill-store.js";
export {
  saveSecurityPolicy,
  loadSecurityPolicies,
  deleteSecurityPolicy,
} from "./security-policy-store.js";
export {
  saveCredentialToDB,
  loadCredentialsFromDB,
  deleteCredentialFromDB,
} from "./credential-store.js";
export { saveChannel, loadChannels, deleteChannel } from "./channel-store.js";

// ── 批 2b：中等独立块（Core Blocks / Audit / Config Store / Video Jobs / Provider Templates）──
export type { CoreBlockRow } from "./core-block-repo.js";
export { saveCoreBlock, loadCoreBlocks } from "./core-block-repo.js";
export {
  sanitizeForAudit,
  logConfigChange,
  queryConfigAuditLog,
} from "./audit-repo.js";
export { loadNudgeConfig, saveNudgeConfig } from "./config-store-repo.js";
export type { VideoJobRow } from "./video-job-repo.js";
export {
  insertVideoJob,
  updateVideoJob,
  getVideoJob,
  listVideoJobs,
} from "./video-job-repo.js";
export type { ProviderTemplateRow } from "./provider-template-repo.js";
export {
  getProviderTemplates,
  insertProviderTemplate,
  updateProviderTemplate,
  deleteProviderTemplate,
} from "./provider-template-repo.js";

// ── 批 2c：联动块（Agent Config / Session / Cron / Collab / Maintenance）──
export {
  saveAgentConfig,
  loadAllAgentConfigs,
  deleteAgentConfig,
} from "./agent-config-repo.js";
export {
  saveSession,
  loadSession,
  deleteSession,
  listSessionsByAgent,
} from "./session-repo.js";
export {
  saveCronJob,
  loadCronJobs,
  deleteCronJob,
  addCronHistory,
  loadCronHistory,
  cleanupOldCronHistory,
} from "./cron-repo.js";
export {
  saveCollabHistory,
  loadCollabHistory,
  deleteCollabHistory,
  loadCollabHistoryById,
} from "./collab-repo.js";
export { purgeEvolutionCases } from "./maintenance-repo.js";
