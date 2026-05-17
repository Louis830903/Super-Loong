/**
 * traces.test.ts — 全链路追踪路由集成测试
 *
 * 覆盖端点:
 *   GET  /api/traces           — 最近 Trace 列表
 *   GET  /api/traces/:traceId  — 单条 Trace Span 树
 *   POST /api/traces/toggle    — 动态开关追踪
 *
 * 注：GET /api/traces/live (SSE) 用 app.inject() 难以测试，跳过。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildAppNoCtx } from "./test-helpers.js";
import { registerTracesRoutes } from "../routes/traces.js";

// 状态管理
let tracingEnabled = true;

// Mock @super-agent/core traces 相关函数
const { mockGetRecentTraces, mockGetTraceSpans, mockSetTracingEnabled } =
  vi.hoisted(() => ({
    mockGetRecentTraces: vi.fn((limit: number, offset: number) => [] as any[]),
    mockGetTraceSpans: vi.fn((traceId: string) => [] as any[]),
    mockSetTracingEnabled: vi.fn((enabled: boolean) => {
      tracingEnabled = enabled;
    }),
  }));

vi.mock("@super-agent/core", () => ({
  getRecentTraces: mockGetRecentTraces,
  getTraceSpans: mockGetTraceSpans,
  onSpan: vi.fn(),
  offSpan: vi.fn(),
  isTracingEnabled: () => tracingEnabled,
  setTracingEnabled: mockSetTracingEnabled,
  initTraceStore: vi.fn(),
}));

describe("追踪路由", () => {
  beforeEach(() => {
    tracingEnabled = true;
    mockGetRecentTraces.mockReturnValue([]);
    mockGetTraceSpans.mockReturnValue([]);
  });

  // ── 列表 ──────────────────────────────────────────────

  it("GET /traces 追踪启用返回列表（含分页）", async () => {
    const mockTrace = { traceId: "t-1", operation: "chat", spanCount: 3, startTime: Date.now() };
    mockGetRecentTraces.mockReturnValue([mockTrace]);

    const app = await buildAppNoCtx(registerTracesRoutes);
    const res = await app.inject({ method: "GET", url: "/api/traces" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.enabled).toBe(true);
    expect(body.data.traces).toHaveLength(1);
    expect(body.data.traces[0].traceId).toBe("t-1");
    expect(body.data.pagination).toBeDefined();
  });

  it("GET /traces 追踪禁用返回空列表", async () => {
    tracingEnabled = false;
    const app = await buildAppNoCtx(registerTracesRoutes);
    const res = await app.inject({ method: "GET", url: "/api/traces" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.enabled).toBe(false);
    expect(body.data.traces).toEqual([]);
  });

  it("GET /traces 支持 limit/offset 查询参数", async () => {
    mockGetRecentTraces.mockReturnValue([]);
    const app = await buildAppNoCtx(registerTracesRoutes);
    const res = await app.inject({
      method: "GET",
      url: "/api/traces?limit=10&offset=5",
    });
    expect(res.statusCode).toBe(200);
    expect(mockGetRecentTraces).toHaveBeenCalledWith(10, 5);
  });

  // ── 详情 ──────────────────────────────────────────────

  it("GET /traces/:traceId 返回 Span 树", async () => {
    const mockSpans = [
      { spanId: "s-1", traceId: "t-1", parentSpanId: null, operation: "chat", startTime: 1000, endTime: 2000, duration: 1000, status: "ok" as const, attributes: {} },
      { spanId: "s-2", traceId: "t-1", parentSpanId: "s-1", operation: "llm.call", startTime: 1100, endTime: 1900, duration: 800, status: "ok" as const, attributes: {} },
    ];
    mockGetTraceSpans.mockReturnValue(mockSpans);

    const app = await buildAppNoCtx(registerTracesRoutes);
    const res = await app.inject({ method: "GET", url: "/api/traces/t-1" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.traceId).toBe("t-1");
    expect(body.data.spanCount).toBe(2);
    expect(body.data.tree).toBeInstanceOf(Array);
  });

  it("GET /traces/:traceId 追踪禁用返回提示", async () => {
    tracingEnabled = false;
    const app = await buildAppNoCtx(registerTracesRoutes);
    const res = await app.inject({ method: "GET", url: "/api/traces/t-1" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.enabled).toBe(false);
  });

  it("GET /traces/:traceId 不存在返回 404", async () => {
    mockGetTraceSpans.mockReturnValue([]);
    const app = await buildAppNoCtx(registerTracesRoutes);
    const res = await app.inject({ method: "GET", url: "/api/traces/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  // ── 开关 ──────────────────────────────────────────────

  it("POST /toggle 开启追踪", async () => {
    tracingEnabled = false;
    const app = await buildAppNoCtx(registerTracesRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/api/traces/toggle",
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.enabled).toBe(true);
    expect(mockSetTracingEnabled).toHaveBeenCalledWith(true);
  });

  it("POST /toggle 关闭追踪", async () => {
    const app = await buildAppNoCtx(registerTracesRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/api/traces/toggle",
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(mockSetTracingEnabled).toHaveBeenCalledWith(false);
  });

  it("POST /toggle 缺 enabled 字段返回 400", async () => {
    const app = await buildAppNoCtx(registerTracesRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/api/traces/toggle",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
