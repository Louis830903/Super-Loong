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
import { getModelCatalog, getProviderById, getModelById, LLMProvider, logConfigChange, saveAgentConfig } from "@super-agent/core";
import type { AppContext } from "../context.js";

function maskApiKey(key: string): string {
  if (!key || key.length < 8) return key ? "***" : "";
  return key.slice(0, 3) + "***..." + key.slice(-3);
}

export async function modelRoutes(app: FastifyInstance, ctx: AppContext) {
  // ── GET /api/models/catalog ─────────────────────────────────
  app.get("/api/models/catalog", async () => {
    return { providers: getModelCatalog() };
  });

  // ── GET /api/models/providers ───────────────────────────────
  app.get("/api/models/providers", async () => {
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

    return { providers: result };
  });

  // ── PUT /api/models/providers/:id ───────────────────────────
  app.put<{ Params: { id: string }; Body: { apiKey?: string; baseUrl?: string; isEnabled?: boolean; selectedModel?: string } }>(
    "/api/models/providers/:id",
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body as any;

      // Validate provider exists in catalog (or is "custom")
      const providerDef = getProviderById(id);
      if (!providerDef) {
        return reply.status(404).send({ error: "Unknown provider" });
      }

      const record = ctx.providerStore.upsert(id, {
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
        isEnabled: body.isEnabled,
        selectedModel: body.selectedModel,
      });

      logConfigChange("config.provider.upsert", {
        providerId: id,
        selectedModel: body.selectedModel,
        baseUrl: body.baseUrl,
        isEnabled: body.isEnabled,
        keyChanged: body.apiKey !== undefined,
      });

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
            saveAgentConfig(updatedAgent.id, updatedAgent.state.config as unknown as Record<string, unknown>);
            app.log.info({ agent: updatedAgent.id, provider: id, model: record.selectedModel }, "Agent LLM config updated and persisted");
          }
        }
      }

      return {
        provider: {
          id: record.id,
          isEnabled: record.isEnabled,
          selectedModel: record.selectedModel,
          keyStatus: record.apiKey ? "configured" : "missing",
          maskedKey: record.apiKey ? maskApiKey(record.apiKey) : "",
          baseUrl: record.baseUrl || providerDef.baseUrl,
        },
      };
    }
  );

  // ── DELETE /api/models/providers/:id/key ────────────────────
  app.delete<{ Params: { id: string } }>(
    "/api/models/providers/:id/key",
    async (request, reply) => {
      const ok = ctx.providerStore.clearKey(request.params.id);
      if (!ok) {
        return reply.status(404).send({ error: "Provider not found" });
      }
      logConfigChange("config.provider.delete", { providerId: request.params.id, action: "clearKey" });
      return { success: true };
    }
  );

  // ── POST /api/models/providers/:id/test ─────────────────────
  app.post<{ Params: { id: string }; Body: { model?: string; apiKey?: string; baseUrl?: string } }>(
    "/api/models/providers/:id/test",
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body as any;
      const providerDef = getProviderById(id);
      const record = ctx.providerStore.get(id);

      if (!providerDef) {
        return reply.status(404).send({ error: "Unknown provider" });
      }

      // Accept apiKey from request body (for testing before saving) or from DB
      const apiKey = body?.apiKey || record?.apiKey;
      if (!apiKey) {
        return reply.status(400).send({ error: "API Key not configured" });
      }

      const modelId = body?.model || record?.selectedModel || (providerDef.models[0]?.id ?? "");
      if (!modelId) {
        return reply.status(400).send({ error: "No model specified" });
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

        return {
          success: true,
          model: modelId,
          response: result.content?.slice(0, 100) ?? "",
          usage: result.usage,
        };
      } catch (err: any) {
        return reply.status(502).send({
          success: false,
          error: err.message || "Connection failed",
        });
      }
    }
  );
}
