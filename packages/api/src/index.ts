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
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import path from "node:path";
import { createAppContext } from "./context.js";
import { closeDatabase, loadAllAgentConfigs, saveAgentConfig } from "@super-agent/core";
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
import { GatewayLauncher } from "./gateway-launcher.js";

// Load .env from monorepo root (two levels up from packages/api/)
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
// Also load local .env if exists (overrides root)
dotenv.config();

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport: {
        target: "pino-pretty",
        options: { colorize: true },
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
    try { closeDatabase(); } catch { /* ignore */ }
    process.exit(1);
  }

  // Load skills on startup
  ctx.skillLoader.loadAll();
  ctx.skillLoader.startWatching();

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
  await authRoutes(app);

  // WebSocket real-time event streaming
  await registerWebSocket(app, ctx);

  // ─── Restore or create the default agent ───────────────────
  // Build LLM config from ProviderStore (or env fallback)
  const activeProvider = ctx.providerStore.getActiveProvider();
  const llmConfig = (() => {
    if (activeProvider) {
      const providerDef = getProviderById(activeProvider.id);
      const modelId = activeProvider.selectedModel || providerDef?.models[0]?.id || "gpt-4o-mini";
      const modelDef = getModelById(activeProvider.id, modelId);
      return {
        type: "openai" as const,
        model: modelId,
        apiKey: activeProvider.apiKey,
        baseUrl: activeProvider.baseUrl || providerDef?.baseUrl || "",
        providerId: activeProvider.id,
        supportsReasoning: modelDef?.supportsReasoning ?? false,
        ...(modelDef?.fixedTemperature !== undefined ? { temperature: modelDef.fixedTemperature } : {}),
      };
    }
    // Fallback to legacy env vars
    return {
      type: (process.env.LLM_PROVIDER as "openai" | "anthropic" | "ollama") ?? "openai",
      model: process.env.LLM_MODEL ?? "gpt-4o-mini",
      apiKey: process.env.LLM_API_KEY,
      baseUrl: process.env.LLM_BASE_URL,
    };
  })();

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
    saveAgentConfig(defaultAgent.id, defaultAgent.config);
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

  // Start server
  const gatewayLauncher = new GatewayLauncher();
  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`Super Agent API running at http://${HOST}:${PORT}`);
    app.log.info(`OpenAI-compatible endpoint: http://${HOST}:${PORT}/v1/chat/completions`);
    app.log.info(`Health check: http://${HOST}:${PORT}/api/system/health`);

    // 所有核心模块已初始化 + HTTP 端口已就绪 → 安全启动 IM Gateway
    if (process.env.DISABLE_IM_GATEWAY !== "true") {
      await gatewayLauncher.start();
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    app.log.info("Shutting down...");
    // 先停 Gateway，再停核心模块
    await gatewayLauncher.stop();
    ctx.skillLoader.stopWatching();
    ctx.agentManager.stopAll();
    ctx.cronScheduler.stop();
    await ctx.mcpRegistry.disconnectAll().catch(() => {});
    closeDatabase();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
