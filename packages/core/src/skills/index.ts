export { SkillLoader } from "./loader.js";
export { createSkillTools } from "./tools.js";
export { scanSkill, shouldAllowInstall, contentHash } from "./guard.js";
export type { ScanResult, Finding, TrustLevel, Verdict } from "./guard.js";
export { evaluateReadiness, collectMissingSecrets, selectPreferredInstall, formatReadinessMessage, SkillReadinessStatus } from "./readiness.js";
export type { SkillReadinessResult, SecretSpec, SkillInstallOption } from "./readiness.js";

// Phase 3: 磁盘技能快照缓存
export { SkillSnapshotCache } from "./snapshot-cache.js";
export type { SkillManifest, SkillSnapshot, SkillSnapshotEntry } from "./snapshot-cache.js";

// Spec v3 Task 3: 可扩展多源适配器
export { SkillSource } from "./sources/base.js";
export type { SkillMeta, SkillBundle } from "./sources/base.js";
export { GitHubSource } from "./sources/github.js";
export { SkillHubSource } from "./sources/skillhub.js";
export { ClawHubSource } from "./sources/clawhub.js";
export type { ClawHubRegistry } from "./sources/clawhub.js";
export { LocalSource } from "./sources/local.js";
export { SourceRouter } from "./sources/router.js";

// Spec v3 Task 4: 技能配置注入
export { extractConfigVars, resolveConfigValues, injectSkillConfig, applyConfigInjection, discoverAllConfigVars, InMemoryConfigStore, ConfigStoreAdapter } from "./config-inject.js";
export type { ConfigVarSpec, SkillConfigStore } from "./config-inject.js";

// Spec v3 Task 6: 斜杠命令激活
export { scanSkillCommands, buildSkillActivationMessage, isSlashCommand, handleSlashCommand, formatCommandsList } from "./commands.js";
export type { SkillCommandEntry, SlashCommandResult } from "./commands.js";

// Spec v3 Task 7: 版本锁定与更新检测
export { SkillLockfileManager } from "./lockfile.js";
export type { SkillLockfile, SkillLockEntry, SkillOrigin, UpdateCheckResult, AuditLogEntry } from "./lockfile.js";
