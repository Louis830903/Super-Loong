/**
 * knowledge-graph.test.ts — 知识图谱路由集成测试
 *
 * 覆盖端点:
 *   GET    /api/knowledge/stats              — 三元组统计
 *   GET    /api/knowledge/entities/:name     — 实体关系
 *   POST   /api/knowledge/search             — 子图查询
 *   POST   /api/knowledge/path               — 路径搜索
 *   GET    /api/knowledge/export             — 导出
 *   POST   /api/knowledge/triples            — 添加三元组
 *   DELETE /api/knowledge/triples            — 删除三元组
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { AppContext } from "../context.js";
import { knowledgeGraphRoutes } from "../routes/knowledge-graph.js";
import { buildApp, MockKnowledgeGraph } from "./test-helpers.js";

describe("知识图谱路由", () => {
  let kg: MockKnowledgeGraph;
  let ctx: Partial<AppContext>;

  beforeEach(() => {
    kg = new MockKnowledgeGraph();
    ctx = { knowledgeGraph: kg as any } as unknown as Partial<AppContext>;
  });

  // ── No KG → 501 ────────────────────────────────────────

  it("无 KnowledgeGraph 时返回 501", async () => {
    const app = await buildApp(knowledgeGraphRoutes, {} as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/knowledge/stats" });
    expect(res.statusCode).toBe(501);
  });

  // ── GET /api/knowledge/stats ────────────────────────────

  it("GET /stats 返回三元组数量", async () => {
    const app = await buildApp(knowledgeGraphRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/knowledge/stats" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.tripleCount).toBe(5);
  });

  // ── GET /api/knowledge/entities/:name ───────────────────

  it("GET /entities/:name 存在时返回出入边", async () => {
    const app = await buildApp(knowledgeGraphRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET", url: "/api/knowledge/entities/TestEntity",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.entityId).toBe(1);
    expect(body.data.outgoing).toHaveLength(1);
    expect(body.data.incoming).toHaveLength(1);
  });

  it("GET /entities/:name 不存在返回 404", async () => {
    // 临时覆盖 findEntityId 返回 null（模拟实体不存在）
    const origFind = kg.findEntityId.bind(kg);
    (kg as any).findEntityId = () => null;
    const app = await buildApp(knowledgeGraphRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET", url: "/api/knowledge/entities/NotFound",
    });
    expect(res.statusCode).toBe(404);
    kg.findEntityId = origFind;
  });

  // ── POST /api/knowledge/search ──────────────────────────

  it("POST /search 缺 rootId 返回 400", async () => {
    const app = await buildApp(knowledgeGraphRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/knowledge/search",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /search 返回子图", async () => {
    const app = await buildApp(knowledgeGraphRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/knowledge/search",
      payload: { rootId: 1, maxDepth: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.nodes).toBeDefined();
  });

  // ── POST /api/knowledge/path ────────────────────────────

  it("POST /path 缺必填字段返回 400", async () => {
    const app = await buildApp(knowledgeGraphRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/knowledge/path",
      payload: { fromId: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /path 返回路径", async () => {
    const app = await buildApp(knowledgeGraphRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/knowledge/path",
      payload: { fromId: 1, toId: 2, maxHops: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.hops).toBe(1);
  });

  // ── GET /api/knowledge/export ───────────────────────────

  it("GET /export 非法 format 返回 400", async () => {
    const app = await buildApp(knowledgeGraphRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET", url: "/api/knowledge/export?format=pdf",
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /export json 格式成功", async () => {
    const app = await buildApp(knowledgeGraphRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET", url: "/api/knowledge/export?rootId=1&depth=2&format=json",
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /export mermaid 格式返回纯文本", async () => {
    const app = await buildApp(knowledgeGraphRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET", url: "/api/knowledge/export?rootId=1&format=mermaid",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
  });

  // ── POST /api/knowledge/triples ─────────────────────────

  it("POST /triples 缺必填字段返回 400", async () => {
    const app = await buildApp(knowledgeGraphRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/knowledge/triples",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /triples 添加成功返回 201", async () => {
    const app = await buildApp(knowledgeGraphRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/knowledge/triples",
      payload: {
        subjectId: 1, predicate: "knows", objectId: 2, source: "test",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data.id).toBe("triple-1");
  });

  // ── DELETE /api/knowledge/triples ────────────────────────

  it("DELETE /triples 缺 tripleId 和 source 返回 400", async () => {
    const app = await buildApp(knowledgeGraphRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "DELETE", url: "/api/knowledge/triples",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /triples 按 tripleId 删除", async () => {
    const app = await buildApp(knowledgeGraphRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "DELETE", url: "/api/knowledge/triples",
      payload: { tripleId: "triple-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.deleted).toBe(1);
  });

  it("DELETE /triples 按 source 删除", async () => {
    const app = await buildApp(knowledgeGraphRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "DELETE", url: "/api/knowledge/triples",
      payload: { source: "old-source" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.deleted).toBe(2);
  });
});
