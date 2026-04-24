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
import { AgentConfigSchema, saveAgentConfig, deleteAgentConfig, logConfigChange, sanitizeForAudit } from "@super-agent/core";
import type { AppContext } from "../context.js";

export async function agentRoutes(app: FastifyInstance, ctx: AppContext) {
  // P1-2: List agents — 支持 type/department/分页 查询参数
  app.get<{
    Querystring: {
      type?: "builtin" | "custom" | "all";
      department?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/agents", async (request) => {
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

    return { agents, total, limit: parsedLimit, offset: parsedOffset };
  });

  // Create a new agent
  app.post("/api/agents", async (request, reply) => {
    const parsed = AgentConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid agent configuration",
        details: parsed.error.flatten(),
      });
    }

    const agent = ctx.agentManager.createAgent(parsed.data);
    // Persist to SQLite so the agent survives restarts
    saveAgentConfig(agent.id, agent.config);
    logConfigChange("config.agent.create", sanitizeForAudit({ agentId: agent.id, config: agent.config }), agent.id);
    return reply.status(201).send({ agent: agent.state });
  });

  // Get agent by ID
  app.get<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    const agent = ctx.agentManager.getAgent(request.params.id);
    if (!agent) {
      return reply.status(404).send({ error: "Agent not found" });
    }
    return { agent: agent.state };
  });

  // Update agent（P0-1: 内置 Agent 禁止通过 API 直接修改）
  app.put<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    // P0-1: 先检查目标 Agent 是否为内置专家，防止绕过前端直接修改
    const target = ctx.agentManager.getAgent(request.params.id);
    if (!target) {
      return reply.status(404).send({ error: "Agent not found" });
    }
    const targetMeta = (target.config as Record<string, unknown>)?.metadata as Record<string, unknown> | undefined;
    if (targetMeta?.isBuiltin) {
      return reply.status(403).send({ error: "内置专家 Agent 不可直接修改，请 Fork 后编辑" });
    }

    const parsed = AgentConfigSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid update data",
        details: parsed.error.flatten(),
      });
    }
    const agent = ctx.agentManager.updateAgent(
      request.params.id,
      parsed.data as Record<string, unknown>
    );
    if (!agent) {
      return reply.status(404).send({ error: "Agent not found" });
    }
    // Persist updated config to SQLite
    saveAgentConfig(agent.id, agent.config);
    logConfigChange("config.agent.update", sanitizeForAudit({ agentId: agent.id, updates: parsed.data }), agent.id);
    return { agent: agent.state };
  });

  // Delete agent（内置 Agent 禁止删除）
  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    // v3: 内置专家 Agent 不可删除
    const agent = ctx.agentManager.getAgent(request.params.id);
    if (!agent) {
      return reply.status(404).send({ error: "Agent not found" });
    }
    const meta = (agent.config as Record<string, unknown>)?.metadata as Record<string, unknown> | undefined;
    if (meta?.isBuiltin) {
      return reply.status(403).send({ error: "内置专家 Agent 不可删除，可使用 Fork 创建自定义副本" });
    }

    const deleted = ctx.agentManager.deleteAgent(request.params.id);
    if (!deleted) {
      return reply.status(404).send({ error: "Agent not found" });
    }
    // Remove from SQLite
    deleteAgentConfig(request.params.id);
    logConfigChange("config.agent.delete", { agentId: request.params.id });
    return { success: true };
  });

  // Fork agent — 复制内置 Agent 为用户自定义副本
  // P0-4: 增加字段安全提取和 createAgent+saveAgentConfig 原子性回滚
  app.post<{ Params: { id: string } }>("/api/agents/:id/fork", async (request, reply) => {
    const source = ctx.agentManager.getAgent(request.params.id);
    if (!source) {
      return reply.status(404).send({ error: "Agent not found" });
    }

    const sourceConfig = source.config as Record<string, unknown>;
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
      return reply.status(500).send({ error: "Fork 创建失败" });
    }

    try {
      saveAgentConfig(forked.id, forked.config);
    } catch (err) {
      // 持久化失败，回滚内存中的 Agent
      app.log.error({ forkedId: forked.id, err }, "Fork saveAgentConfig failed, rolling back");
      ctx.agentManager.deleteAgent(forked.id);
      return reply.status(500).send({ error: "Fork 持久化失败，已回滚" });
    }

    logConfigChange("config.agent.fork", sanitizeForAudit({ sourceId: source.id, forkedId: forked.id }), forked.id);
    return reply.status(201).send({ agent: forked.state });
  });

  // P2-4: 查询某个 Agent 的所有 Fork 副本
  app.get<{ Params: { id: string } }>("/api/agents/:id/forks", async (request, reply) => {
    const sourceId = request.params.id;
    const source = ctx.agentManager.getAgent(sourceId);
    if (!source) {
      return reply.status(404).send({ error: "Agent not found" });
    }

    // 遍历所有 Agent，找到 metadata.forkedFrom === sourceId 的
    const forks = ctx.agentManager.listAgents().filter(a => {
      const meta = (a as any).config?.metadata;
      return meta?.forkedFrom === sourceId;
    });

    return { forks, count: forks.length };
  });
}
