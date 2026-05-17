/**
 * video.test.ts — 视频路由集成测试
 *
 * 覆盖端点:
 *   GET    /api/video/jobs      — 列表视频任务（分页 + 状态过滤）
 *   GET    /api/video/jobs/:id  — 获取单个视频任务详情
 *
 * POST /api/video/jobs 依赖完整视频生成管道（Crew+Agent+WS），
 * 适合 E2E 测试而非单元集成测试。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { videoRoutes } from "../routes/video.js";
import { buildApp } from "./test-helpers.js";
import type { AppContext } from "../context.js";

// ─── Mock @super-agent/core 视频相关函数 ──────────────────

const { mockVideoJobs, mockListVideoJobs, mockGetVideoJob } = vi.hoisted(() => {
  const jobs = new Map<string, any>();
  return {
    mockVideoJobs: jobs,
    mockListVideoJobs: vi.fn(({ status, _limit, _offset }: any) => {
      let all = Array.from(jobs.values());
      if (status) all = all.filter((j) => j.status === status);
      return all;
    }),
    mockGetVideoJob: vi.fn((id: string) => jobs.get(id) || null),
  };
});

vi.mock("@super-agent/core", () => ({
  listVideoJobs: mockListVideoJobs,
  getVideoJob: mockGetVideoJob,
  estimateCost: vi.fn(() => ({ estimate_cny: 0.5, currency: "CNY" })),
  insertVideoJob: vi.fn(),
  updateVideoJob: vi.fn(),
  buildShortVideoCrew: vi.fn(),
  buildShortVideoAgents: vi.fn(() => []),
  validateVideoCrewModel: vi.fn(),
  saveMediaBuffer: vi.fn(),
  getProviderTemplates: vi.fn(() => []),
  applyAllAgentProviders: vi.fn(),
  PROVIDER_PRESETS: [],
}));

// Mock emitEvent (WS 推送)
vi.mock("../ws/index.js", () => ({
  emitEvent: vi.fn(),
}));

// Mock enqueueVideoJob
vi.mock("../services/video-forge-supervisor.js", () => ({
  enqueueVideoJob: vi.fn((_id: string, _fn: any) => Promise.resolve()),
}));

describe("视频路由", () => {
  const ctx: Partial<AppContext> = {
    agentManager: {
      getAgent: vi.fn().mockReturnValue(null),
      createAgent: vi.fn(),
      updateAgent: vi.fn(),
    } as any,
    providerStore: {
      getApiKey: vi.fn().mockReturnValue(null),
    } as any,
    collaborationOrchestrator: {
      on: vi.fn(),
      off: vi.fn(),
      abort: vi.fn(),
      runCrew: vi.fn(),
    } as any,
  };

  beforeEach(() => {
    mockVideoJobs.clear();
  });

  // ── GET /api/video/jobs ─────────────────────────────────

  it("GET /jobs 空列表", async () => {
    const app = await buildApp(videoRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/video/jobs" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.jobs).toEqual([]);
    expect(body.data.count).toBe(0);
  });

  it("GET /jobs 有任务时返回列表", async () => {
    mockVideoJobs.set("vj-1", { id: "vj-1", status: "succeeded", input_json: "{}", created_at: 1000, updated_at: 1000 });
    mockVideoJobs.set("vj-2", { id: "vj-2", status: "pending", input_json: "{}", created_at: 2000, updated_at: 2000 });
    const app = await buildApp(videoRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/video/jobs" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.jobs).toHaveLength(2);
  });

  it("GET /jobs 按状态过滤", async () => {
    mockVideoJobs.set("vj-1", { id: "vj-1", status: "succeeded", input_json: "{}", created_at: 1000, updated_at: 1000 });
    mockVideoJobs.set("vj-2", { id: "vj-2", status: "pending", input_json: "{}", created_at: 2000, updated_at: 2000 });
    const app = await buildApp(videoRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/video/jobs?status=pending" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.jobs).toHaveLength(1);
    expect(body.data.jobs[0].status).toBe("pending");
  });

  // ── GET /api/video/jobs/:id ─────────────────────────────

  it("GET /jobs/:id 返回任务详情", async () => {
    mockVideoJobs.set("vj-test", {
      id: "vj-test", status: "succeeded",
      input_json: '{"topic":"测试主题"}',
      cost_estimate_cny: 0.5, created_at: 1000, updated_at: 2000,
    });
    const app = await buildApp(videoRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/video/jobs/vj-test" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.id).toBe("vj-test");
    expect(body.data.status).toBe("succeeded");
  });

  it("GET /jobs/:id 不存在返回 404", async () => {
    const app = await buildApp(videoRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/video/jobs/nonexistent" });
    expect(res.statusCode).toBe(404);
  });
});
