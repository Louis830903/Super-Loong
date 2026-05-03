/**
 * Application context shared across all route handlers.
 */

import { AgentManager, SkillLoader, MessageRouter, MemoryManager, CollaborationOrchestrator, EvolutionEngine, SecurityManager, MCPRegistry, MCPMarketplace, CronScheduler, SkillMarketplace, SubagentManager, SubagentAnnouncer, SubagentExecutor, builtinTools, getAllBuiltinTools, createMemoryTools, createSkillTools, initDatabase, SQLiteBackend, QwenEmbedding, HRRProvider, AliyunVoiceProvider, DockerSandbox, SSHSandbox, ProviderStore, initConfigStore, paths, ensureDirectories, loadNudgeConfig, ConfigStoreAdapter, SourceRouter, injectSysopsSecurityRules, TaskStore, InMemoryAgentRegistry, PushNotificationDispatcher, SessionSearchEngine, KnowledgeExtractor, InsightsEngine, VerificationPipeline, KnowledgeGraph, getProviderById, getModelById, KnowledgeBaseProvider } from "@super-agent/core";
import type { VoiceProvider, ConfigStore, IAgentRegistry, LLMProviderConfig, EmbeddingProvider, DoclingClient, KBEmbedder } from "@super-agent/core";
import { createDedupCache, type DedupCache } from "./shared/dedup.js";
import { KbParserSupervisor } from "./services/kb-parser-supervisor.js";
import pino from "pino";

const logger = pino({ name: "context" });

export interface AppContext {
  agentManager: AgentManager;
  skillLoader: SkillLoader;
  router: MessageRouter;
  memoryManager: MemoryManager;
  collaborationOrchestrator: CollaborationOrchestrator;
  /** E-1: 子代理生命周期管理（与 Orchestrator 共享同一实例） */
  subagentManager: SubagentManager;
  /** E-1: 子代理完成通报（与 Orchestrator 共享同一实例） */
  subagentAnnouncer: SubagentAnnouncer;
  /** 子代理执行器（executeFn 注入 + spawn 工具注册） */
  subagentExecutor: SubagentExecutor;
  evolutionEngine: EvolutionEngine;
  securityManager: SecurityManager;
  mcpRegistry: MCPRegistry;
  mcpMarketplace: MCPMarketplace;
  cronScheduler: CronScheduler;
  skillMarketplace: SkillMarketplace;
  providerStore: ProviderStore;
  configStore: ConfigStore;
  voiceProvider?: VoiceProvider;
  /**
   * 共享向量化器（知识库 T8 / §5.4）。
   * 与 memoryManager 复用同一实例（QwenEmbedding 或 HRRProvider），
   * 避免知识库路由自建实例造成 Key/维度不一致。
   * 接口结构与 core 内部的 KBEmbedder 同构（embed + embeddingType），
   * 知识库 ingestion/retrieval 直接传入即可。
   */
  embedder: EmbeddingProvider;
  /** A2A: Task 状态机存储（ENABLE_A2A=true 时初始化） */
  a2aTaskStore?: TaskStore;
  /** A2A: Agent 注册表 */
  a2aRegistry?: IAgentRegistry;
  /** A2A: Push Notification 分发器 */
  a2aPushDispatcher?: PushNotificationDispatcher;
  /** Task 3.4: Evolution 高级子模块（会话搜索、知识提取、统计洞察、验证管道） */
  sessionSearch?: SessionSearchEngine;
  knowledgeExtractor?: KnowledgeExtractor;
  insightsEngine?: InsightsEngine;
  verificationPipeline?: VerificationPipeline;
  /** Task 3.5: 知识图谱三元组存储 */
  knowledgeGraph?: KnowledgeGraph;
  /** 传输层无关的请求去重缓存（WS/HTTP 共用） */
  dedup: DedupCache;
  /**
   * 知识库 Docling sidecar 客户端（知识库 Spec §T7）。
   *
   * - 懒启动：client 构造立即完成，首次调用 parse() 才真正 spawn Python 子进程
   * - 可选：环境变量 DISABLE_KB_PARSER_SIDECAR=true 可整体关闭，client 为 undefined
   * - 语义：knowledge-base 路由把它透传给 ingestDocument，当 TS parser 抛
   *   PARSE_NEEDS_OCR / PARSE_EMPTY 时自动降级到 Docling
   */
  kbParserClient?: DoclingClient;
  /**
   * 知识库 sidecar 优雅停止钩子（index.ts shutdown 时调用）。
   *
   * 幂等：若 sidecar 从未启动，仅清理状态；若已启动则 SIGTERM + 5s 超时后 SIGKILL。
   */
  kbParserStop?: () => Promise<void>;
  /**
   * P3-1：统一应用当前激活 Provider 的单一入口。
   * 从 ProviderStore 读取 active provider → 构建 LLMProviderConfig →
   * 同步到 CollaborationOrchestrator.setGlobalLlmConfig，使 Hierarchical
   * autoAssign 模式下动态创建的 Agent 始终继承用户最新的模型配置。
   *
   * 调用方：
   *   - 启动入口（api/src/index.ts）：初始加载
   *   - Provider 切换路由（routes/models.ts PUT）：Key/模型变更后热更新
   *
   * 返回：构建的配置；若无 active provider（未配置任何 Key）则返回 null。
   * 当返回 null 时，orchestrator 保持上一次有效的配置不变；
   * 首次启动阶段可由调用方决定是否使用 env 兜底配置。
   */
  applyActiveProvider: () => LLMProviderConfig | null;
}

export async function createAppContext(): Promise<AppContext> {
  // Ensure all data directories exist (paths module: ~/.super-agent/*)
  ensureDirectories();
  logger.info({
    SA_HOME: paths.home(),
    database: paths.db(),
    skills: paths.skills(),
    sessions: paths.sessions(),
  }, "Super Agent data directory initialized");

  // Initialize SQLite persistence
  await initDatabase();

  // Use SQLite backend for memory persistence
  const sqliteBackend = new SQLiteBackend();

  // ── 提前初始化 ProviderStore（QwenEmbedding 需要从中读取用户在设置页面配置的千问 API Key）──
  const providerStore = new ProviderStore();
  providerStore.init();
  providerStore.syncFromEnv();
  providerStore.migrateKeys();
  logger.info("ProviderStore initialized and synced from env (early init for QwenEmbedding)");

  // 从 ProviderStore 读取千问 API Key（设置页面保存的优先，降级到 DASHSCOPE_API_KEY 环境变量）
  const qwenRecord = providerStore.get("qwen");
  const qwenApiKey = qwenRecord?.apiKey || process.env.DASHSCOPE_API_KEY || "";
  if (!qwenApiKey) {
    logger.warn(
      "千问 API Key 未配置 — 记忆检索将使用 HRR 确定性向量编码（零配置可用，标签正确）。" +
      "配置千问 API Key 后将自动升级为 text-embedding-v4 高级语义检索。"
    );
  } else {
    const source = qwenRecord?.apiKey ? "ProviderStore (设置页面)" : "env DASHSCOPE_API_KEY";
    logger.info({ source }, "千问 API Key 已加载，QwenEmbedding 高级向量检索已启用");
  }

  // CORE-P1-05: 有 Key 走 Qwen text-embedding-v4 (2048D)；无 Key 走 HRR 确定性向量
  //   —— 避免 QwenEmbedding 运行时把 Simple 哈希向量伪装成 "qwen" 类型污染检索
  const embedder: EmbeddingProvider = qwenApiKey
    ? new QwenEmbedding({ apiKey: qwenApiKey, dimensions: 2048 })
    : new HRRProvider();

  const agentManager = new AgentManager();
  const skillLoader = new SkillLoader([paths.skills()]);
  const router = new MessageRouter(agentManager);
  const memoryManager = new MemoryManager({ backend: sqliteBackend, embedder });

  // ─── 知识库 Provider 装配（Spec §T6 / §八） ─────
  // 注入 KnowledgeBaseProvider：Agent 对话时，prefetch 自动检索知识库并注入 system prompt，
  // 同时注册 kb_search / kb_list 两个工具供 Agent 调用。
  // 与 memoryManager 复用同一 embedder 实例，确保入库与检索的向量维度/类型一致。
  const kbProvider = new KnowledgeBaseProvider({
    // EmbeddingProvider 与 KBEmbedder 结构兼容（embed(q)→Promise<number[]>，embeddingType 一致）
    embedder: embedder as unknown as KBEmbedder,
  });
  memoryManager.addProvider(kbProvider);

  // 注册 KB 工具为全局工具：Agent 可直接调用 kb_search / kb_list
  // 工具执行时从 ToolContext 读取 agentId/userId 实现运行时隔离
  for (const tool of kbProvider.getToolSchemas()) {
    agentManager.registerGlobalTool(tool);
  }
  logger.info("KnowledgeBaseProvider registered — Agent 对话自动引用知识库");

  // E-1: 初始化子代理管理器和通报器，注入 Orchestrator
  const subagentManager = new SubagentManager();
  // I-2: 启动时回收孤儿子代理（DB 中 >30min 仍为 running 的记录）
  subagentManager.reconcileOrphans();
  const subagentAnnouncer = new SubagentAnnouncer();
  const collaborationOrchestrator = new CollaborationOrchestrator({
    agentManager,
    subagentManager,
    announcer: subagentAnnouncer,
  });
  logger.info("SubagentManager + SubagentAnnouncer integrated into CollaborationOrchestrator (E-1)");
  const evolutionEngine = new EvolutionEngine(agentManager, loadNudgeConfig() ?? undefined);
  // H-1: 连接进化引擎到协作编排器，协作完成后自动反馈交互数据
  collaborationOrchestrator.setEvolutionEngine(evolutionEngine);
  // Phase A-1: 连接进化引擎与 AgentManager，启用 Nudge 自动化闭环
  agentManager.setEvolutionEngine(evolutionEngine);

  // Task 3.4: 初始化 Evolution 高级子模块（无必需参数，均使用内部默认配置）
  const sessionSearch = new SessionSearchEngine();
  const knowledgeExtractor = new KnowledgeExtractor();
  const insightsEngine = new InsightsEngine();
  const verificationPipeline = new VerificationPipeline();
  // Task 3.5: 知识图谱（内部通过 getDatabase() 获取 SQLite 连接）
  const knowledgeGraph = new KnowledgeGraph();
  logger.info("Evolution advanced modules initialized (SessionSearch, KnowledgeExtractor, Insights, Verification, KnowledgeGraph)");
  const securityManager = new SecurityManager();

  // ── Docker Sandbox (auto-detect availability) ──
  const dockerSandbox = new DockerSandbox();
  try {
    const dockerAvailable = await dockerSandbox.isAvailable();
    if (dockerAvailable) {
      securityManager.setDockerSandbox(dockerSandbox);
      logger.info("Docker sandbox registered (container isolation available)");
    } else {
      logger.info("Docker not detected — Docker sandbox disabled, will fall back to process sandbox");
    }
  } catch {
    logger.info("Docker sandbox probe failed — disabled");
  }

  // ── SSH Sandbox (configured via environment variables) ──
  if (process.env.SSH_SANDBOX_HOST && process.env.SSH_SANDBOX_USER) {
    try {
      const sshSandbox = new SSHSandbox({
        host: process.env.SSH_SANDBOX_HOST,
        port: parseInt(process.env.SSH_SANDBOX_PORT ?? "22", 10),
        username: process.env.SSH_SANDBOX_USER,
        privateKeyPath: process.env.SSH_SANDBOX_KEY_PATH,
        password: process.env.SSH_SANDBOX_PASSWORD,
        timeout: parseInt(process.env.SSH_SANDBOX_TIMEOUT ?? "30000", 10),
        workDir: process.env.SSH_SANDBOX_WORKDIR ?? "/tmp/sa-sandbox",
      });
      securityManager.setSSHSandbox(sshSandbox);
      logger.info({ host: process.env.SSH_SANDBOX_HOST }, "SSH sandbox registered (remote execution available)");
    } catch (err: any) {
      logger.warn({ error: err.message }, "SSH sandbox initialization failed — disabled");
    }
  } else {
    logger.info("SSH sandbox not configured (set SSH_SANDBOX_HOST + SSH_SANDBOX_USER to enable)");
  }

  // Wire security manager into agent creation pipeline
  agentManager.setSecurityManager(securityManager);
  // Wire memory manager, skill loader, and platform into agent creation
  agentManager.setMemoryManager(memoryManager);
  agentManager.setSkillLoader(skillLoader);
  const platform = process.env.PLATFORM ?? "";
  agentManager.setPlatform(platform);
  if (!platform) {
    logger.warn("PLATFORM env not set — no platform-specific hints will be injected into prompts");
  }

  // 创建 SubagentExecutor 并注入 executeFn（路 A：CrewExecutor 自动调用子代理）
  const subagentExecutor = new SubagentExecutor(
    agentManager,
    subagentManager,
    subagentAnnouncer,
    securityManager,
    memoryManager,
    skillLoader,
    platform,
    () => router.getDefaultAgentId(), // 闭包解耦 MessageRouter
  );
  subagentManager.setExecuteFn(subagentExecutor.createExecuteFn());
  logger.info("SubagentExecutor created — executeFn injected into SubagentManager");

  // Register memory tools as global tools for all agents
  const memTools = createMemoryTools(memoryManager);
  for (const tool of memTools) {
    agentManager.registerGlobalTool(tool);
  }

  // Initialize Skill Marketplace (before skill tools so Agent gets search+install)
  const skillMarketplace = new SkillMarketplace(paths.skills());

  // Spec v3: 初始化多源路由器并连接到市场
  try {
    const sourceRouter = await SourceRouter.createDefault([paths.skills()]);
    skillMarketplace.setSourceRouter(sourceRouter);
    logger.info({ sources: sourceRouter.getSources().map((s) => s.sourceId) }, "SourceRouter connected to marketplace");
  } catch (err: any) {
    logger.warn({ error: err.message }, "SourceRouter initialization failed, marketplace will use legacy sources only");
  }

  logger.info("Skill marketplace initialized");

  // Register skill tools (skill_read, skill_list, skill_search, skill_install, skill_command)
  // Spec v3: 传入真实 ConfigStore 适配器而非空 InMemoryConfigStore
  const configStore = initConfigStore();
  logger.info("ConfigStore initialized and synced from env");

  // ── 启动时从 ConfigStore 恢复 Feature Flag → process.env ──
  // UI 设置页面修改的 Flag 会持久化到 ConfigStore，启动时需要恢复到 process.env
  // 以便后续的 getAllBuiltinTools() 能正确读取
  const FLAG_KEYS = [
    "SUPER_AGENT_SYSOPS_ENABLED",
    "SUPER_AGENT_OPS_TOOLS",
    "SUPER_AGENT_DEV_TOOLS",
    "SUPER_AGENT_DESKTOP_TOOLS",
    "SUPER_AGENT_COMPUTER_USE",
  ];
  let flagsRestored = 0;
  for (const key of FLAG_KEYS) {
    // ConfigStore 持久化值优先，但不覆盖已经在 .env 中显式设置的值
    if (!process.env[key] || process.env[key] === "false") {
      const dbValue = configStore.get("feature_flags", key);
      if (dbValue === "true") {
        process.env[key] = "true";
        flagsRestored++;
      }
    }
  }
  if (flagsRestored > 0) {
    logger.info({ count: flagsRestored }, "Feature flags restored from ConfigStore to process.env");
  }

  const skillConfigAdapter = new ConfigStoreAdapter(configStore);
  const skillTools = createSkillTools(skillLoader, skillMarketplace, skillConfigAdapter);
  for (const tool of skillTools) {
    agentManager.registerGlobalTool(tool);
  }
  logger.info({ count: skillTools.length }, "Skill tools registered (skill_read, skill_list, skill_search, skill_install, skill_command)");

  // Register built-in tools (16 core sync tools + async optional modules)
  // 核心同步工具立即注册，可选工具（浏览器/图片/语音）延迟加载
  for (const tool of builtinTools) {
    agentManager.registerGlobalTool(tool);
  }
  logger.info({ count: builtinTools.length }, "Core built-in tools registered (sync)");

  // 注册 spawn_subagent 到全局工具（路 B：Agent 主动调子代理）
  agentManager.registerGlobalTool(subagentExecutor.createSpawnTool());
  logger.info("spawn_subagent tool registered globally");

  // 异步加载可选工具模块（浏览器/图片生成/语音）
  try {
    const allTools = await getAllBuiltinTools();
    const optionalCount = allTools.length - builtinTools.length;
    if (optionalCount > 0) {
      // 只注册可选工具（核心工具已注册）
      const optionalTools = allTools.slice(builtinTools.length);
      for (const tool of optionalTools) {
        agentManager.registerGlobalTool(tool);
      }
      logger.info({ count: optionalCount }, "Optional tool modules loaded (async)");
    }
  } catch (err: any) {
    logger.warn({ error: err.message }, "Optional tool modules loading failed (non-critical)");
  }

  // ── SysOps 安全策略注入 (双层纵深防御 Layer 2) ──
  // 仅当 Feature Flag 开启时注入，为所有新增 SysOps 工具设置正确的沙箱隔离级别
  if (process.env.SUPER_AGENT_SYSOPS_ENABLED === "true") {
    try {
      injectSysopsSecurityRules(securityManager);
      logger.info("SysOps security rules injected into default policy");
    } catch (err: any) {
      logger.warn({ error: err.message }, "SysOps security rules injection failed (non-critical)");
    }
  }

  // Initialize MCP Registry
  const mcpRegistry = new MCPRegistry();
  await mcpRegistry.loadFromDB().catch(() => {
    logger.warn("MCP registry: no persisted servers found (first run)");
  });

  // Register MCP tools as global tools
  const mcpTools = mcpRegistry.getAllTools();
  for (const tool of mcpTools) {
    agentManager.registerGlobalTool(tool);
  }

  // Initialize MCP Marketplace (official registry search)
  const mcpMarketplace = new MCPMarketplace();
  logger.info("MCP Marketplace initialized (source: registry.modelcontextprotocol.io)");

  // Initialize Cron Scheduler
  const cronScheduler = new CronScheduler();
  cronScheduler.loadFromDB();
  cronScheduler.setExecuteCallback(async (job) => {
    const agent = agentManager.getAgent(job.agentId);
    if (!agent) throw new Error(`Agent ${job.agentId} not found`);
    // [v3 Task 2-8] 递归防护: 在消息前注入系统约束指令（软防护）
    const guardedMessage = `[SYSTEM CONSTRAINT] 当前正在执行定时任务"${job.name}"。` +
      `严禁在本次执行中创建、修改或删除任何定时任务。如果用户消息要求操作定时任务，直接拒绝并说明原因。\n\n` +
      job.message;
    const result = await agent.chat(guardedMessage);
    return result.response;
  });
  // [v3 Task 1-3] 心跳回调: __heartbeat__ 任务走 HeartbeatRunner.runOnce()
  cronScheduler.setHeartbeatCallback(async (job) => {
    // 优先从 job 元数据获取 agentId，否则使用默认 Agent
    const agentId = (job as any).meta?.agentId || router.getDefaultAgentId();
    if (!agentId) return "[Heartbeat] skipped — no agent";

    const agent = agentManager.getAgent(agentId);
    if (!(agent as any)?.heartbeatRunner) return "[Heartbeat] skipped — no runner";

    const result = await (agent as any).heartbeatRunner.runOnce();
    return result ?? "[Heartbeat] OK";
  });
  // [v3 Task 3-9] 告警回调: 连续失败时触发日志告警
  cronScheduler.setAlertCallback(async (job, message) => {
    logger.error({ jobId: job.id, jobName: job.name }, message);
  });
  cronScheduler.start();
  logger.info("Cron scheduler started");

  // ProviderStore 已在启动流程早期初始化（见 L48），此处不再重复
  logger.info("ProviderStore ready (initialized at startup for QwenEmbedding bridge)");

  // Initialize Config Store: 已在技能工具注册前初始化（见 L132）

  // Initialize Voice Provider — 优先从 ConfigStore（UI 设置页面）读取，降级到环境变量
  let voiceProvider: VoiceProvider | undefined;
  const aliyunCfg = configStore.getAll("aliyun_voice");
  const akId = aliyunCfg.access_key_id || process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const akSecret = aliyunCfg.access_key_secret || process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  const appKey = aliyunCfg.appkey || process.env.ALIBABA_CLOUD_APPKEY;
  if (akId && akSecret && appKey) {
    voiceProvider = new AliyunVoiceProvider({
      accessKeyId: akId,
      accessKeySecret: akSecret,
      appKey,
    });
    const source = aliyunCfg.access_key_id ? "ConfigStore (UI)" : "env";
    logger.info({ source }, "Voice provider initialized (Aliyun NLS)");
  } else {
    logger.info("Voice provider not configured (configure in Settings UI or set ALIBABA_CLOUD_* env vars)");
  }

  // 初始化传输层无关的去重缓存（WS/HTTP 共用，防止 Gateway 重试或 WS→HTTP 降级产生重复处理）
  const dedup = createDedupCache({ ttlMs: 60_000, maxSize: 5000 });
  logger.info("DedupCache initialized (TTL=60s, shared across WS/HTTP)");

  // ─── A2A 协议服务（条件性初始化）──────────────────────────
  let a2aTaskStore: TaskStore | undefined;
  let a2aRegistry: IAgentRegistry | undefined;
  let a2aPushDispatcher: PushNotificationDispatcher | undefined;

  if (process.env.ENABLE_A2A === "true") {
    a2aTaskStore = new TaskStore();
    a2aRegistry = new InMemoryAgentRegistry();
    a2aPushDispatcher = new PushNotificationDispatcher();
    logger.info("A2A 服务已初始化: TaskStore + InMemoryAgentRegistry + PushDispatcher");
  }

  // ─── P3-1：统一 Active Provider 应用钩子 ───────────────────
  // 以闭包形式捕获 providerStore / collaborationOrchestrator，避免调用方
  // 直接耦合 Orchestrator API。后续如果 Provider 切换需同步其他消费方
  // （如默认 Agent LLM / Embedder），只需在此处集中扩展。
  const applyActiveProvider = (): LLMProviderConfig | null => {
    const active = providerStore.getActiveProvider();
    if (!active) {
      logger.debug("applyActiveProvider: no active provider configured");
      return null;
    }
    const providerDef = getProviderById(active.id);
    const modelId = active.selectedModel || providerDef?.models[0]?.id || "gpt-4o-mini";
    const modelDef = getModelById(active.id, modelId);
    const config: LLMProviderConfig = {
      type: "openai",
      model: modelId,
      apiKey: active.apiKey,
      baseUrl: active.baseUrl || providerDef?.baseUrl || "",
      providerId: active.id,
      supportsReasoning: modelDef?.supportsReasoning ?? false,
      ...(modelDef?.fixedTemperature !== undefined ? { temperature: modelDef.fixedTemperature } : {}),
    };
    collaborationOrchestrator.setGlobalLlmConfig(config);
    logger.info(
      { providerId: active.id, model: modelId },
      "Active provider applied to CollaborationOrchestrator",
    );
    return config;
  };

  // ─── 知识库 Docling sidecar（知识库 Spec §T7，可选） ─────
  // 懒启动：此处仅构造 supervisor 与 client 句柄，首次上传扫描件时才 spawn Python。
  // 环境变量 DISABLE_KB_PARSER_SIDECAR=true 时完全跳过（router 无 docling → 行为回退到纯 TS 解析）
  let kbParserClient: DoclingClient | undefined;
  let kbParserStop: (() => Promise<void>) | undefined;
  if (process.env.DISABLE_KB_PARSER_SIDECAR !== "true") {
    const kbParserSupervisor = new KbParserSupervisor();
    kbParserClient = kbParserSupervisor.getClient();
    kbParserStop = () => kbParserSupervisor.stop();
    logger.info(
      "KbParserSupervisor 已创建（懒启动：首次上传需 OCR 的文档时才真正启动 Python sidecar）",
    );
  } else {
    logger.info(
      "KbParserSupervisor 已跳过（DISABLE_KB_PARSER_SIDECAR=true）—— 知识库将使用纯 TS 解析",
    );
  }

  return { agentManager, skillLoader, router, memoryManager, collaborationOrchestrator, subagentManager, subagentAnnouncer, subagentExecutor, evolutionEngine, securityManager, mcpRegistry, mcpMarketplace, cronScheduler, skillMarketplace, providerStore, configStore, voiceProvider, embedder, sessionSearch, knowledgeExtractor, insightsEngine, verificationPipeline, knowledgeGraph, dedup, a2aTaskStore, a2aRegistry, a2aPushDispatcher, applyActiveProvider, kbParserClient, kbParserStop };
}
