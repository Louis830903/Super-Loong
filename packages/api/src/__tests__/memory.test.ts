/**
 * memory.test.ts — 记忆路由集成测试
 *
 * 覆盖端点:
 *   GET    /api/memory                  — 列出（含过滤）
 *   POST   /api/memory                  — 创建
 *   GET    /api/memory/search           — 语义搜索
 *   GET    /api/memory/stats            — 统计
 *   GET    /api/memory/:id              — 查询单条
 *   PUT    /api/memory/:id              — 更新
 *   DELETE /api/memory/:id              — 删除
 *   DELETE /api/memory                  — 批量清除
 *   GET    /api/memory/core/:agentId    — Core 块列表
 *   GET    /api/memory/core/:agentId/:label — 读取 Core 块
 *   PUT    /api/memory/core/:agentId/:label — 替换 Core 块
 *   POST   /api/memory/core/:agentId/:label/append — 追加
 *   GET    /api/memory/fts              — FTS 全文本搜索
 *   GET    /api/memory/contradictions   — 矛盾检测
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppContext } from "../context.js";
import { memoryRoutes } from "../routes/memory.js";
import { buildApp, MockMemoryManager } from "./test-helpers.js";

// Mock searchMemoriesFTS from @super-agent/core
vi.mock("@super-agent/core", () => ({
  searchMemoriesFTS: vi.fn((_q: string, _opts?: any) => []),
}));

describe("记忆路由", () => {
  let memMgr: MockMemoryManager;
  let ctx: Partial<AppContext>;

  beforeEach(() => {
    memMgr = new MockMemoryManager();
    ctx = { memoryManager: memMgr as any } as unknown as Partial<AppContext>;
  });

  // ── 无 memoryManager 时路由不注册 ───────────────────────

  it("无 memoryManager 时所有路由 404", async () => {
    const app = await buildApp(memoryRoutes, {} as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/memory" });
    expect(res.statusCode).toBe(404);
  });

  // ── POST /api/memory ───────────────────────────────────

  it("POST /memory 缺 agentId 返回 400", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/memory",
      payload: { content: "test" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /memory 缺 content 返回 400", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/memory",
      payload: { agentId: "agent-1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /memory 创建成功返回 201", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/memory",
      payload: { agentId: "agent-1", content: "一段回忆" },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data.id).toBe("mem-1");
  });

  // ── GET /api/memory ────────────────────────────────────

  it("GET /memory 列出记忆（空列表）", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/memory" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.memories).toEqual([]);
    expect(body.data.total).toBe(0);
  });

  it("GET /memory 创建后列表含记忆", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    await app.inject({
      method: "POST", url: "/api/memory",
      payload: { agentId: "a1", content: "hello" },
    });
    const res = await app.inject({ method: "GET", url: "/api/memory" });
    expect(JSON.parse(res.body).data.total).toBe(1);
  });

  // ── GET /api/memory/search ─────────────────────────────

  it("GET /memory/search 缺 query 返回 400", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/memory/search" });
    expect(res.statusCode).toBe(400);
  });

  it("GET /memory/search 返回搜索结果", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET", url: "/api/memory/search?query=test",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.results).toHaveLength(1);
  });

  // ── GET /api/memory/stats ──────────────────────────────

  it("GET /memory/stats 返回统计", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/memory/stats" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.total).toBe(0);
  });

  // ── GET /api/memory/:id ────────────────────────────────

  it("GET /memory/:id 存在时返回详情", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const create = await app.inject({
      method: "POST", url: "/api/memory",
      payload: { agentId: "a1", content: "detail" },
    });
    const id = JSON.parse(create.body).data.id;
    const res = await app.inject({ method: "GET", url: `/api/memory/${id}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.content).toBe("detail");
  });

  it("GET /memory/:id 不存在返回 404", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/memory/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  // ── PUT /api/memory/:id ────────────────────────────────

  it("PUT /memory/:id 缺 content 返回 400", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "PUT", url: "/api/memory/mem-1",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /memory/:id 更新成功", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const create = await app.inject({
      method: "POST", url: "/api/memory",
      payload: { agentId: "a1", content: "old" },
    });
    const id = JSON.parse(create.body).data.id;
    const res = await app.inject({
      method: "PUT", url: `/api/memory/${id}`,
      payload: { content: "updated" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.status).toBe("updated");
  });

  // ── DELETE /api/memory/:id ─────────────────────────────

  it("DELETE /memory/:id 删除成功", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const create = await app.inject({
      method: "POST", url: "/api/memory",
      payload: { agentId: "a1", content: "tmp" },
    });
    const id = JSON.parse(create.body).data.id;
    const res = await app.inject({ method: "DELETE", url: `/api/memory/${id}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.status).toBe("deleted");
  });

  it("DELETE /memory/:id 不存在返回 404", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({ method: "DELETE", url: "/api/memory/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  // ── DELETE /api/memory 批量清除 ────────────────────────

  it("DELETE /memory 批量清除", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    await app.inject({
      method: "POST", url: "/api/memory",
      payload: { agentId: "a1", content: "x" },
    });
    const res = await app.inject({ method: "DELETE", url: "/api/memory?agentId=a1" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.status).toBe("cleared");
  });

  // ── Core Memory ────────────────────────────────────────

  it("GET /memory/core/:agentId 返回 core 块列表", async () => {
    // 先确保有 core block
    memMgr.updateCoreBlock("agent-1", "persona", "我是助手");
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/memory/core/agent-1" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.blocks).toHaveLength(1);
  });

  it("GET /memory/core/:agentId/:label 读取 core 块", async () => {
    memMgr.updateCoreBlock("agent-1", "persona", "助手角色");
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET", url: "/api/memory/core/agent-1/persona",
    });
    expect(res.statusCode).toBe(200);
    // core block 存储的是原始字符串，sendSuccess 直接包在 data 里
    expect(JSON.parse(res.body).data).toBe("助手角色");
  });

  it("GET /memory/core/:agentId/:label 不存在返回 404", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET", url: "/api/memory/core/agent-1/nonexistent",
    });
    expect(res.statusCode).toBe(404);
  });

  it("PUT /memory/core/:agentId/:label 替换 core 块", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "PUT", url: "/api/memory/core/agent-1/persona",
      payload: { value: "新人格" },
    });
    expect(res.statusCode).toBe(200);
    expect(memMgr.getCoreBlock("agent-1", "persona")).toBe("新人格");
  });

  it("POST /memory/core/:agentId/:label/append 追加", async () => {
    memMgr.updateCoreBlock("agent-1", "notes", "初始");
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/memory/core/agent-1/notes/append",
      payload: { text: "+追加" },
    });
    expect(res.statusCode).toBe(200);
    expect(memMgr.getCoreBlock("agent-1", "notes")).toBe("初始+追加");
  });

  // ── FTS Search ─────────────────────────────────────────

  it("GET /memory/fts 缺 q 返回 400", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/memory/fts" });
    expect(res.statusCode).toBe(400);
  });

  it("GET /memory/fts 搜索成功", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET", url: "/api/memory/fts?q=hello",
    });
    expect(res.statusCode).toBe(200);
  });

  // ── Contradictions ─────────────────────────────────────

  it("GET /memory/contradictions 返回矛盾检测结果", async () => {
    const app = await buildApp(memoryRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/memory/contradictions" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.contradictions).toEqual([]);
  });
});
