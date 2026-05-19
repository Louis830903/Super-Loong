/**
 * Agent Routes — CRUD operations for agent management.
 *
 * GET    /api/agents          — List all agents
 * POST   /api/agents          — Create a new agent
 * GET    /api/agents/:id      — Get agent details
 * PUT    /api/agents/:id      — Update an agent
 * DELETE /api/agents/:id      — Delete an agent
 */

import type { FastifyInstance } from "fastify";
import { sendSuccess, Errors } from "./response-helper.js";
import {
  AgentConfigSchema,
  saveAgentConfig,
  deleteAgentConfig,
  logConfigChange,
  sanitizeForAudit,
  getProviderById,
  getModelById,
  sanitizeAgentState,
  sanitizeAgentStates,
  maskApiKey,
  isMaskedApiKey,
} from "@super-agent/core";
import type { AppContext } from "../context.js";

/**
 * 按 providerId 从 providerStore + 模型目录合并 llmProvider 配置。
 *
 * 前端只携带 { type, providerId, model } 的骨架，apiKey / baseUrl / supportsReasoning
 * 由后端根据 providerId 查库 + 查目录自动补齐，避免 API Key 明文暴露给前端。
 *
 * 逻辑对齐 models.ts PUT /api/models/providers/:id 里同步 defaultAgent 的那段
 * （L93-101），保证"设置页"与"Agent 管理页"两条入口的合并规则一致。
 *
 * 请求体中显式提供的字段（apiKey/baseUrl/temperature/maxTokens）保持优先，
 * 方便高级用户针对单个 Agent 覆盖默认配置。
 */
function mergeLLMProviderConfig(
  llm: Record<string, unknown> | undefined,
  ctx: AppContext,
): Record<string, unknown> | undefined {
  if (!llm || typeof llm !== "object") return llm;
  const providerId = typeof llm.providerId === "string" ? llm.providerId : undefined;
  if (!providerId) return llm; // 官方 type（openai/anthropic/ollama/custom）无需合并

  const providerDef = getProviderById(providerId);
  if (!providerDef) return llm; // 未知 providerId 交由后续 schema 校验或运行时报错

  const record = ctx.providerStore.get(providerId);
  const model = typeof llm.model === "string" && llm.model ? llm.model : record?.selectedModel;
  const modelDef = model ? getModelById(providerId, model) : undefined;

  // SEC-P0-04 · E1 脱敏哨兵：前端 GET 到掩码 apiKey，若整体回传会污染 DB。
  // 规则：incoming 非空且不是脱敏串，才视为用户新填；否则回退 record 原 key。
  const recordKeyMasked = record?.apiKey ? maskApiKey(record.apiKey) : undefined;
  const incomingApiKeyRaw = typeof llm.apiKey === "string" ? llm.apiKey : "";
  const incomingApiKey =
    incomingApiKeyRaw && !isMaskedApiKey(incomingApiKeyRaw, recordKeyMasked)
      ? incomingApiKeyRaw
      : undefined;

  const merged: Record<string, unknown> = {
    type: typeof llm.type === "string" ? llm.type : "openai",
    model,
    // apiKey / baseUrl 用 || 而非 ??，与 models.ts L91 的 `record.baseUrl || providerDef.baseUrl`
    // 保持一致，避免 providerStore 里存了空串（非 null/undefined）时跳不过 fallback 导致
    // schema 的 z.string().url() 校验失败（"Invalid url"）。
    apiKey: incomingApiKey || record?.apiKey || undefined,
    baseUrl: (typeof llm.baseUrl === "string" && llm.baseUrl) || record?.baseUrl || providerDef.baseUrl,
    providerId,
    supportsReasoning:
      typeof llm.supportsReasoning === "boolean"
        ? llm.supportsReasoning
        : modelDef?.supportsReasoning ?? false,
  };

  // temperature：请求体优先 → 模型固定温度 → 不设置（走 LLMProvider 默认）
  if (llm.temperature !== undefined) {
    merged.temperature = llm.temperature;
  } else if (modelDef?.fixedTemperature !== undefined) {
    merged.temperature = modelDef.fixedTemperature;
  }
  if (llm.maxTokens !== undefined) {
    merged.maxTokens = llm.maxTokens;
  }

  return merged;
}

export async function agentRoutes(app: FastifyInstance, ctx: AppContext) {
  // P1-2: List agents — 支持 type/department/分页 查询参数
  app.get<{
    Querystring: {
      type?: "builtin" | "custom" | "all";
      department?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/agents", async (request, reply) => {
    let agents = ctx.agentManager.listAgents();

    const { type, department, limit, offset } = request.query;

    // 按类型筛选
    if (type === "builtin") {
      agents = agents.filter(a => {
        const meta = (a as any).config?.metadata;
        return meta?.isBuiltin === true;
      });
    } else if (type === "custom") {
      agents = agents.filter(a => {
        const meta = (a as any).config?.metadata;
        return !meta?.isBuiltin;
      });
    }

    // 按部门筛选
    if (department) {
      agents = agents.filter(a => {
        const meta = (a as any).config?.metadata;
        return meta?.department === department;
      });
    }

    const total = agents.length;

    // 分页
    const parsedLimit = limit ? Math.min(parseInt(limit, 10) || 50, 200) : undefined;
    const parsedOffset = offset ? parseInt(offset, 10) || 0 : 0;
    if (parsedLimit !== undefined) {
      agents = agents.slice(parsedOffset, parsedOffset + parsedLimit);
    }

    return sendSuccess(reply, {
      // SEC-P0-04：列表响应走逐项 sanitize，彻底屏蔽 apiKey 原文。
      // listAgents() 返回 AgentState[]（而非 AgentRuntime[]），所以直接 map 脱敏。
      agents: sanitizeAgentStates(agents),
      total,
      limit: parsedLimit,
      offset: parsedOffset,
    });
  });

  // Create a new agent
  app.post("/api/agents", async (request, reply) => {
    // 先按 providerId 合并 apiKey/baseUrl/supportsReasoning，再交给 schema 校验。
    // 前端（Agent 管理页）只发 { type:"openai", providerId, model } 骨架，
    // apiKey/baseUrl 由后端从 providerStore + 模型目录补齐。
    const rawBody = (request.body ?? {}) as Record<string, unknown>;
    const merged = {
      ...rawBody,
      llmProvider: mergeLLMProviderConfig(
        rawBody.llmProvider as Record<string, unknown> | undefined,
        ctx,
      ),
    };
    const parsed = AgentConfigSchema.safeParse(merged);
    if (!parsed.success) {
      return Errors.badRequest(reply, "Invalid agent configuration");
    }

    const agent = ctx.agentManager.createAgent(parsed.data);
    // Persist to SQLite so the agent survives restarts
    saveAgentConfig(agent.id, agent.config as unknown as Record<string, unknown>);
    logConfigChange("config.agent.create", sanitizeForAudit({ agentId: agent.id, config: agent.config as unknown as Record<string, unknown> }), agent.id);
    // SEC-P0-04：响应前脱敏，审计日志仍传原始 config（走 sanitizeForAudit）。
    return sendSuccess(reply, { agent: sanitizeAgentState(agent.state) });
  });

  // Get agent by ID
  app.get<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    const agent = ctx.agentManager.getAgent(request.params.id);
    if (!agent) {
      return Errors.notFound(reply, "Agent not found");
    }
    // SEC-P0-04：响应前脱敏。
    return sendSuccess(reply, { agent: sanitizeAgentState(agent.state) });
  });

  // Update agent（P0-1: 内置 Agent 禁止通过 API 直接修改）
  app.put<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    // P0-1: 先检查目标 Agent 是否为内置专家，防止绕过前端直接修改
    const target = ctx.agentManager.getAgent(request.params.id);
    if (!target) {
      return Errors.notFound(reply, "Agent not found");
    }
    const targetMeta = (target.config as unknown as Record<string, unknown>)?.metadata as Record<string, unknown> | undefined;
    if (targetMeta?.isBuiltin) {
      return Errors.builtinAgentImmutable(reply, "内置专家 Agent 不可直接修改，请 Fork 后编辑");
    }

    const parsed = AgentConfigSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      return Errors.badRequest(reply, "Invalid update data");
    }
    // 若本次 PUT 涉及 llmProvider，按 providerId 做同样的合并（与 POST 对齐）。
    const patch = { ...parsed.data } as Record<string, unknown>;
    if (patch.llmProvider !== undefined) {
      patch.llmProvider = mergeLLMProviderConfig(
        patch.llmProvider as Record<string, unknown> | undefined,
        ctx,
      );
    }
    const agent = ctx.agentManager.updateAgent(
      request.params.id,
      patch,
    );
    if (!agent) {
      return Errors.notFound(reply, "Agent not found");
    }
    // Persist updated config to SQLite
    saveAgentConfig(agent.id, agent.config as unknown as Record<string, unknown>);
    logConfigChange("config.agent.update", sanitizeForAudit({ agentId: agent.id, updates: patch }), agent.id);
    // SEC-P0-04：响应前脱敏。
    return sendSuccess(reply, { agent: sanitizeAgentState(agent.state) });
  });

  // Delete agent（内置 Agent 禁止删除）
  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    // v3: 内置专家 Agent 不可删除
    const agent = ctx.agentManager.getAgent(request.params.id);
    if (!agent) {
      return Errors.notFound(reply, "Agent not found");
    }
    const meta = (agent.config as unknown as Record<string, unknown>)?.metadata as Record<string, unknown> | undefined;
    if (meta?.isBuiltin) {
      return Errors.builtinAgentImmutable(reply, "内置专家 Agent 不可删除，可使用 Fork 创建自定义副本");
    }

    const deleted = ctx.agentManager.deleteAgent(request.params.id);
    if (!deleted) {
      return Errors.notFound(reply, "Agent not found");
    }
    // Remove from SQLite
    deleteAgentConfig(request.params.id);
    logConfigChange("config.agent.delete", { agentId: request.params.id });
    return sendSuccess(reply, { success: true });
  });

  // Fork agent — 复制内置 Agent 为用户自定义副本
  // P0-4: 增加字段安全提取和 createAgent+saveAgentConfig 原子性回滚
  app.post<{ Params: { id: string } }>("/api/agents/:id/fork", async (request, reply) => {
    const source = ctx.agentManager.getAgent(request.params.id);
    if (!source) {
      return Errors.notFound(reply, "Agent not found");
    }

    const sourceConfig = source.config as unknown as Record<string, unknown>;
    const sourceMeta = (sourceConfig.metadata as Record<string, unknown>) || {};

    // P0-4: 安全提取字段，对缺失字段使用合理默认值
    const forkedConfig = {
      name: `${String(sourceConfig.name || "Agent")} (自定义)`,
      description: String(sourceConfig.description || ""),
      systemPrompt: String(sourceConfig.systemPrompt || "You are a helpful AI assistant."),
      llmProvider: sourceConfig.llmProvider ?? { type: "openai", model: "gpt-4o-mini" },
      tools: Array.isArray(sourceConfig.tools) ? [...sourceConfig.tools] : [],
      skills: Array.isArray(sourceConfig.skills) ? [...sourceConfig.skills] : [],
      channels: Array.isArray(sourceConfig.channels) ? [...sourceConfig.channels] : [],
      memoryEnabled: sourceConfig.memoryEnabled !== false,
      maxToolIterations: typeof sourceConfig.maxToolIterations === "number" ? sourceConfig.maxToolIterations : 25,
      metadata: {
        ...sourceMeta,
        isBuiltin: false,             // Fork 版本非内置
        forkedFrom: source.id,        // 记录来源
      },
    };

    // P0-4: createAgent + saveAgentConfig 原子性操作，失败时回滚
    let forked: ReturnType<typeof ctx.agentManager.createAgent>;
    try {
      forked = ctx.agentManager.createAgent(forkedConfig as unknown as Parameters<typeof ctx.agentManager.createAgent>[0]);
    } catch (err) {
      app.log.error({ sourceId: source.id, err }, "Fork createAgent failed");
      return Errors.internal(reply, "Fork 创建失败");
    }

    try {
      saveAgentConfig(forked.id, forked.config as unknown as Record<string, unknown>);
    } catch (err) {
      // 持久化失败，回滚内存中的 Agent
      app.log.error({ forkedId: forked.id, err }, "Fork saveAgentConfig failed, rolling back");
      ctx.agentManager.deleteAgent(forked.id);
      return Errors.internal(reply, "Fork 持久化失败，已回滚");
    }

    logConfigChange("config.agent.fork", sanitizeForAudit({ sourceId: source.id, forkedId: forked.id }), forked.id);
    // SEC-P0-04：响应前脱敏。
    return sendSuccess(reply, { agent: sanitizeAgentState(forked.state) });
  });

  // P2-4: 查询某个 Agent 的所有 Fork 副本
  app.get<{ Params: { id: string } }>("/api/agents/:id/forks", async (request, reply) => {
    const sourceId = request.params.id;
    const source = ctx.agentManager.getAgent(sourceId);
    if (!source) {
      return Errors.notFound(reply, "Agent not found");
    }

    // 遍历所有 Agent，找到 metadata.forkedFrom === sourceId 的
    const forks = ctx.agentManager.listAgents().filter(a => {
      const meta = (a as any).config?.metadata;
      return meta?.forkedFrom === sourceId;
    });

    return sendSuccess(reply, { forks, count: forks.length });
  });
}
