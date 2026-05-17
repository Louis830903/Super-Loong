/**
 * cron.test.ts — 定时任务路由集成测试
 *
 * 覆盖端点:
 *   GET    /api/cron/jobs            — 任务列表
 *   POST   /api/cron/jobs            — 创建任务
 *   PUT    /api/cron/jobs/:id        — 更新任务
 *   DELETE /api/cron/jobs/:id        — 删除任务
 *   POST   /api/cron/jobs/:id/run    — 立即执行
 *   GET    /api/cron/jobs/:id/history — 执行历史
 *   POST   /api/cron/parse           — 自然语言转 cron 表达式
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppContext } from "../context.js";
import { cronRoutes } from "../routes/cron.js";
import { buildApp, MockCronScheduler } from "./test-helpers.js";

// Mock @super-agent/core 的 cron 工具函数
const { mockParseNL, mockValidateCron } = vi.hoisted(() => ({
  mockParseNL: vi.fn((text: string) => `0 9 * * *`),
  mockValidateCron: vi.fn((expr: string) => ({ valid: true })),
}));

vi.mock("@super-agent/core", () => ({
  parseNaturalLanguageToCron: mockParseNL,
  validateCronExpression: mockValidateCron,
}));

describe("定时任务路由", () => {
  let scheduler: MockCronScheduler;
  let ctx: Partial<AppContext>;

  beforeEach(() => {
    scheduler = new MockCronScheduler();
    ctx = { cronScheduler: scheduler as any } as unknown as Partial<AppContext>;
    mockParseNL.mockReturnValue("0 9 * * *");
    mockValidateCron.mockReturnValue({ valid: true });
  });

  // ── 空列表 ────────────────────────────────────────────

  it("GET /jobs 空列表", async () => {
    const app = await buildApp(cronRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/cron/jobs" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.jobs).toEqual([]);
  });

  // ── 创建 ──────────────────────────────────────────────

  it("POST /jobs 创建成功", async () => {
    const app = await buildApp(cronRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/cron/jobs",
      payload: {
        name: "日报提醒",
        expression: "0 9 * * *",
        agentId: "agent-1",
        message: "生成日报",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.name).toBe("日报提醒");
  });

  it("POST /jobs 缺 name 返回 400", async () => {
    const app = await buildApp(cronRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/cron/jobs",
      payload: { expression: "0 9 * * *", agentId: "agent-1", message: "test" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /jobs 缺 agentId 返回 400", async () => {
    const app = await buildApp(cronRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/cron/jobs",
      payload: { name: "test", expression: "0 9 * * *", message: "test" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /jobs 无 expression 且无 naturalLanguage 返回 400", async () => {
    const app = await buildApp(cronRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/cron/jobs",
      payload: { name: "test", agentId: "agent-1", message: "test" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /jobs naturalLanguage 解析成功", async () => {
    mockParseNL.mockReturnValueOnce("30 14 * * *");
    const app = await buildApp(cronRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/cron/jobs",
      payload: {
        name: "午间提醒",
        naturalLanguage: "每天下午两点半",
        agentId: "agent-2",
        message: "午间更新",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(mockParseNL).toHaveBeenCalledWith("每天下午两点半");
  });

  it("POST /jobs 非法 cron 表达式返回 400", async () => {
    mockValidateCron.mockReturnValueOnce({ valid: false, error: "Invalid" });
    const app = await buildApp(cronRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/cron/jobs",
      payload: {
        name: "bad",
        expression: "not valid",
        agentId: "agent-1",
        message: "test",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /jobs 无 cronScheduler 时路由禁用返回 404", async () => {
    const app = await buildApp(cronRoutes, {} as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/cron/jobs",
      payload: { name: "test", expression: "* * * * *", agentId: "a", message: "m" },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── 查询与更新 ────────────────────────────────────────

  it("GET /jobs 创建后列表含任务", async () => {
    const app = await buildApp(cronRoutes, ctx as AppContext);
    await app.inject({
      method: "POST", url: "/api/cron/jobs",
      payload: { name: "t1", expression: "0 * * * *", agentId: "a1", message: "m1" },
    });
    const res = await app.inject({ method: "GET", url: "/api/cron/jobs" });
    expect(JSON.parse(res.body).data.jobs).toHaveLength(1);
  });

  it("PUT /jobs/:id 更新成功", async () => {
    const app = await buildApp(cronRoutes, ctx as AppContext);
    const create = await app.inject({
      method: "POST", url: "/api/cron/jobs",
      payload: { name: "t1", expression: "0 * * * *", agentId: "a1", message: "m1" },
    });
    const id = JSON.parse(create.body).data.id;

    const res = await app.inject({
      method: "PUT", url: `/api/cron/jobs/${id}`,
      payload: { name: "updated", enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const updated = JSON.parse(res.body).data.job;
    expect(updated.name).toBe("updated");
    expect(updated.enabled).toBe(false);
  });

  it("PUT /jobs/:id 不存在返回 404", async () => {
    const app = await buildApp(cronRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "PUT", url: "/api/cron/jobs/nonexistent",
      payload: { name: "nope" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("PUT /jobs/:id 非法 expression 返回 400", async () => {
    const app = await buildApp(cronRoutes, ctx as AppContext);
    const create = await app.inject({
      method: "POST", url: "/api/cron/jobs",
      payload: { name: "t1", expression: "0 * * * *", agentId: "a1", message: "m1" },
    });
    const id = JSON.parse(create.body).data.id;

    mockValidateCron.mockReturnValueOnce({ valid: false, error: "bad" });
    const res = await app.inject({
      method: "PUT", url: `/api/cron/jobs/${id}`,
      payload: { expression: "invalid" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── 删除 ──────────────────────────────────────────────

  it("DELETE /jobs/:id 删除成功", async () => {
    const app = await buildApp(cronRoutes, ctx as AppContext);
    const create = await app.inject({
      method: "POST", url: "/api/cron/jobs",
      payload: { name: "t1", expression: "0 * * * *", agentId: "a1", message: "m1" },
    });
    const id = JSON.parse(create.body).data.id;

    const res = await app.inject({ method: "DELETE", url: `/api/cron/jobs/${id}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.status).toBe("deleted");
  });

  it("DELETE /jobs/:id 不存在返回 404", async () => {
    const app = await buildApp(cronRoutes, ctx as AppContext);
    const res = await app.inject({ method: "DELETE", url: "/api/cron/jobs/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  // ── 执行历史 ──────────────────────────────────────────

  it("GET /jobs/:id/history 返回数组", async () => {
    const app = await buildApp(cronRoutes, ctx as AppContext);
    const create = await app.inject({
      method: "POST", url: "/api/cron/jobs",
      payload: { name: "t1", expression: "0 * * * *", agentId: "a1", message: "m1" },
    });
    const id = JSON.parse(create.body).data.id;

    const res = await app.inject({ method: "GET", url: `/api/cron/jobs/${id}/history` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.history).toBeInstanceOf(Array);
  });

  // ── 解析 ──────────────────────────────────────────────

  it("POST /parse 自然语言转 cron", async () => {
    mockParseNL.mockReturnValueOnce("0 8 * * 1");
    const app = await buildApp(cronRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/cron/parse",
      payload: { text: "每周一早上八点" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.expression).toBe("0 8 * * 1");
  });

  it("POST /parse 缺 text 返回 400", async () => {
    const app = await buildApp(cronRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/cron/parse",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
