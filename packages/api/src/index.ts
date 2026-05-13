/**
 * Super Agent API Server — main entry point.
 *
 * Starts a Fastify HTTP server with:
 * - REST API routes for agents, chat, skills, channels
 * - Authentication & authorization (JWT + API Key + RBAC)
 * - Middleware: rate limiting, request logging, error handling
 * - WebSocket real-time event streaming
 * - OpenAI-compatible /v1/chat/completions endpoint
 * - CORS support for the Web UI
 *
 * [Task 3i] forge_tts 字段名对齐触发 tsx watch reload (2026-04-29)
 * [Task 3q] bootstrap URL 解码修复 %20 路径污染触发 reload (2026-04-29)
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createAppContext } from "./context.js";
import { closeDatabase, loadAllAgentConfigs, saveAgentConfig, setTracingEnabled, ensureBuiltinAgents, HeartbeatRunner, DEFAULT_HEARTBEAT_CONFIG, checkForUpdates } from "@super-agent/core";
import { getProviderById, getModelById, getModelCatalog } from "@super-agent/core";

import { registerMiddleware } from "./middleware/index.js";
import { registerAuth, authRoutes } from "./auth/index.js";
import { registerWebSocket } from "./ws/index.js";
import { agentRoutes } from "./routes/agents.js";
import { chatRoutes } from "./routes/chat.js";
import { skillRoutes } from "./routes/skills.js";
import { channelRoutes } from "./routes/channels.js";
import { memoryRoutes } from "./routes/memory.js";
import { collaborationRoutes } from "./routes/collaboration.js";
import { evolutionRoutes } from "./routes/evolution.js";
import { securityRoutes } from "./routes/security.js";
import { mcpRoutes } from "./routes/mcp.js";
import { cronRoutes } from "./routes/cron.js";
import { voiceRoutes } from "./routes/voice.js";
import { modelRoutes } from "./routes/models.js";
import { serviceRoutes } from "./routes/services.js";
import { fileRoutes } from "./routes/files.js";
import { mediaRoutes } from "./routes/media.js";
import { settingsRoutes } from "./routes/settings.js";
import { knowledgeGraphRoutes } from "./routes/knowledge-graph.js";
import { knowledgeBaseRoutes } from "./routes/knowledge-base.js";
import { a2aAdminRoutes } from "./routes/a2a-admin.js";
import { videoRoutes } from "./routes/video.js";
import { videoProviderTemplateRoutes } from "./routes/video-provider-templates.js";
import { registerTracesRoutes } from "./routes/traces.js";
import { versionRoutes } from "./routes/version.js";
import { updateRoutes } from "./routes/update.js";
import { startUpdatePoller } from "./update-poller.js";
import { GatewayLauncher } from "./gateway-launcher.js";
import { VideoForgeSupervisor } from "./services/video-forge-supervisor.js";
import { registerWellKnownRoute, a2aPlugin } from "./a2a/server.js";

// Load .env from monorepo root (two levels up from packages/api/)
// 使用 import.meta.dirname 绝对路径，避免 PM2 从 monorepo 根目录运行时 cwd 路径错误
const monorepoRoot = path.resolve(import.meta.dirname ?? __dirname, "../..");
dotenv.config({ path: path.join(monorepoRoot, ".env") });
// 生产环境时叠加加载 .env.production（后加载覆盖前加载）
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: path.join(monorepoRoot, ".env.production") });
}
// 本地 .env 最后加载（最高优先级）
dotenv.config();

// 同步追踪状态：dotenv 加载后的环境变量可能和模块加载时不同
if (process.env.ENABLE_TRACING === "true") {
  setTracingEnabled(true);
}

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

// 日志落盘目录：packages/api/logs/api-YYYY-MM-DD.log（按日分文件，便于诊断）
// 历史曾经落盘过，后续被改成 pino-pretty 单 target 后停更；这里恢复同时写 stdout + file。
const LOG_DIR = path.resolve(process.cwd(), "logs");
const LOG_FILE = path.join(
  LOG_DIR,
  `api-${new Date().toISOString().slice(0, 10)}.log`,
);

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport: {
        // 双 target：控制台保留彩色 pino-pretty，文件走 pino/file 结构化 JSON。
        // 任一 target 内部异常不会阻塞另一个，兼顾可读性与可诊断性。
        targets: [
          {
            target: "pino-pretty",
            options: { colorize: true },
            level: process.env.LOG_LEVEL ?? "info",
          },
          {
            target: "pino/file",
            options: { destination: LOG_FILE, mkdir: true },
            level: process.env.LOG_LEVEL ?? "info",
          },
        ],
      },
    },
  });

  // CORS — allow the Next.js frontend
  await app.register(cors, {
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      process.env.FRONTEND_URL,
    ].filter(Boolean) as string[],
    credentials: true,
  });

  // 纵深防御：容忍 Content-Type: application/json 但 body 为空的请求
  // 解决 Next.js 代理 DELETE/POST 无 body 请求时附带 Content-Length: 0 导致 JSON 解析失败
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req: any, body: string, done: Function) => {
    if (!body || body.trim() === "") {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // Middleware: request ID, logging, rate limiting, error handling
  await registerMiddleware(app);

  // Authentication (optional, enabled via AUTH_ENABLED=true)
  await registerAuth(app);

  // Create shared application context (async — initializes SQLite)
  // P2-11: Wrap in try-catch for clear startup error reporting
  let ctx: Awaited<ReturnType<typeof createAppContext>>;
  try {
    ctx = await createAppContext();
  } catch (err) {
    app.log.error(err, "Failed to create application context");
    // P2-12: Close database on startup failure to release file locks
    // CORE-P0-08：closeDatabase 已 async，捕获失败避免阻塞启动错误上报
    try { await closeDatabase(); } catch { /* ignore */ }
    process.exit(1);
  }

  // Load skills on startup
  ctx.skillLoader.loadAll();
  ctx.skillLoader.startWatching();

  // ─── A2A 协议端点（条件性启用）───────────────────────────
  if (process.env.ENABLE_A2A === "true" && ctx.a2aTaskStore) {
    // Task 3.2: AgentCard 动态化 — 从 AgentManager 获取实际信息，而非硬编码
    const buildDynamicCard = (extended?: boolean) => {
      const defaultAgentId = ctx.router.getDefaultAgentId();
      const defaultRuntime = defaultAgentId ? ctx.agentManager.getAgent(defaultAgentId) : undefined;
      const agentName = (defaultRuntime as any)?.config?.name || "Super Agent";
      const agentDesc = (defaultRuntime as any)?.config?.description || "AI Agent Platform with multi-agent collaboration";
      // 从 skillLoader 获取实际已加载的技能列表（非空数组）
      const skills = (ctx.skillLoader?.listSkills() || []).map((s: any) => ({
        id: s.id || s.name, name: s.name, description: s.description || "", tags: s.tags || [],
      }));
      const baseCard = {
        name: agentName,
        description: agentDesc,
        version: "0.1.0",
        protocolVersion: "0.3.0",
        url: `http://${HOST}:${PORT}`,
        capabilities: { streaming: true, pushNotifications: !!ctx.a2aPushDispatcher },
        skills,
        defaultInputModes: ["text"],
        defaultOutputModes: ["text"],
      };
      // 扩展 Card：带 auth 时返回 securitySchemes
      if (extended) {
        return { ...baseCard, securitySchemes: { bearer: { type: "http" as const, scheme: "bearer" } } };
      }
      return baseCard;
    };

    // well-known 必须在根级注册（绕过 plugin prefix）
    await registerWellKnownRoute(app, buildDynamicCard);

    // A2A JSON-RPC + SSE 端点
    await app.register(a2aPlugin, {
      getAgentCard: buildDynamicCard,
      taskStore: ctx.a2aTaskStore,
      registry: ctx.a2aRegistry,
      pushDispatcher: ctx.a2aPushDispatcher,
      onSendMessage: async (req) => {
        // A2A 入方处理：远端 Agent 通过 JSON-RPC 发来的消息，委托当前默认 Agent 处理
        const textParts = req.message.parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n");

        if (!textParts.trim()) {
          return {
            type: "message",
            message: { role: "agent", parts: [{ type: "text", text: "Empty message received." }] },
          };
        }

        // 通过 router 获取默认 Agent 的已有 Runtime 实例（避免重复创建）
        const defaultAgentId = ctx.router.getDefaultAgentId();
        const runtime = defaultAgentId ? ctx.agentManager.getAgent(defaultAgentId) : undefined;
        if (!runtime) {
          throw new Error("No default agent configured for A2A message handling");
        }

        // 构建隔离会话 ID（A2A 请求不复用用户会话）
        const sessionId = `a2a-${randomUUID()}`;

        // 调用已有 Runtime 的 chat() 方法
        // chat() 返回 { sessionId, response, toolCalls, attachments }
        const result = await runtime.chat(textParts, sessionId);

        // 包装为 A2A Message 格式返回
        return {
          type: "message",
          message: {
            role: "agent",
            parts: [{ type: "text", text: result.response || "" }],
          },
        };
      },
      // Task 3.1: A2A 流式消息回调 — 委托 chatStream() 实现 SSE
      onStreamMessage: async (req, write) => {
        const textParts = req.message.parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n");

        const defaultAgentId = ctx.router.getDefaultAgentId();
        const runtime = defaultAgentId ? ctx.agentManager.getAgent(defaultAgentId) : undefined;
        if (!runtime) {
          write(JSON.stringify({ type: "error", error: "No default agent configured" }));
          return;
        }

        const sessionId = `a2a-stream-${randomUUID()}`;

        // 逐 chunk 输出 SSE 帧（server.ts 会自动追加 done 帧并关闭连接）
        for await (const chunk of runtime.chatStream(textParts, sessionId)) {
          if (chunk.type === "content") {
            write(JSON.stringify({
              type: "status",
              taskId: sessionId,
              state: "working",
              message: { role: "agent", parts: [{ type: "text", text: (chunk as any).text || "" }] },
            }));
          } else if (chunk.type === "error") {
            write(JSON.stringify({ type: "error", error: (chunk as any).message || "Stream error" }));
          }
        }
      },
    });
    app.log.info("A2A 协议端点已启用: POST /a2a + POST /a2a/stream + GET /.well-known/agent-card.json");
  }

  // Register routes
  await agentRoutes(app, ctx);
  await chatRoutes(app, ctx);
  await skillRoutes(app, ctx);
  await channelRoutes(app, ctx);
  await memoryRoutes(app, ctx);
  await collaborationRoutes(app, ctx);
  await evolutionRoutes(app, ctx);
  await securityRoutes(app, ctx);
  await mcpRoutes(app, ctx);
  await cronRoutes(app, ctx);
  await voiceRoutes(app, ctx);
  await modelRoutes(app, ctx);
  await serviceRoutes(app, ctx);
  await fileRoutes(app);
  await mediaRoutes(app);
  await settingsRoutes(app, ctx);
  await knowledgeGraphRoutes(app, ctx);
  await knowledgeBaseRoutes(app, ctx);
  await a2aAdminRoutes(app, ctx);
  await videoRoutes(app, ctx);
  await videoProviderTemplateRoutes(app);
  await authRoutes(app);
  await registerTracesRoutes(app);
  await versionRoutes(app);
  await updateRoutes(app);

// 启动定时版本轮询 + WebSocket 主动推送（每 6h 检查，发现更新推送给所有在线前端）
const stopUpdatePoller = startUpdatePoller(app);
app.addHook("onClose", () => stopUpdatePoller());

  // WebSocket real-time event streaming
  await registerWebSocket(app, ctx);

  // ─── Restore or create the default agent ───────────────────
  // Build LLM config from ProviderStore (or env fallback)
  const activeProvider = ctx.providerStore.getActiveProvider();

  // 首次启动引导：根据 Provider 配置状态输出不同级别的引导信息
  const uiPort = process.env.PORT ? Number(process.env.PORT) - 1000 : 3000;
  if (!activeProvider) {
    app.log.info(
      "\n============================================================\n" +
      "  ✅ 系统已就绪！请在浏览器完成最后一步配置：\n" +
      `  👉 http://localhost:${uiPort}/settings\n` +
      "\n" +
      "  操作：选择 Provider → 填入 API Key → 保存\n" +
      "  支持：Kimi / 智谱GLM / 千问 / DeepSeek / MiniMax / 豆包 / 自定义\n" +
      "  配置后无需重启，立即可用\n" +
      "============================================================"
    );
  } else {
    app.log.info(
      `已加载 Provider: ${activeProvider.id}, 模型: ${activeProvider.selectedModel || "默认"}`
    );
  }

  const llmConfig = (() => {
    // P3-1：启动阶段优先走统一钩子，钩子内部已将配置同步到 orchestrator。
    // 然后将相同配置用于恢复历史 Agent（saved agent 无 llmProvider 时的 fallback）。
    const applied = ctx.applyActiveProvider();
    if (applied) return applied;

    // 无 active provider：降级到 env 兜底，此时调用方直接同步一次以避免 orchestrator
    // 在首次使用 autoAssign 时因无配置而报错。env fallback 逻辑仅启动入口感知。
    const envConfig = {
      type: (process.env.LLM_PROVIDER as "openai" | "anthropic" | "ollama") ?? "openai",
      model: process.env.LLM_MODEL ?? "gpt-4o-mini",
      apiKey: process.env.LLM_API_KEY,
      baseUrl: process.env.LLM_BASE_URL,
    };
    ctx.collaborationOrchestrator.setGlobalLlmConfig(envConfig);
    return envConfig;
  })();

  // 说明：P3-1 后启动时的 setGlobalLlmConfig 主要由 ctx.applyActiveProvider() 完成；
  // env fallback 分支会在上面闭包内补一次 setGlobalLlmConfig。后续 Provider 切换均走统一钩子，
  // 避免路由层直接耦合 Orchestrator 内部 API。

  // Step 1: Restore persisted agents from SQLite
  const savedAgents = loadAllAgentConfigs();
  for (const { id, config } of savedAgents) {
    try {
      // Check if the saved agent already has a valid LLM config (model + apiKey).
      // If so, preserve it — only use the global llmConfig as fallback for agents
      // that have no saved LLM config (e.g., agents created before provider setup).
      const savedLlm = (config as Record<string, unknown>).llmProvider as Record<string, unknown> | undefined;
      const hasValidSavedLlm = savedLlm && savedLlm.model && savedLlm.apiKey;

      // Enrich saved LLM config with providerId and supportsReasoning if missing
      // (for configs saved before these fields were added)
      let enrichedSavedLlm = savedLlm;
      if (hasValidSavedLlm && (!savedLlm.providerId || savedLlm.supportsReasoning === undefined)) {
        const savedBaseUrl = (savedLlm.baseUrl as string) || "";
        const savedModel = savedLlm.model as string;
        // Detect provider from baseUrl
        const catalog = getModelCatalog();
        const matchedProvider = catalog.find((p) => p.baseUrl && savedBaseUrl.includes(new URL(p.baseUrl).hostname));
        if (matchedProvider) {
          const matchedModel = matchedProvider.models.find((m) => m.id === savedModel);
          enrichedSavedLlm = {
            ...savedLlm,
            providerId: savedLlm.providerId ?? matchedProvider.id,
            supportsReasoning: savedLlm.supportsReasoning ?? (matchedModel?.supportsReasoning ?? false),
          };
          app.log.info({ agentId: id, providerId: matchedProvider.id, model: savedModel, supportsReasoning: matchedModel?.supportsReasoning ?? false }, "Enriched saved LLM config with catalog metadata");
        }
      }

      // Upgrade maxToolIterations from old default (10) to new default (90)
      const savedMaxIter = (config as Record<string, unknown>).maxToolIterations as number | undefined;
      const upgradedMaxIter = (savedMaxIter !== undefined && savedMaxIter <= 10) ? 90 : savedMaxIter;
      if (savedMaxIter !== upgradedMaxIter) {
        app.log.info({ agentId: id, old: savedMaxIter, new: upgradedMaxIter }, "Upgraded maxToolIterations from old default");
      }

      const restoredConfig = {
        ...config,
        id,
        name: (config as Record<string, unknown>).name as string ?? "default",
        llmProvider: hasValidSavedLlm ? enrichedSavedLlm : llmConfig,
        maxToolIterations: upgradedMaxIter,
      };
      ctx.agentManager.createAgent(restoredConfig as Parameters<typeof ctx.agentManager.createAgent>[0]);
      const restoredModel = hasValidSavedLlm ? savedLlm.model : llmConfig.model;
      app.log.info({ agentId: id, model: restoredModel, maxToolIterations: upgradedMaxIter, source: hasValidSavedLlm ? "saved" : "global" }, "Agent restored from SQLite");
    } catch (err) {
      app.log.warn({ agentId: id, error: err }, "Failed to restore agent, will recreate");
    }
  }

  // Step 2: If no agents were restored, create a fresh default agent and persist it
  if (ctx.agentManager.count === 0) {
    const defaultAgent = ctx.agentManager.createAgent({
      name: "default",
      description: "Default AI assistant",
      systemPrompt: "You are a helpful AI assistant powered by Super Agent platform.",
      llmProvider: llmConfig,
    });
    saveAgentConfig(defaultAgent.id, defaultAgent.config as unknown as Record<string, unknown>);
    ctx.router.setDefaultAgent(defaultAgent.id);
    app.log.info({ agentId: defaultAgent.id, model: llmConfig.model }, "Default agent created and persisted");
  } else {
    // Set the first agent as default route target
    const agents = ctx.agentManager.listAgents();
    ctx.router.setDefaultAgent(agents[0].id);

    // Check if LLM config needs updating (empty model/apiKey)
    const firstAgent = agents[0];
    const cfg = firstAgent?.config?.llmProvider;
    if (!cfg?.model || !cfg?.apiKey) {
      ctx.agentManager.updateAgent(firstAgent.id, { llmProvider: llmConfig });
      saveAgentConfig(firstAgent.id, { ...firstAgent.config, llmProvider: llmConfig });
      app.log.info({ agentId: firstAgent.id, model: llmConfig.model }, "Fixed agent with empty LLM config");
    }
  }

  // ─── Step 3: 在默认路由已确定之后，注册内置专家 Agent ────────
  // ⚠️ v3 审查关键时序：必须在 setDefaultAgent() 之后调用
  // 否则 211 个内置 Agent 会抢占默认路由目标
  const { created: builtinCreated, updated: builtinUpdated, skipped: builtinSkipped } = ensureBuiltinAgents(ctx.agentManager, llmConfig as unknown as Record<string, unknown>);
  // P2-3: 始终输出摘要日志，不仅限于 created > 0
  app.log.info({ created: builtinCreated, updated: builtinUpdated, skipped: builtinSkipped }, "Builtin expert agents check");

  // ─── Step 4: HeartbeatRunner 接入全局调度 ───────────────
  // 为默认 Agent 构造 HeartbeatRunner（如果心跳配置启用）
  const hbDefaultAgentId = ctx.router.getDefaultAgentId();
  const hbDefaultRuntime = hbDefaultAgentId ? ctx.agentManager.getAgent(hbDefaultAgentId) : undefined;
  if (hbDefaultRuntime) {
    const hbCfg = ctx.configStore.getAll("heartbeat");
    const hbEnabled = hbCfg.enabled === "true";
    if (hbEnabled) {
      const runner = new HeartbeatRunner(
        {
          ...DEFAULT_HEARTBEAT_CONFIG,
          enabled: true,
          every: hbCfg.every || DEFAULT_HEARTBEAT_CONFIG.every,
          model: hbCfg.model || undefined,
          target: (hbCfg.target as "none" | "last" | string) || DEFAULT_HEARTBEAT_CONFIG.target,
        },
        ctx.cronScheduler,
      );
      // 注入执行回调：调用默认 Agent 的 chat 方法
      runner.setExecuteFn(async (msg, _ctxMd, isolated, _model) => {
        const sid = isolated ? `hb-${Date.now()}` : undefined;
        const result = await hbDefaultRuntime.chat(msg, sid);
        return result.response;
      });
      // 注入投递回调（记录日志，后续可扩展为实际渠道投递）
      runner.setDeliverFn(async (target, content) => {
        app.log.info({ target, contentLen: content.length }, "Heartbeat alert delivered");
      });
      // 存储到 Runtime 实例上（通过动态属性，避免修改 Runtime 类 API）
      (hbDefaultRuntime as any).heartbeatRunner = runner;
      runner.start();
      app.log.info({ agentId: hbDefaultAgentId }, "HeartbeatRunner constructed and started");
    }
  }

  // Start server
  const gatewayLauncher = new GatewayLauncher();
  const videoForgeSupervisor = new VideoForgeSupervisor();
  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`Super Agent API running at http://${HOST}:${PORT}`);
    app.log.info(`OpenAI-compatible endpoint: http://${HOST}:${PORT}/v1/chat/completions`);
    app.log.info(`Health check: http://${HOST}:${PORT}/api/system/health`);

    // 通知 PM2 进程就绪（仅在 PM2 管理下生效，直接运行时 process.send 为 undefined）
    if (process.send) {
      process.send("ready");
      app.log.info("PM2 ready signal sent");
    }

    // 启动时异步检查版本更新（不阻塞后续逻辑）
    checkForUpdates().then((result) => {
      if (result.outdated && result.latest) {
        app.log.info(
          "\n" +
          "  ╔══════════════════════════════════════════════════════════╗\n" +
          `  ║  新版本可用！ v${result.current} → v${result.latest}` +
          "\n" +
          `  ║  下载: ${result.releaseUrl}` +
          "\n" +
          `  ║  来源: ${result.source}` +
          "\n" +
          "  ╚══════════════════════════════════════════════════════════╝\n"
        );
      }
    });

    // 所有核心模块已初始化 + HTTP 端口已就绪 → 安全启动 IM Gateway
    if (process.env.DISABLE_IM_GATEWAY !== "true") {
      await gatewayLauncher.start();
    }

    // 启动 video-forge Python 微服务（bootstrap + spawn + 健康检查）
    if (process.env.DISABLE_VIDEO_FORGE !== "true") {
      // 不阻塞主流程：bootstrap 失败只警告，不影响其他功能
      videoForgeSupervisor.start().catch((err) => {
        app.log.warn({ err }, "video-forge 启动失败，视频相关功能不可用");
      });
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    app.log.info("Shutting down...");
    // 先停外部子进程，再停核心模块
    await videoForgeSupervisor.stop();
    // 知识库 Docling sidecar（若启用）
    if (ctx.kbParserStop) {
      await ctx.kbParserStop().catch((err) => {
        app.log.warn({ err }, "kb-parser 优雅停止失败（忽略）");
      });
    }
    await gatewayLauncher.stop();
    ctx.skillLoader.stopWatching();
    ctx.agentManager.stopAll();
    ctx.cronScheduler.stop();
    await ctx.mcpRegistry.disconnectAll().catch(() => {});
    // CORE-P0-08：closeDatabase 已 async，必须 await 确保在 app.close 前完成落盘
    await closeDatabase();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
