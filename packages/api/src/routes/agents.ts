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
  // List all agents
  app.get("/api/agents", async () => {
    return { agents: ctx.agentManager.listAgents() };
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

  // Update agent
  app.put<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
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

  // Delete agent
  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    const deleted = ctx.agentManager.deleteAgent(request.params.id);
    if (!deleted) {
      return reply.status(404).send({ error: "Agent not found" });
    }
    // Remove from SQLite
    deleteAgentConfig(request.params.id);
    logConfigChange("config.agent.delete", { agentId: request.params.id });
    return { success: true };
  });
}
