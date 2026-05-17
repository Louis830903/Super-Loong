/**
 * a2a-admin.test.ts — A2A 管理端点集成测试
 *
 * 覆盖端点:
 *   GET /api/a2a/registry — 已注册远端 Agent 列表
 *   GET /api/a2a/tasks    — A2A Task 列表
 *   GET /api/a2a/card     — 本机 Agent Card
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { a2aAdminRoutes } from "../routes/a2a-admin.js";
import { buildApp } from "./test-helpers.js";
import type { AppContext } from "../context.js";

describe("A2A 管理路由", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = {
      a2aRegistry: {
        discover: vi.fn().mockResolvedValue([
          { id: "agent-1", name: "Remote Agent", capabilities: ["chat"] },
        ]),
      },
      a2aTaskStore: {
        listTasks: vi.fn().mockReturnValue([
          { id: "task-1", state: "completed", title: "Test Task" },
        ]),
      },
      a2aPushDispatcher: { active: true },
      router: { getDefaultAgentId: () => "default-agent" },
      agentManager: {
        getAgent: vi.fn().mockReturnValue({
          config: { name: "Super Agent", description: "AI Platform" },
        }),
      },
      skillLoader: {
        listSkills: vi.fn().mockReturnValue([
          { id: "skill-1", name: "Code Review", description: "Review code", tags: ["dev"] },
        ]),
      },
    } as unknown as AppContext;
  });

  // ── GET /api/a2a/registry ────────────────────────────────

  it("GET /registry 返回远端 Agent 列表", async () => {
    const app = await buildApp(a2aAdminRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/a2a/registry" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.enabled).toBe(true);
    expect(body.data.agents).toHaveLength(1);
    expect(body.data.agents[0].name).toBe("Remote Agent");
  });

  it("GET /registry 无 a2aRegistry 时返回空列表", async () => {
    const noRegistryCtx = { ...ctx, a2aRegistry: undefined } as unknown as AppContext;
    const app = await buildApp(a2aAdminRoutes, noRegistryCtx);
    const res = await app.inject({ method: "GET", url: "/api/a2a/registry" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.enabled).toBe(false);
    expect(body.data.agents).toEqual([]);
  });

  it("GET /registry discover 异常返回 500", async () => {
    const brokenCtx = {
      ...ctx,
      a2aRegistry: { discover: vi.fn().mockRejectedValue(new Error("down")) },
    } as unknown as AppContext;
    const app = await buildApp(a2aAdminRoutes, brokenCtx);
    const res = await app.inject({ method: "GET", url: "/api/a2a/registry" });
    expect(res.statusCode).toBe(500);
  });

  // ── GET /api/a2a/tasks ──────────────────────────────────

  it("GET /tasks 返回 Task 列表", async () => {
    const app = await buildApp(a2aAdminRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/a2a/tasks" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.tasks).toHaveLength(1);
    expect(body.data.tasks[0].state).toBe("completed");
  });

  it("GET /tasks 无 a2aTaskStore 时返回空列表", async () => {
    const noCtx = { ...ctx, a2aTaskStore: undefined } as unknown as AppContext;
    const app = await buildApp(a2aAdminRoutes, noCtx);
    const res = await app.inject({ method: "GET", url: "/api/a2a/tasks" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.tasks).toEqual([]);
  });

  it("GET /tasks 支持 limit/offset/state 查询参数", async () => {
    const app = await buildApp(a2aAdminRoutes, ctx);
    const res = await app.inject({
      method: "GET",
      url: "/api/a2a/tasks?state=completed&limit=10&offset=5",
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.a2aTaskStore!.listTasks).toHaveBeenCalledWith({
      state: "completed", limit: 10, offset: 5,
    });
  });

  // ── GET /api/a2a/card ───────────────────────────────────

  it("GET /card 返回本机 Agent Card", async () => {
    const app = await buildApp(a2aAdminRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/a2a/card" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.name).toBe("Super Agent");
    expect(body.data.skills).toHaveLength(1);
    expect(body.data.capabilities.streaming).toBe(true);
  });

  it("GET /card 无默认 Agent 时使用默认名称", async () => {
    const noAgentCtx = {
      ...ctx,
      router: { getDefaultAgentId: () => null },
    } as unknown as AppContext;
    const app = await buildApp(a2aAdminRoutes, noAgentCtx);
    const res = await app.inject({ method: "GET", url: "/api/a2a/card" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.name).toBe("Super Agent");
  });

  it("GET /card 无 skillLoader 时返回空技能列表", async () => {
    const noSkillCtx = {
      ...ctx,
      skillLoader: undefined,
    } as unknown as AppContext;
    const app = await buildApp(a2aAdminRoutes, noSkillCtx);
    const res = await app.inject({ method: "GET", url: "/api/a2a/card" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.skills).toEqual([]);
  });
});
