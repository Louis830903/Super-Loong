/**
 * Application context shared across all route handlers.
 */

import { AgentManager, SkillLoader, MessageRouter, MemoryManager, CollaborationOrchestrator, EvolutionEngine, SecurityManager, MCPRegistry, MCPMarketplace, CronScheduler, SkillMarketplace, builtinTools, getAllBuiltinTools, createMemoryTools, createSkillTools, initDatabase, SQLiteBackend, QwenEmbedding, AliyunVoiceProvider, DockerSandbox, SSHSandbox, ProviderStore, initConfigStore, paths, ensureDirectories, loadNudgeConfig, ConfigStoreAdapter, SourceRouter } from "@super-agent/core";
import type { VoiceProvider, ConfigStore } from "@super-agent/core";
import { createDedupCache, type DedupCache } from "./shared/dedup.js";
import pino from "pino";

const logger = pino({ name: "context" });

export interface AppContext {
  agentManager: AgentManager;
  skillLoader: SkillLoader;
  router: MessageRouter;
  memoryManager: MemoryManager;
  collaborationOrchestrator: CollaborationOrchestrator;
  evolutionEngine: EvolutionEngine;
  securityManager: SecurityManager;
  mcpRegistry: MCPRegistry;
  mcpMarketplace: MCPMarketplace;
  cronScheduler: CronScheduler;
  skillMarketplace: SkillMarketplace;
  providerStore: ProviderStore;
  configStore: ConfigStore;
  voiceProvider?: VoiceProvider;
  /** 传输层无关的请求去重缓存（WS/HTTP 共用） */
  dedup: DedupCache;
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

  // P1-11: Check for DASHSCOPE_API_KEY at startup and warn if missing
  if (!process.env.DASHSCOPE_API_KEY) {
    logger.warn(
      "DASHSCOPE_API_KEY not set — QwenEmbedding will fall back to SimpleEmbedding (reduced search quality)"
    );
  }

  // Use Qwen text-embedding-v4 (2048 dims) for semantic embeddings
  const qwenEmbedder = new QwenEmbedding({ dimensions: 2048 });

  const agentManager = new AgentManager();
  const skillLoader = new SkillLoader([paths.skills()]);
  const router = new MessageRouter(agentManager);
  const memoryManager = new MemoryManager({ backend: sqliteBackend, embedder: qwenEmbedder });
  const collaborationOrchestrator = new CollaborationOrchestrator(agentManager);
  const evolutionEngine = new EvolutionEngine(agentManager, loadNudgeConfig() ?? undefined);
  // Phase A-1: 连接进化引擎与 AgentManager，启用 Nudge 自动化闭环
  agentManager.setEvolutionEngine(evolutionEngine);
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
    const result = await agent.chat(job.message);
    return result.response;
  });
  cronScheduler.start();
  logger.info("Cron scheduler started");

  // Initialize Provider Store (LLM provider persistence)
  const providerStore = new ProviderStore();
  providerStore.init();
  providerStore.syncFromEnv();
  providerStore.migrateKeys(); // Auto-migrate legacy base64 keys → AES-256-CBC
  logger.info("ProviderStore initialized and synced from env");

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

  return { agentManager, skillLoader, router, memoryManager, collaborationOrchestrator, evolutionEngine, securityManager, mcpRegistry, mcpMarketplace, cronScheduler, skillMarketplace, providerStore, configStore, voiceProvider, dedup };
}
