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

// Agent 状态脱敏（SEC-P0-04：零信任 apiKey 保护）
export {
  sanitizeAgentState,
  sanitizeAgentStates,
  maskApiKey,
  isMaskedApiKey,
} from "./agent/sanitize.js";

// Builtin Expert Agents（211 个内置专家 Agent）
export { builtinAgentCatalog, DEPT_LABELS, DEPARTMENTS, ensureBuiltinAgents } from "./builtin-agents/index.js";
export type { BuiltinAgentEntry } from "./builtin-agents/index.js";

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
// ✨ T6: 知识图谱核心模块
export { KnowledgeGraph } from "./memory/knowledge-graph.js";
export type { Triple, TripleInput, Subgraph, ExportFormat } from "./memory/knowledge-graph.js";
// ✨ T6: 关系抽取器
export { extractRelations } from "./memory/relation-extractor.js";
export type { RelationCandidate } from "./memory/relation-extractor.js";
// ✨ T6: 关系传播规则
export { TRANSITIVE_PREDICATES, applyTransitiveClosure, applyAllTransitiveClosures } from "./memory/inference-rules.js";
// ✨ T6: 搜索选项
export type { MemorySearchOptions } from "./memory/manager.js";
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
  OrchestratorDeps,
  RunningTaskInfo,
} from "./collaboration/orchestrator.js";

// AgentMatcher (Hierarchical 智能 Agent 分配)
export { AgentMatcher } from "./collaboration/agent-matcher.js";
export type {
  MatchRequest,
  MatchResult,
  NewAgentSpec,
} from "./collaboration/agent-matcher.js";

// Collaboration Workspace（多Agent工作空间管理）
export {
  createWorkspace,
  saveTaskOutput,
  collectExternalAttachments,
  generateReadme,
  getWorkspacePath,
  getCollabOutputsRoot,
  cleanExpiredWorkspaces,
  startWorkspaceCleanupTimer,
  checkPythonDocLibs,
} from "./collaboration/workspace.js";
export type {
  WorkspaceConfig,
  WorkspaceInfo,
  WorkspaceAttachment,
  WorkspaceTaskOutput,
  WorkspaceMessage,
} from "./collaboration/workspace.js";

// Phase 5: A2A 协议跨进程通信
export {
  TaskState, isTerminalState, isInterruptedState, VALID_TRANSITIONS,
  A2A_ERROR_CODES,
  mapAttachmentToA2APart, mapA2APartToAttachment,
} from "./collaboration/a2a-types.js";
export type {
  IAgentLike, A2ATask, A2AMessage, Part, TextPart, RawPart, UrlPart, DataPart,
  Artifact, TaskStatus, A2AAgentCard, AgentSkill, AgentCapabilities, AgentProvider,
  SecurityScheme, SecurityRequirement,
  SendMessageRequest, SendMessageResponse, StreamFrame, TaskFilter,
  TaskPushNotificationConfig, PushEvent,
  JsonRpcRequest, JsonRpcSuccessResponse, JsonRpcErrorResponse, JsonRpcResponse,
} from "./collaboration/a2a-types.js";
export { createMessage, createArtifact, attachmentsToParts, partsToAttachments, createTextMessage } from "./collaboration/a2a-message.js";
export type { CreateMessageOptions } from "./collaboration/a2a-message.js";
export { TaskStore, InvalidTransitionError, TaskNotFoundError } from "./collaboration/a2a-task.js";
export { InMemoryAgentRegistry, SqliteAgentRegistry } from "./collaboration/agent-registry.js";
export type { IAgentRegistry, AgentRegistryEntry, DiscoverFilter } from "./collaboration/agent-registry.js";
export { A2AClient, A2AClientError } from "./collaboration/a2a-client.js";
export type { A2AAuthConfig } from "./collaboration/a2a-client.js";

// Video Crew Schemas & Prompts (Phase 2)
export {
  ScriptSchema, ImagePromptsSchema, StoryboardSchema,
  buildGuardrail, scriptGuardrail, imagePromptsGuardrail, storyboardGuardrail,
} from "./collaboration/video-crew-schemas.js";
export {
  WRITER_AGENT_PROMPT, DESIGNER_AGENT_PROMPT, STORYBOARD_AGENT_PROMPT,
  VIDEO_AGENT_PROMPT, VOICE_AGENT_PROMPT, EDITOR_AGENT_PROMPT,
} from "./collaboration/video-crew-prompts.js";
export {
  buildShortVideoCrew, buildShortVideoAgents, validateVideoCrewModel,
  VIDEO_AGENT_IDS, VIDEO_TASK_IDS,
} from "./collaboration/video-crew-presets.js";
export type { ShortVideoCrewParams } from "./collaboration/video-crew-presets.js";
export {
  PRESET_BALANCED, PRESET_CHEAP, PRESET_ZH_BEST, PRESET_LOCAL,
  PROVIDER_PRESETS,
} from "./collaboration/video-crew-provider-presets.js";
export type { AgentProviderOverride, ProviderPreset } from "./collaboration/video-crew-provider-presets.js";
export { applyPerAgentProvider, applyAllAgentProviders } from "./collaboration/crew-executor-provider.js";
export { PushNotificationDispatcher } from "./collaboration/a2a-push.js";
export type { PushDispatcherOptions } from "./collaboration/a2a-push.js";
export { RemoteAgentProxy } from "./collaboration/remote-agent-proxy.js";
export { retryWithBackoff } from "./collaboration/retry.js";
export type { RetryConfig } from "./collaboration/retry.js";

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

// SysOps Security (双层纵深防御 Layer 2: 声明式安全策略注入)
export { SYSOPS_TOOL_PERMISSIONS, injectSysopsSecurityRules } from "./security/sysops-security.js";

// Approval (安全审批机制)
export { listPendingApprovals, resolveApproval, resolveAllPending, requestApproval, isApproved, recordApproval, clearSessionApprovals } from "./security/approval.js";
export type { ApprovalScope, ApprovalStatus, ApprovalEntry, ApprovalResult } from "./security/approval.js";

// Persistence (SQLite)
export {
  initDatabase,
  getDatabase,
  saveDatabase,
  saveDatabaseSync,
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
  loadCollabHistoryById,
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
  // Video Jobs CRUD (Phase 2: 视频任务持久化)
  insertVideoJob,
  updateVideoJob,
  getVideoJob,
  listVideoJobs,
  // Agent Provider Templates CRUD
  insertProviderTemplate,
  getProviderTemplates,
  deleteProviderTemplate,
  updateProviderTemplate,
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
  flushPendingSaveSync,
  // Config change audit
  logConfigChange,
  queryConfigAuditLog,
  // Audit sanitization
  sanitizeForAudit,
} from "./persistence/sqlite.js";
export type { ConversationRecord, ConvMessageRecord } from "./persistence/sqlite.js";
export type { VideoJobRow, ProviderTemplateRow } from "./persistence/sqlite.js";

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
export { builtinTools, getAllBuiltinTools, invalidateToolCache, getToolsByCategory, filesystemTools, codeExecTools, webTools, systemDataTools, configureTools, gitTools, productivityTools } from "./tools/index.js";

// Service ConfigStore (对话式配置持久化)
export { ConfigStore, SERVICE_CATALOG, getConfigStore, initConfigStore } from "./tools/index.js";
export type { ServiceCatalogEntry, ServiceKeyDef, ServiceInfo } from "./tools/index.js";

// Cron Scheduler
export { CronScheduler, parseNaturalLanguageToCron, parseNaturalLanguageToCronEx, validateCronExpression } from "./cron/index.js";
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

// Tracing — 全链路追踪
export {
  runInContext, currentTrace, currentSpanId, currentTraceId,
  startSpan, withSpan, withSpanSync, endSpan, addSpanEvent,
  onSpan, offSpan, isTracingEnabled, setTracingEnabled, createRootContext,
  SpanOperations,
  initTraceStore, getTraceSpans, getRecentTraces, closeTraceStore,
  instrumentRuntime, instrumentLLM, instrumentSecurity, instrumentMemory, instrumentPrompt, traceToolExec,
} from "./tracing/index.js";
export type { Span, SpanEvent, TraceContext, SpanStatus, SpanCallback, TraceListItem } from "./tracing/index.js";

// Runtime — 视频微服务环境自举（video-forge bootstrap）
export {
  ensureVideoForgeDeps,
  detectPython,
  detectFfmpeg,
  downloadFfmpeg,
  ensureUvVenv,
  buildSpawnEnv,
  PythonNotFoundError,
  FfmpegDownloadError,
  VenvSetupError,
} from "./runtime/index.js";
export type { VideoForgeDepsResult, BootstrapOptions } from "./runtime/index.js";

// Services — video-forge HTTP 客户端
export {
  forgeImage,
  forgeVideoSubmit,
  forgeVideoStatus,
  forgeTts,
  forgeComposeFrame,
  forgeConcat,
  forgeAddBgm,
  forgeAnalyseImage,
  forgeHealthCheck,
  estimateCost,
  VideoForgeRequestError,
} from "./services/video-forge-client.js";
export type {
  VideoForgeError,
  ForgeImageResult,
  ForgeVideoSubmitResult,
  ForgeVideoJobStatus,
  ForgeTtsResult,
  ForgeComposeResult,
  ForgeConcatResult,
  ForgeBgmResult,
  ForgeAnalyseResult,
  CostEstimate,
} from "./services/video-forge-client.js";

// Tools — video-forge 原子工具
export { videoForgeTools } from "./tools/video-forge.js";
