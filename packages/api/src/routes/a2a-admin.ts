/**
 * Task 4.2 — A2A 管理 REST 端点
 *
 * 为前端 A2A 管理页面提供数据源（包装 A2A 内部 JSON-RPC 功能为 REST）。
 *
 *   GET  /api/a2a/registry     — 已注册的远端 Agent 列表
 *   GET  /api/a2a/tasks        — A2A Task 列表（状态/分页）
 *   GET  /api/a2a/card         — 本机 Agent Card
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export async function a2aAdminRoutes(app: FastifyInstance, ctx: AppContext) {

  // ─── GET /api/a2a/registry — 远端 Agent 注册表 ─────────────

  app.get("/api/a2a/registry", async (req, reply) => {
    if (!ctx.a2aRegistry) {
      return reply.send({ agents: [], enabled: false });
    }
    try {
      const query = req.query as { capability?: string; onlineOnly?: string };
      const agents = await ctx.a2aRegistry.discover({
        capability: query.capability,
        onlineOnly: query.onlineOnly === "true",
      });
      return reply.send({ agents, enabled: true });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message ?? "Registry query failed" });
    }
  });

  // ─── GET /api/a2a/tasks — A2A Task 列表 ────────────────────

  app.get("/api/a2a/tasks", async (req, reply) => {
    if (!ctx.a2aTaskStore) {
      return reply.send({ tasks: [], enabled: false });
    }
    const query = req.query as { state?: string; limit?: string; offset?: string };
    const tasks = ctx.a2aTaskStore.listTasks({
      state: query.state as any,
      limit: Math.min(parseInt(query.limit ?? "50", 10), 200),
      offset: parseInt(query.offset ?? "0", 10),
    });
    return reply.send({ tasks, enabled: true });
  });

  // ─── GET /api/a2a/card — 本机 Agent Card ───────────────────

  app.get("/api/a2a/card", async (_req, reply) => {
    // 代理到 well-known 端点的数据（避免前端跨域问题）
    try {
      const defaultAgentId = ctx.router.getDefaultAgentId();
      const defaultRuntime = defaultAgentId ? ctx.agentManager.getAgent(defaultAgentId) : undefined;
      const agentName = (defaultRuntime as any)?.config?.name || "Super Agent";
      const agentDesc = (defaultRuntime as any)?.config?.description || "AI Agent Platform";
      const skills = (ctx.skillLoader?.listSkills() || []).map((s: any) => ({
        id: s.id || s.name,
        name: s.name,
        description: s.description || "",
        tags: s.tags || [],
      }));
      return reply.send({
        name: agentName,
        description: agentDesc,
        skills,
        capabilities: {
          streaming: true,
          pushNotifications: !!ctx.a2aPushDispatcher,
        },
        a2aEnabled: process.env.ENABLE_A2A === "true",
      });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  app.log.info("A2A admin routes registered (/api/a2a/registry, /api/a2a/tasks, /api/a2a/card)");
}
