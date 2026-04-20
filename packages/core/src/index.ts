/**
 * @super-agent/core — Core package for the Super Agent Platform.
 *
 * Exports:
 * - Agent runtime and manager
 * - LLM provider abstraction
 * - Skill loader with hot-reload
 * - Message router
 * - Memory manager
 * - All type definitions
 */

// Types
export * from "./types/index.js";

// Config (path resolution)
export { resolveHome, resetResolvedHome, paths, ensureDirectories } from "./config/index.js";

// Agent
export { AgentRuntime, AgentManager } from "./agent/index.js";
export type { AgentRuntimeOptions } from "./agent/index.js";

// LLM
export { LLMProvider } from "./llm/index.js";
export type { LLMToolDef, LLMCompletionParams } from "./llm/index.js";
export { getModelCatalog, getProviderById, getModelById } from "./llm/index.js";
export type { ModelDef, ProviderDef } from "./llm/index.js";
export { ProviderStore } from "./llm/index.js";
export type { ProviderRecord } from "./llm/index.js";

// Skills
export { SkillLoader, createSkillTools } from "./skills/index.js";

// Skill Parser & Marketplace
export { parseSkillFile } from "./skills/parser.js";
export type { SkillFormat, ParsedSkill } from "./skills/parser.js";
export { SkillMarketplace } from "./skills/marketplace.js";
export type { MarketplaceSource, SkillMarketEntry, InstalledSkill, SkillInstallResult } from "./skills/marketplace.js";

// Spec v3: 安全审计引擎
export { scanSkill, shouldAllowInstall, contentHash } from "./skills/index.js";
export type { ScanResult, Finding, TrustLevel, Verdict } from "./skills/index.js";

// Phase 3: 磁盘技能快照缓存
export { SkillSnapshotCache } from "./skills/index.js";
export type { SkillManifest, SkillSnapshot, SkillSnapshotEntry } from "./skills/index.js";

// Spec v3: 就绪状态机
export { evaluateReadiness, collectMissingSecrets, selectPreferredInstall, formatReadinessMessage, SkillReadinessStatus } from "./skills/index.js";
export type { SkillReadinessResult, SecretSpec, SkillInstallOption } from "./skills/index.js";

// Spec v3: 可扩展多源适配器
export { SkillSource } from "./skills/index.js";
export type { SkillMeta, SkillBundle } from "./skills/index.js";
export { GitHubSource } from "./skills/index.js";
export { SkillHubSource } from "./skills/index.js";
export { ClawHubSource } from "./skills/index.js";
export type { ClawHubRegistry } from "./skills/index.js";
export { LocalSource } from "./skills/index.js";
export { SourceRouter } from "./skills/index.js";

// Spec v3: 技能配置注入
export { extractConfigVars, resolveConfigValues, injectSkillConfig, applyConfigInjection, discoverAllConfigVars, InMemoryConfigStore, ConfigStoreAdapter } from "./skills/index.js";
export type { ConfigVarSpec, SkillConfigStore } from "./skills/index.js";

// Spec v3: 斜杠命令激活
export { scanSkillCommands, buildSkillActivationMessage, isSlashCommand, handleSlashCommand, formatCommandsList } from "./skills/index.js";
export type { SkillCommandEntry, SlashCommandResult } from "./skills/index.js";

// Spec v3: 版本锁定与更新检测
export { SkillLockfileManager } from "./skills/index.js";
export type { SkillLockfile, SkillLockEntry, SkillOrigin, UpdateCheckResult, AuditLogEntry as SkillAuditLogEntry } from "./skills/index.js";

// Context Compression (P0-3)
export { ContextCompressor, PRUNED_TOOL_PLACEHOLDER, SUMMARY_PREFIX } from "./context/compressor.js";
export type { CompressorConfig, IContextStrategy } from "./context/compressor.js";
export { ContextSummarizer } from "./context/summarizer.js";
export type { SummarizerConfig } from "./context/summarizer.js";

// Tool Result Truncation & Preemptive Check
// Content Helpers (B-0: 多模态 content 安全访问)
export { getContentText, hasImageContent, estimateImageTokens } from "./utils/content-helpers.js";
export {
  truncateToolResult,
  calculateMaxSingleResultChars,
  calculateAggregateBudgetChars,
  enforceAggregateBudget,
  truncateOversizedToolResultsInHistory,
  estimateToolResultReducibleChars,
  TRUNCATION_MARKER,
} from "./context/tool-result-truncation.js";
export { shouldPreemptivelyCompact } from "./context/preemptive-check.js";
export type { PreemptiveRoute, PreemptiveCheckInput, PreemptiveCheckResult } from "./context/preemptive-check.js";

// Routing
export { MessageRouter } from "./routing/index.js";
export type { RouteBinding } from "./routing/index.js";

// Memory
export { MemoryManager, InMemoryBackend, QwenEmbedding, HRRProvider, createMemoryTools } from "./memory/manager.js";
export type { QwenEmbeddingConfig, ContradictionPair } from "./memory/manager.js";
export type {
  MemoryBackend,
  MemoryFilter,
  EmbeddingProvider,
  CoreMemoryBlock,
  MemoryCreateInput,
  MemoryManagerConfig,
  MemoryStats,
} from "./memory/manager.js";
export { MarkdownMemory } from "./memory/markdown-memory.js";
export type { MarkdownMemoryConfig } from "./memory/markdown-memory.js";
// D-1: Provider 插件接口
export { MemoryProviderOrchestrator } from "./memory/provider.js";
export type { IMemoryProvider, MemoryProviderConfig } from "./memory/provider.js";
// F-1: HRR 向量符号架构
export * as hrr from "./memory/hrr.js";
// H-2: 实体解析
export { extractEntities, extractEntitiesWithAliases } from "./memory/entity-resolver.js";
export type { ExtractedEntity, EntityRow } from "./memory/entity-resolver.js";
// J-1: 插件发现
export { loadMemoryPlugins } from "./memory/plugin-loader.js";
export type { MemoryPluginConfig } from "./memory/plugin-loader.js";

// Collaboration
export {
  CollaborationOrchestrator,
  CrewExecutor,
  GroupChatExecutor,
} from "./collaboration/orchestrator.js";
export type {
  CollabMessage,
  CrewConfig,
  CrewTask,
  CrewResult,
  TaskOutput,
  ProcessType,
  GroupChatConfig,
  GroupChatResult,
  SpeakerSelectionMethod,
} from "./collaboration/orchestrator.js";

// Phase 2: 子代理系统（学 OpenClaw Sub-Agent）
export { buildSubagentSystemPrompt, filterToolsForDepth, SUBAGENT_BLOCKED_TOOLS } from "./collaboration/subagent-prompt.js";
export type { SubagentPromptOptions } from "./collaboration/subagent-prompt.js";
export { SubagentManager, DEFAULT_SPAWN_CONFIG } from "./collaboration/subagent-spawn.js";
export type { SpawnConfig, SubagentRecord, SubagentStatus, SpawnRequest, SubagentExecuteFn } from "./collaboration/subagent-spawn.js";
export { SubagentAnnouncer, formatAnnounceMessage } from "./collaboration/subagent-announce.js";
export type { AnnouncePayload, InjectMessageFn } from "./collaboration/subagent-announce.js";

// Evolution
export {
  EvolutionEngine,
  NudgeTracker,
  CaseCollector,
} from "./evolution/engine.js";
export type {
  InteractionCase,
  SkillProposal,
  NudgeConfig,
  EvolutionSnapshot,
  EvolutionStats,
} from "./evolution/engine.js";

// Security
export {
  SecurityManager,
  CredentialVault,
  TokenProxy,
  ProcessSandbox,
} from "./security/sandbox.js";
export type {
  SandboxLevel,
  PermissionAction,
  ToolPermission,
  SecurityPolicy,
  CredentialEntry,
  AuditLogEntry,
  SecurityStats,
  ProcessSandboxOptions,
  SandboxResult,
  SandboxBackend,
} from "./security/sandbox.js";

// Docker Sandbox
export { DockerSandbox } from "./security/docker-sandbox.js";
export type { DockerSandboxConfig } from "./security/docker-sandbox.js";

// SSH Sandbox
export { SSHSandbox } from "./security/ssh-sandbox.js";
export type { SSHSandboxConfig } from "./security/ssh-sandbox.js";

// Persistence (SQLite)
export {
  initDatabase,
  getDatabase,
  saveDatabase,
  closeDatabase,
  SQLiteBackend,
  saveCoreBlock,
  loadCoreBlocks,
  saveAgentConfig,
  loadAllAgentConfigs,
  deleteAgentConfig,
  saveSession,
  loadSession,
  deleteSession,
  listSessionsByAgent,
  // FTS5 full-text search
  indexMemoryFTS,
  removeMemoryFTS,
  searchMemoriesFTS,
  indexSessionFTS,
  searchSessionsFTS,
  // Cron persistence
  saveCronJob,
  loadCronJobs,
  deleteCronJob,
  addCronHistory,
  loadCronHistory,
  // MCP persistence
  saveMCPServer,
  loadMCPServers,
  deleteMCPServer,
  // Installed Skills persistence
  saveInstalledSkill,
  loadInstalledSkills,
  deleteInstalledSkill,
  // Security Policy persistence
  saveSecurityPolicy,
  loadSecurityPolicies,
  deleteSecurityPolicy,
  // Collaboration History persistence
  saveCollabHistory,
  loadCollabHistory,
  deleteCollabHistory,
  // Evolution tables cleanup
  purgeEvolutionCases,
  purgeSkillProposals,
  // Credential persistence (B-17)
  saveCredentialToDB,
  loadCredentialsFromDB,
  deleteCredentialFromDB,
  // Channel persistence (B-18)
  saveChannel,
  loadChannels,
  deleteChannel,
  // Config store (Phase B-2: Nudge 配置持久化)
  loadNudgeConfig,
  saveNudgeConfig,
  // Conversation persistence
  createConversation,
  getConversation,
  listConversations,
  updateConversationTitle,
  updateConversationModel,
  deleteConversation,
  appendConvMessage,
  getConvMessages,
  searchConvMessages,
  // Backup & shutdown
  cleanupOldBackups,
  registerShutdownHandlers,
  flushPendingSave,
  // Config change audit
  logConfigChange,
  queryConfigAuditLog,
  // Audit sanitization
  sanitizeForAudit,
} from "./persistence/sqlite.js";
export type { ConversationRecord, ConvMessageRecord } from "./persistence/sqlite.js";

// JSONL Session Writer
export { JsonlWriter, getJsonlWriter } from "./persistence/jsonl-writer.js";
export type { JsonlMessage, SessionIndexEntry } from "./persistence/jsonl-writer.js";

// Prompt Engine
export {
  PromptEngine,
  TOOL_USE_ENFORCEMENT,
  MEMORY_GUIDANCE,
  SKILLS_GUIDANCE_HEADER,
  SAFETY_GUARDRAILS,
  MODEL_ADAPTERS,
  resolveModelGuidance,
  PLATFORM_HINTS,
  resolvePlatformHint,
  discoverContextFiles,
  scanForInjection,
  scanMemoryContent,
  scanCronPrompt,
  sanitizeMemoryContent,
} from "./prompt/index.js";
export type { PromptEngineConfig, ModelAdapter, ThreatCategory, ThreatSeverity, ThreatFinding } from "./prompt/index.js";

// MCP (Model Context Protocol)
export { MCPClient, MCPRegistry, MCPMarketplace, MCPServer, EventBridge, StdioTransport, createSSEHandlers, createTransport } from "./mcp/index.js";
export type { MCPServerConfig, MCPTool, MCPServerStatus, MCPServerInfo, MCPAuthConfig, MCPMarketEntry, MCPInstallConfig, MCPRegistryPackage, MCPServerOptions, MCPServerState, PermissionRequest, MCPEvent, MCPEventType, EventBridgeConfig, MCPTransport, SSEHandlerConfig } from "./mcp/index.js";

// Built-in Tools (24 core sync + optional async-loaded)
export { builtinTools, getAllBuiltinTools, getToolsByCategory, filesystemTools, codeExecTools, webTools, systemDataTools, configureTools, gitTools, productivityTools } from "./tools/index.js";

// Service ConfigStore (对话式配置持久化)
export { ConfigStore, SERVICE_CATALOG, getConfigStore, initConfigStore } from "./tools/index.js";
export type { ServiceCatalogEntry, ServiceKeyDef, ServiceInfo } from "./tools/index.js";

// Cron Scheduler
export { CronScheduler, parseNaturalLanguageToCron } from "./cron/index.js";
export type { CronJobConfig, CronHistory } from "./cron/index.js";

// Phase 1: 心跳引擎（学 OpenClaw Heartbeat System）
export { HeartbeatRunner, DEFAULT_HEARTBEAT_CONFIG, HEARTBEAT_PROMPT, HEARTBEAT_SYSTEM_SECTION } from "./cron/index.js";
export type { HeartbeatConfig, HeartbeatExecuteFn, HeartbeatDeliverFn } from "./cron/index.js";

// Voice (TTS/STT)
export { AliyunVoiceProvider } from "./voice/index.js";
export type { VoiceProvider, VoiceConfig, STTOptions, TTSOptions, STTResult, AliyunVoiceConfig } from "./voice/index.js";

// Plugin System (统一插件系统)
export { PluginRegistry } from "./plugins/registry.js";
export { HookDispatcher } from "./plugins/hooks.js";
export { loadPlugins, createLazyPlugin } from "./plugins/loader.js";
export { createMemoryPlugin } from "./plugins/adapters/memory-adapter.js";
export { createToolPlugin } from "./plugins/adapters/tool-adapter.js";
export { createChannelPlugin } from "./plugins/adapters/channel-adapter.js";
export type {
  SuperAgentPlugin,
  PluginManifest,
  PluginCapability,
  PluginApi,
  PluginContext,
  PluginHookName,
  HookHandler,
  HookContext,
  ChannelPluginConfig,
  CommandDefinition,
  RouteDefinition,
  PluginDiscoveryConfig,
  PluginDiscoverySource,
  LoadedPluginInfo,
} from "./plugins/types.js";

// Media Service Layer (对标 OpenClaw 媒体处理架构)
export {
  // 常量
  MEDIA_MAX_BYTES, MEDIA_TTL_MS, MEDIA_TOKEN_RE, MEDIA_STORE_DIR,
  // MIME 检测
  detectMime, detectMimeFromPath, detectMimeFromBuffer, kindFromMime, inferFilename, mimeToExt, isMimeSafe, isExtensionSafe,
  // MEDIA: 标记解析
  splitMediaFromOutput, hasMediaTokens, stripMediaPrefix,
  // 安全守卫
  MediaSecurityError, assertPathAllowed, assertNotInternalUrl, assertSizeAllowed, assertMimeAllowed,
  // 本地临时存储
  initMediaStore, saveMediaBuffer, saveMediaFromUrl, cleanExpiredMedia, getMediaById,
  // 统一加载器
  loadMedia, resolveOutboundAttachment,
} from "./media/index.js";
export type { ParsedMediaOutput, MediaSecurityCode, SavedMedia, LoadMediaOptions } from "./media/index.js";

// Evolution — 自我改进闭环 (Session Search / Knowledge / Insights / Verification)
export { SessionSearchEngine } from "./evolution/session-search.js";
export type { SearchResult, FocusSummary } from "./evolution/session-search.js";
export { KnowledgeExtractor } from "./evolution/knowledge-extractor.js";
export type { KnowledgeCategory, KnowledgeEntry, ExtractionResult } from "./evolution/knowledge-extractor.js";
export { InsightsEngine } from "./evolution/insights.js";
export type { ToolInsight, SessionInsight, TrendPoint, Bottleneck, InsightsReport } from "./evolution/insights.js";
export { VerificationPipeline } from "./evolution/verification.js";
export type { VerificationCase, VerificationResult, VerificationDetail, ABComparisonResult, RollbackRecord } from "./evolution/verification.js";
