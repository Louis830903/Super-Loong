/**
 * agents.test.ts — Agent管理路由集成测试
 *
 * 覆盖端点:
 *   GET    /api/agents              — 列表（含 type/department/分页）
 *   POST   /api/agents              — 创建
 *   GET    /api/agents/:id          — 详情
 *   PUT    /api/agents/:id          — 更新（内置禁止 → 403）
 *   DELETE /api/agents/:id          — 删除（内置禁止 → 403）
 *   POST   /api/agents/:id/fork     — Fork
 *   GET    /api/agents/:id/forks    — 查询 Fork 副本
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppContext } from "../context.js";
import { agentRoutes } from "../routes/agents.js";
import { buildApp, MockAgentManager } from "./test-helpers.js";

// Mock @super-agent/core 持久化与安全函数
const { mockSaveConfig, mockDeleteConfig, mockLogChange, mockSanitizeForAudit,
  mockGetProviderById, mockGetModelById, mockSanitizeState, mockSanitizeStates,
  mockMaskApiKey, mockIsMasked } = vi.hoisted(() => ({
  mockSaveConfig: vi.fn(() => {}),
  mockDeleteConfig: vi.fn(() => {}),
  mockLogChange: vi.fn(() => {}),
  mockSanitizeForAudit: vi.fn((data: any) => data),
  mockGetProviderById: vi.fn(() => null),
  mockGetModelById: vi.fn(() => null),
  mockSanitizeState: vi.fn((s: any) => ({ ...s, config: { ...s.config, llmProvider: { type: "openai", model: "gpt-4o-mini" } } })),
  mockSanitizeStates: vi.fn((arr: any[]) => arr.map((s: any) => ({ ...s, config: { ...s.config, llmProvider: { type: "openai", model: "gpt-4o-mini" } } }))),
  mockMaskApiKey: vi.fn((key: string) => key ? "sk-***masked" : ""),
  mockIsMasked: vi.fn(() => false),
}));

vi.mock("@super-agent/core", () => ({
  saveAgentConfig: mockSaveConfig,
  deleteAgentConfig: mockDeleteConfig,
  logConfigChange: mockLogChange,
  sanitizeForAudit: mockSanitizeForAudit,
  getProviderById: mockGetProviderById,
  getModelById: mockGetModelById,
  sanitizeAgentState: mockSanitizeState,
  sanitizeAgentStates: mockSanitizeStates,
  maskApiKey: mockMaskApiKey,
  isMaskedApiKey: mockIsMasked,
  AgentConfigSchema: {
    safeParse: vi.fn((data: any) => {
      if (!data.name && !data.id) return {
        success: false,
        error: { issues: [{ message: "name is required" }], flatten: () => ({ fieldErrors: {} }) },
      };
      return { success: true, data: { ...data, id: data.id ?? `agent-${Date.now()}` } };
    }),
    partial: () => ({
      safeParse: vi.fn((data: any) => {
        if (data && typeof data === "object") return { success: true, data };
        return { success: false, error: { issues: [{ message: "Invalid" }], flatten: () => ({}) } };
      }),
    }),
  },
}));

describe("Agent管理路由", () => {
  let mgr: MockAgentManager;
  let ctx: Partial<AppContext>;

  beforeEach(() => {
    mgr = new MockAgentManager();
    vi.clearAllMocks();
    ctx = {
      agentManager: mgr as any,
      providerStore: { get: vi.fn(() => null) } as any,
    } as unknown as Partial<AppContext>;
  });

  // ── GET /api/agents ────────────────────────────────────

  it("GET /agents 空列表", async () => {
    const app = await buildApp(agentRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/agents" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.agents).toEqual([]);
    expect(body.data.total).toBe(0);
  });

  it("GET /agents 返回列表含分页", async () => {
    mgr.addAgent({ name: "Agent1", systemPrompt: "hello" });
    mgr.addAgent({ name: "Agent2", systemPrompt: "world" });
    const app = await buildApp(agentRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET", url: "/api/agents?limit=1&offset=0",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.total).toBe(2);
    expect(body.data.agents).toHaveLength(1);
  });

  it("GET /agents 支持 type=builtin 过滤", async () => {
    mgr.addAgent({ name: "Builtin", metadata: { isBuiltin: true } });
    mgr.addAgent({ name: "Custom", metadata: {} });
    const app = await buildApp(agentRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET", url: "/api/agents?type=builtin",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.total).toBe(1);
  });

  it("GET /agents 支持 type=custom 过滤", async () => {
    mgr.addAgent({ name: "Builtin", metadata: { isBuiltin: true } });
    mgr.addAgent({ name: "Custom", metadata: {} });
    const app = await buildApp(agentRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET", url: "/api/agents?type=custom",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.total).toBe(1);
  });

  // ── POST /api/agents ───────────────────────────────────

  it("POST /agents 创建成功", async () => {
    const app = await buildApp(agentRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/agents",
      payload: { name: "NewAgent", systemPrompt: "test" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.agent).toBeDefined();
    expect(mockSaveConfig).toHaveBeenCalled();
  });

  // ── GET /api/agents/:id ────────────────────────────────

  it("GET /agents/:id 存在返回详情", async () => {
    const created = mgr.addAgent({ name: "DetailAgent" });
    const app = await buildApp(agentRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: `/api/agents/${created.id}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.agent.id).toBe(created.id);
  });

  it("GET /agents/:id 不存在返回 404", async () => {
    const app = await buildApp(agentRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/agents/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  // ── PUT /api/agents/:id ────────────────────────────────

  it("PUT /agents/:id 内置 Agent 不可修改返回 403", async () => {
    const builtin = mgr.addAgent({ name: "Builtin", metadata: { isBuiltin: true } });
    const app = await buildApp(agentRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "PUT", url: `/api/agents/${builtin.id}`,
      payload: { name: "hacked" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("PUT /agents/:id 不存在返回 404", async () => {
    const app = await buildApp(agentRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "PUT", url: "/api/agents/nonexistent",
      payload: { name: "nope" },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── DELETE /api/agents/:id ─────────────────────────────

  it("DELETE /agents/:id 内置 Agent 不可删除返回 403", async () => {
    const builtin = mgr.addAgent({ name: "Builtin", metadata: { isBuiltin: true } });
    const app = await buildApp(agentRoutes, ctx as AppContext);
    const res = await app.inject({ method: "DELETE", url: `/api/agents/${builtin.id}` });
    expect(res.statusCode).toBe(403);
  });

  it("DELETE /agents/:id 不存在返回 404", async () => {
    const app = await buildApp(agentRoutes, ctx as AppContext);
    const res = await app.inject({ method: "DELETE", url: "/api/agents/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  // ── Fork ───────────────────────────────────────────────

  it("POST /agents/:id/fork 不存在返回 404", async () => {
    const app = await buildApp(agentRoutes, ctx as AppContext);
    const res = await app.inject({ method: "POST", url: "/api/agents/nonexistent/fork" });
    expect(res.statusCode).toBe(404);
  });

  it("POST /agents/:id/fork Fork 成功", async () => {
    const source = mgr.addAgent({ name: "Template", systemPrompt: "base", metadata: { isBuiltin: true } });
    const app = await buildApp(agentRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: `/api/agents/${source.id}/fork`,
    });
    // Fork 创建成功（调用 createAgent→saveAgentConfig→logConfigChange）
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.agent).toBeDefined();
    expect(body.data.agent.config.metadata.isBuiltin).toBe(false);
  });

  // ── GET /api/agents/:id/forks ──────────────────────────

  it("GET /agents/:id/forks 不存在返回 404", async () => {
    const app = await buildApp(agentRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/agents/nonexistent/forks" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /agents/:id/forks 返回 Fork 列表", async () => {
    const source = mgr.addAgent({ name: "Father", metadata: { isBuiltin: true } });
    // 手动创建一个标记 forkedFrom 的 Agent
    mgr.addAgent({ name: "Child", metadata: { forkedFrom: source.id } });
    const app = await buildApp(agentRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: `/api/agents/${source.id}/forks` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.forks).toHaveLength(1);
    expect(body.data.count).toBe(1);
  });
});
