/**
 * Model & Provider Routes — Manage LLM providers and browse the model catalog.
 *
 * GET    /api/models/catalog              — Built-in model catalog
 * GET    /api/models/providers            — Configured providers (with masked keys)
 * PUT    /api/models/providers/:id        — Update provider config (apiKey, baseUrl, etc.)
 * DELETE /api/models/providers/:id/key    — Clear a provider's API key
 * POST   /api/models/providers/:id/test   — Test provider connectivity
 */

import type { FastifyInstance } from "fastify";
import { sendSuccess, Errors } from "./response-helper.js";
import {
  getModelCatalog,
  getProviderById,
  getModelById,
  LLMProvider,
  logConfigChange,
  saveAgentConfig,
  // SEC-P0-04 · M1：统一使用 core 的 maskApiKey，删除本地重复实现。
  // SEC-P0-04 · E1：PUT /providers/:id 也走脱敏哨兵，阻止前端回写污染。
  maskApiKey,
  isMaskedApiKey,
} from "@super-agent/core";
import type { AppContext } from "../context.js";
// SEC-P0-06：PUT / DELETE 需 RBAC 鉴权，对齐 /api/ws/broadcast 等同项目端点风格。
import { requirePermission } from "../auth/index.js";
import type { ModelDef } from "@super-agent/core";

// 非对话模型 id 关键词（实时列表中过滤掉，只保留可对话的 chat 模型）
const NON_CHAT_MODEL_RE = /(embedding|embed|rerank|whisper|tts|audio|speech|voice|moderation|image|dall|ocr|clip|\bbge\b)/i;

/** 从模型 id 启发式推断能力（用于目录里没有的新型号）。 */
function inferModelDef(id: string): ModelDef {
  const lower = id.toLowerCase();
  return {
    id,
    name: id,
    contextWindow: 0,            // 未知（实时接口不返回上下文长度）
    supportsFunctions: true,     // OpenAI 兼容型默认支持
    supportsVision: /(vl|vision|multimodal|omni|image)/.test(lower),
    supportsReasoning: /(reason|think|-r1|qwq|o1|o3)/.test(lower),
    supportsStreaming: true,
    tags: ["live"],              // 标记为实时发现的新模型
  };
}

export async function modelRoutes(app: FastifyInstance, ctx: AppContext) {
  // ── GET /api/models/catalog ─────────────────────────────────
  app.get("/api/models/catalog", async (_request, reply) => {
    return sendSuccess(reply, { providers: getModelCatalog() });
  });

  // ── GET /api/models/providers ───────────────────────────────
  app.get("/api/models/providers", async (_request, reply) => {
    const records = ctx.providerStore.list();
    const catalog = getModelCatalog();

    // Merge catalog info with stored config
    const result = catalog.map((providerDef) => {
      const record = records.find((r) => r.id === providerDef.id);
      return {
        id: providerDef.id,
        name: providerDef.name,
        website: providerDef.website,
        baseUrl: record?.baseUrl || providerDef.baseUrl,
        defaultBaseUrl: providerDef.baseUrl,
        isEnabled: record?.isEnabled ?? true,
        selectedModel: record?.selectedModel || "",
        keyStatus: record?.apiKey ? "configured" : "missing",
        maskedKey: record?.apiKey ? maskApiKey(record.apiKey) : "",
        models: providerDef.models,
      };
    });

    return sendSuccess(reply, { providers: result });
  });

  // ── PUT /api/models/providers/:id ───────────────────────────
  // SEC-P0-06：增加 requirePermission("*") 防止未鉴权写入；
  //            与 /api/ws/broadcast / /api/auth/keys 同级安全等级。
  app.put<{ Params: { id: string }; Body: { apiKey?: string; baseUrl?: string; isEnabled?: boolean; selectedModel?: string } }>(
    "/api/models/providers/:id",
    { preHandler: requirePermission("*") },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body as any;

      // Validate provider exists in catalog (or is "custom")
      const providerDef = getProviderById(id);
      if (!providerDef) {
        return Errors.notFound(reply, "Unknown provider");
      }

      // SEC-P0-04 · E1 脱敏哨兵：前端 GET 到的是脱敏 key，整体回传时不能覆盖原值。
      const existingRecord = ctx.providerStore.get(id);
      const existingKeyMasked = existingRecord?.apiKey ? maskApiKey(existingRecord.apiKey) : undefined;
      const incomingKeyRaw = typeof body.apiKey === "string" ? body.apiKey : "";
      const effectiveApiKey =
        incomingKeyRaw && !isMaskedApiKey(incomingKeyRaw, existingKeyMasked)
          ? incomingKeyRaw
          : body.apiKey === "" ? "" : undefined; // 显式空串视为"清空 key"，undefined 则保持原值

      const record = ctx.providerStore.upsert(id, {
        apiKey: effectiveApiKey,
        baseUrl: body.baseUrl,
        isEnabled: body.isEnabled,
        selectedModel: body.selectedModel,
      });

      // SEC-P0-06 · 审计加固：记录变更前 baseUrl，便于追溯误改。
      logConfigChange("config.provider.upsert", {
        providerId: id,
        selectedModel: body.selectedModel,
        baseUrl: body.baseUrl,
        previousBaseUrl: existingRecord?.baseUrl,
        isEnabled: body.isEnabled,
        keyChanged: effectiveApiKey !== undefined,
        keyRejectedAsMasked: incomingKeyRaw !== "" && effectiveApiKey === undefined && body.apiKey !== "",
      });

      // 千问 provider 的 API Key 同时用于 QwenEmbedding 向量检索
      // CORE-P1-05：若启动时已有 Key（embedder 为 QwenEmbedding），保存后热更新无需重启；
      //             若启动时无 Key（embedder 为 HRRProvider），updateEmbedderApiKey 返回 false，
      //             需提示用户重启服务以切换到 QwenEmbedding。
      if (id === "qwen" && effectiveApiKey) {
        const hotReloaded = ctx.memoryManager.updateEmbedderApiKey(effectiveApiKey);
        if (hotReloaded) {
          app.log.info("QwenEmbedding API Key hot-reloaded from settings page");
        } else {
          app.log.warn(
            "千问 API Key 已保存，但当前 embedder 为 HRRProvider（启动时未配置 Key）。" +
            "需重启服务后方可切换为 QwenEmbedding 高级语义检索。",
          );
        }
      }

      // If this provider now has a valid config, update the default agent's LLM settings
      if (record.apiKey && record.selectedModel) {
        const agents = ctx.agentManager.listAgents();
        if (agents.length > 0) {
          const defaultAgent = agents[0];
          const baseUrl = record.baseUrl || providerDef.baseUrl;
          const modelDef = getModelById(id, record.selectedModel);
          const newLlmConfig = {
            type: "openai" as const,  // All Chinese providers use OpenAI-compatible API
            model: record.selectedModel,
            apiKey: record.apiKey,
            baseUrl,
            providerId: id,
            supportsReasoning: modelDef?.supportsReasoning ?? false,
            ...(modelDef?.fixedTemperature !== undefined ? { temperature: modelDef.fixedTemperature } : {}),
          };
          const updatedAgent = ctx.agentManager.updateAgent(defaultAgent.id, {
            llmProvider: newLlmConfig,
          });
          // Persist updated agent config to SQLite so it survives restarts
          if (updatedAgent) {
            try {
              saveAgentConfig(updatedAgent.id, updatedAgent.state.config as unknown as Record<string, unknown>);
              app.log.info({ agent: updatedAgent.id, provider: id, model: record.selectedModel }, "Agent LLM config updated and persisted");
            } catch (persistErr) {
              // 持久化失败 → 回滚 Agent 内存状态，保证一致性
              app.log.error({ err: persistErr }, "Failed to persist agent config, rolling back");
              const prevLlmConfig = defaultAgent.config?.llmProvider;
              ctx.agentManager.updateAgent(defaultAgent.id, {
                llmProvider: prevLlmConfig ?? { type: "openai", model: "", apiKey: "", baseUrl: "" },
              });
              return Errors.internal(reply, "保存 Agent 配置失败，已回滚");
            }
          }
        }
      }

      return sendSuccess(reply, {
        provider: {
          id: record.id,
          isEnabled: record.isEnabled,
          selectedModel: record.selectedModel,
          keyStatus: record.apiKey ? "configured" : "missing",
          maskedKey: record.apiKey ? maskApiKey(record.apiKey) : "",
          baseUrl: record.baseUrl || providerDef.baseUrl,
        },
      });
    }
  );

  // ── DELETE /api/models/providers/:id/key ────────────────────
  // SEC-P0-06：同样需要 RBAC 保护，避免未鉴权清空 key 造成服务中断。
  app.delete<{ Params: { id: string } }>(
    "/api/models/providers/:id/key",
    { preHandler: requirePermission("*") },
    async (request, reply) => {
      const ok = ctx.providerStore.clearKey(request.params.id);
      if (!ok) {
        return Errors.notFound(reply, "Provider not found");
      }
      logConfigChange("config.provider.delete", { providerId: request.params.id, action: "clearKey" });
      return sendSuccess(reply, { success: true });
    }
  );

  // ── POST /api/models/providers/:id/test ─────────────────────
  // API-P1-01 / SEC：此前该端点无鉴权、无限速，任何客户端可触发对外 LLM 调用
  // 造成 apiKey 侧信道消耗；现加固三层：
  //   1) preHandler: requirePermission("*")  RBAC 限管理员调用
  //   2) rateLimit 5 req/min  防暴力扫描/配额耗尽
  //   3) catch 块改为 throw，由全局 registerErrorHandler 按 NODE_ENV 脱敏输出，
  //      不再在响应里直出 err.message（API-P1-03 规范）
  app.post<{ Params: { id: string }; Body: { model?: string; apiKey?: string; baseUrl?: string } }>(
    "/api/models/providers/:id/test",
    {
      preHandler: requirePermission("*"),
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body as any;
      const providerDef = getProviderById(id);
      const record = ctx.providerStore.get(id);

      if (!providerDef) {
        return Errors.notFound(reply, "Unknown provider");
      }

      // Accept apiKey from request body (for testing before saving) or from DB
      const apiKey = body?.apiKey || record?.apiKey;
      if (!apiKey) {
        return Errors.badRequest(reply, "API Key not configured");
      }

      const modelId = body?.model || record?.selectedModel || (providerDef.models[0]?.id ?? "");
      if (!modelId) {
        return Errors.badRequest(reply, "No model specified");
      }

      const baseUrl = body?.baseUrl || record?.baseUrl || providerDef.baseUrl;
      const modelDef = getModelById(id, modelId);

      try {
        const provider = new LLMProvider({
          type: "openai",
          model: modelId,
          apiKey,
          baseUrl,
          providerId: id,
          supportsReasoning: modelDef?.supportsReasoning ?? false,
          ...(modelDef?.fixedTemperature !== undefined ? { temperature: modelDef.fixedTemperature } : {}),
        });

        const result = await provider.complete({
          messages: [{ role: "user", content: "Hi, reply with just 'ok'." }],
        });

        return sendSuccess(reply, {
          success: true,
          model: modelId,
          response: result.content?.slice(0, 100) ?? "",
          usage: result.usage,
        });
      } catch (err) {
        // API-P1-03：详细错误仅进日志，对外统一 502 不回显内部栈
        app.log.error({ providerId: id, modelId, err }, "Provider connectivity test failed");
        return Errors.badGateway(reply, "模型连接测试失败", { providerId: id, modelId });
      }
    }
  );

  // ── POST /api/models/providers/:id/models ───────────────
  // 手动拉取提供商实时模型列表（OpenAI 兼容 GET /models）并与静态目录合并，
  // 使提供商新发布的型号无需改代码即可在选择框出现。
  // 安全：与 /test 同级——requirePermission("*") + 限速（防刷 Key 配额）。
  app.post<{ Params: { id: string }; Body: { apiKey?: string; baseUrl?: string } }>(
    "/api/models/providers/:id/models",
    {
      preHandler: requirePermission("*"),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body as { apiKey?: string; baseUrl?: string } | undefined;
      const providerDef = getProviderById(id);
      if (!providerDef) {
        return Errors.notFound(reply, "Unknown provider");
      }
      const record = ctx.providerStore.get(id);

      // 脱敏哨兵：前端可能回传脱敏 key，此时用已存的真实 key
      const existingKeyMasked = record?.apiKey ? maskApiKey(record.apiKey) : undefined;
      const incomingKeyRaw = typeof body?.apiKey === "string" ? body.apiKey : "";
      const apiKey =
        incomingKeyRaw && !isMaskedApiKey(incomingKeyRaw, existingKeyMasked)
          ? incomingKeyRaw
          : record?.apiKey;
      if (!apiKey) {
        return Errors.badRequest(reply, "请先配置 API Key 再获取模型列表");
      }

      const baseUrl = body?.baseUrl || record?.baseUrl || providerDef.baseUrl;

      try {
        const provider = new LLMProvider({ type: "openai", model: "", apiKey, baseUrl, providerId: id });
        const liveIds = await provider.listModels();

        // 合并：目录已有→用目录元数据；目录没有→启发式推断；过滤非对话模型
        const catalogById = new Map(providerDef.models.map((m) => [m.id, m]));
        const seen = new Set<string>();
        const merged: ModelDef[] = [];
        const newModels: string[] = [];
        for (const raw of liveIds) {
          const mid = (raw ?? "").trim();
          if (!mid || NON_CHAT_MODEL_RE.test(mid) || seen.has(mid)) continue;
          seen.add(mid);
          const existing = catalogById.get(mid);
          if (existing) {
            merged.push(existing);
          } else {
            merged.push(inferModelDef(mid));
            newModels.push(mid);
          }
        }
        // 目录里有、实时未返回的模型也保留（避免误删用户在用的）
        for (const m of providerDef.models) {
          if (!seen.has(m.id)) merged.push(m);
        }

        logConfigChange("config.provider.models.refresh", {
          providerId: id,
          liveCount: seen.size,
          newCount: newModels.length,
        });

        return sendSuccess(reply, {
          models: merged,
          liveCount: seen.size,
          newCount: newModels.length,
          newModels,
          fetchedAt: new Date().toISOString(),
        });
      } catch (err) {
        // 详细错误仅进日志，对外统一 502
        app.log.error({ providerId: id, err }, "获取实时模型列表失败");
        return Errors.badGateway(reply, "获取模型列表失败（请检查 API Key / Base URL）", { providerId: id });
      }
    }
  );
}
