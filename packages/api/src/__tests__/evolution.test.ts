/**
 * evolution.test.ts — 进化引擎路由集成测试
 *
 * 覆盖端点:
 *   POST   /api/evolution/interactions         — 记录交互案例
 *   GET    /api/evolution/interactions          — 列出交互案例
 *   GET    /api/evolution/interactions/failures — 列出失败案例
 *   POST   /api/evolution/analyze              — 触发失败分析
 *   POST   /api/evolution/review               — 触发审查
 *   POST   /api/evolution/flush                — 会话保存
 *   GET    /api/evolution/proposals             — 提案列表
 *   POST   /api/evolution/proposals/:id/approve — 通过提案
 *   POST   /api/evolution/proposals/:id/reject  — 拒绝提案
 *   POST   /api/evolution/proposals/:id/apply   — 标记已应用
 *   POST   /api/evolution/snapshots            — 拍摄快照
 *   GET    /api/evolution/snapshots             — 列出快照
 *   DELETE /api/evolution/snapshots/:id         — 删除快照
 *   GET    /api/evolution/stats                 — 统计信息
 *   GET    /api/evolution/nudge/config          — 获取审查配置
 *   PUT    /api/evolution/nudge/config          — 更新审查配置
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { evolutionRoutes } from "../routes/evolution.js";
import { buildApp } from "./test-helpers.js";
import type { AppContext } from "../context.js";

// ─── Mock Evolution Engine ──────────────────────────────────

function makeMockEngine() {
  const cases: any[] = [];
  const proposals: any[] = [];
  const snapshots: any[] = [];
  const nudgeConfig = {
    memoryReviewInterval: 24,
    skillReviewInterval: 48,
    autoApplySkills: false,
    flushMinTurns: 0,
  };
  let analyzerLlm: { providerId: string | null; modelId: string | null } = { providerId: null, modelId: null };

  return {
    cases: {
      getAllCases: () => [...cases],
      getFailureCases: () => cases.filter((c) => !c.success),
      getFailuresByCategory: () => {
        const map: Record<string, number> = {};
        cases.filter((c) => !c.success).forEach((c) => {
          map[c.failureCategory ?? "unknown"] = (map[c.failureCategory ?? "unknown"] ?? 0) + 1;
        });
        return map;
      },
    },
    recordInteraction: (input: any) => {
      const c = { id: `case-${cases.length + 1}`, ...input, createdAt: new Date().toISOString() };
      cases.push(c);
      return c;
    },
    analyzeFailures: vi.fn().mockResolvedValue([]),
    triggerReview: vi.fn().mockResolvedValue({ reviewed: true, actions: [] }),
    flushBeforeReset: vi.fn().mockResolvedValue({ flushed: true, savedMemories: 1 }),

    getProposals: (filter?: { status?: string }) => {
      if (filter?.status) return proposals.filter((p) => p.status === filter.status);
      return [...proposals];
    },
    approveProposal: vi.fn().mockImplementation((id: string) => {
      const p = proposals.find((p2) => p2.id === id);
      if (!p) return null;
      p.status = "approved";
      return p;
    }),
    rejectProposal: (id: string) => {
      const p = proposals.find((p2) => p2.id === id);
      if (!p) return null;
      p.status = "rejected";
      return p;
    },
    applyProposal: vi.fn().mockImplementation((id: string) => {
      const p = proposals.find((p2) => p2.id === id);
      if (!p) return null;
      p.status = "applied";
      return p;
    }),

    takeSnapshot: (label?: string) => {
      const s = { id: `snap-${snapshots.length + 1}`, label, createdAt: new Date().toISOString() };
      snapshots.push(s);
      return s;
    },
    getSnapshots: () => [...snapshots],
    getBestSnapshot: () => snapshots[snapshots.length - 1] ?? null,
    deleteSnapshot: (id: string) => {
      const idx = snapshots.findIndex((s) => s.id === id);
      if (idx === -1) return false;
      snapshots.splice(idx, 1);
      return true;
    },

    getStats: () => ({ totalCases: cases.length, failureRate: 0, proposalCount: proposals.length }),
    nudge: {
      getConfig: () => ({ ...nudgeConfig }),
      updateConfig: (u: any) => Object.assign(nudgeConfig, u),
    },
    getAnalyzerLlm: () => ({ ...analyzerLlm }),
    setAnalyzerLlm: (pid: string | null, mid: string | null) => { analyzerLlm = { providerId: pid, modelId: mid }; },
  };
}

// ─── 测试套件 ────────────────────────────────────────────────

describe("进化引擎路由", () => {
  let engine: ReturnType<typeof makeMockEngine>;
  let ctxCore: AppContext;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = makeMockEngine();
    ctxCore = { evolutionEngine: engine as any } as unknown as AppContext;
  });

  function ctxWithAgents(agents: any[]) {
    return { evolutionEngine: engine as any, agentManager: { listAgents: () => agents } } as unknown as AppContext;
  }

  // ── Interactions ─────────────────────────────────────────

  it("POST /interactions 记录成功案例", async () => {
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({
      method: "POST", url: "/api/evolution/interactions",
      payload: { agentId: "agent-1", userMessage: "hello", agentResponse: "hi", success: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.agentId).toBe("agent-1");
  });

  it("POST /interactions 缺少必填字段返回 400", async () => {
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({
      method: "POST", url: "/api/evolution/interactions",
      payload: { agentId: "", userMessage: "", agentResponse: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /interactions 空列表", async () => {
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "GET", url: "/api/evolution/interactions" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual([]);
  });

  it("GET /interactions 记录后返回列表", async () => {
    engine.recordInteraction({ agentId: "a1", sessionId: "s1", userMessage: "q", agentResponse: "a", success: true });
    engine.recordInteraction({ agentId: "a1", sessionId: "s1", userMessage: "q2", agentResponse: "a2", success: false, failureCategory: "timeout" });
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "GET", url: "/api/evolution/interactions" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toHaveLength(2);
  });

  it("GET /interactions/failures 返回失败案例统计", async () => {
    engine.recordInteraction({ agentId: "a1", sessionId: "s1", userMessage: "x", agentResponse: "y", success: false, failureCategory: "crash" });
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "GET", url: "/api/evolution/interactions/failures" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.cases).toHaveLength(1);
    expect(body.data.byCategory).toHaveProperty("crash");
  });

  // ── Analysis ─────────────────────────────────────────────

  it("POST /analyze 触发分析", async () => {
    engine.analyzeFailures.mockResolvedValue([{ id: "p1", title: "Fix timeout" }]);
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "POST", url: "/api/evolution/analyze" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.proposals).toHaveLength(1);
    expect(body.data.count).toBe(1);
  });

  // ── Review ───────────────────────────────────────────────

  it("POST /review 无 Agent 时返回 400", async () => {
    const ctx = ctxWithAgents([]);
    const app = await buildApp(evolutionRoutes, ctx);
    const res = await app.inject({ method: "POST", url: "/api/evolution/review", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("POST /review 有 Agent 时成功", async () => {
    const ctx = ctxWithAgents([{ id: "agent-1", name: "Test" }]);
    const app = await buildApp(evolutionRoutes, ctx);
    const res = await app.inject({ method: "POST", url: "/api/evolution/review", payload: { agentId: "agent-1" } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.reviewed).toBe(true);
  });

  it("POST /review Zod 校验失败返回 400", async () => {
    const ctx = ctxWithAgents([{ id: "agent-1", name: "Test" }]);
    const app = await buildApp(evolutionRoutes, ctx);
    const res = await app.inject({ method: "POST", url: "/api/evolution/review", payload: { reviewMemory: "not-a-boolean" } });
    expect(res.statusCode).toBe(400);
  });

  // ── Proposals ────────────────────────────────────────────

  it("GET /proposals 空列表", async () => {
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "GET", url: "/api/evolution/proposals" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.proposals).toEqual([]);
  });

  it("POST /proposals/:id/approve 通过成功", async () => {
    // 直接 push 到内部 proposals 数组
    (engine as any).approveProposal = vi.fn().mockImplementation((id: string) => {
      return { id, title: "Test", status: "approved" };
    });
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "POST", url: "/api/evolution/proposals/p1/approve" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.status).toBe("approved");
  });

  it("POST /proposals/:id/approve 不存在返回 404", async () => {
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "POST", url: "/api/evolution/proposals/nonexistent/approve" });
    expect(res.statusCode).toBe(404);
  });

  it("POST /proposals/:id/reject 拒绝成功", async () => {
    (engine as any).rejectProposal = (id: string) => ({ id, title: "Test", status: "rejected" });
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "POST", url: "/api/evolution/proposals/p1/reject" });
    expect(res.statusCode).toBe(200);
  });

  it("POST /proposals/:id/reject 不存在返回 404", async () => {
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "POST", url: "/api/evolution/proposals/nonexistent/reject" });
    expect(res.statusCode).toBe(404);
  });

  it("POST /proposals/:id/apply 应用成功", async () => {
    (engine as any).applyProposal = vi.fn().mockResolvedValue({ id: "p1", title: "Test", status: "applied" });
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "POST", url: "/api/evolution/proposals/p1/apply" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.status).toBe("applied");
  });

  it("POST /proposals/:id/apply 不存在返回 404", async () => {
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "POST", url: "/api/evolution/proposals/nonexistent/apply" });
    expect(res.statusCode).toBe(404);
  });

  // ── Snapshots ────────────────────────────────────────────

  it("POST /snapshots 创建快照", async () => {
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "POST", url: "/api/evolution/snapshots", payload: { label: "v1.0" } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.label).toBe("v1.0");
  });

  it("GET /snapshots 列出快照", async () => {
    engine.takeSnapshot("v1");
    engine.takeSnapshot("v2");
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "GET", url: "/api/evolution/snapshots" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.snapshots).toHaveLength(2);
    expect(body.data.best).toBeTruthy();
  });

  it("DELETE /snapshots/:id 删除成功", async () => {
    const s = engine.takeSnapshot("to-delete");
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "DELETE", url: `/api/evolution/snapshots/${s.id}` });
    expect(res.statusCode).toBe(200);
  });

  it("DELETE /snapshots/:id 不存在返回 404", async () => {
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "DELETE", url: "/api/evolution/snapshots/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  // ── Stats & Nudge Config ─────────────────────────────────

  it("GET /stats 返回统计", async () => {
    engine.recordInteraction({ agentId: "a1", sessionId: "s1", userMessage: "q", agentResponse: "a", success: true });
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "GET", url: "/api/evolution/stats" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.totalCases).toBe(1);
  });

  it("GET /nudge/config 读取配置", async () => {
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({ method: "GET", url: "/api/evolution/nudge/config" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.memoryReviewInterval).toBe(24);
  });

  it("PUT /nudge/config 更新配置成功", async () => {
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({
      method: "PUT", url: "/api/evolution/nudge/config",
      payload: { memoryReviewInterval: 12, autoApplySkills: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.memoryReviewInterval).toBe(12);
    expect(JSON.parse(res.body).data.autoApplySkills).toBe(true);
  });

  it("PUT /nudge/config 非法值返回 400", async () => {
    const app = await buildApp(evolutionRoutes, ctxCore);
    const res = await app.inject({
      method: "PUT", url: "/api/evolution/nudge/config",
      payload: { memoryReviewInterval: -5 },
    });
    expect(res.statusCode).toBe(400);
  });
});
