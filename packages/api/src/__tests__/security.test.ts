/**
 * security.test.ts — 安全策略与凭据路由集成测试
 *
 * 覆盖端点:
 *   GET    /api/security/policies              — 策略列表
 *   GET    /api/security/policies/:id          — 获取单个策略
 *   PUT    /api/security/policies/:id          — 创建/更新策略
 *   DELETE /api/security/policies/:id          — 删除策略
 *   POST   /api/security/check                 — 工具权限检查
 *   GET    /api/security/credentials           — 凭据列表
 *   POST   /api/security/credentials           — 存储凭据
 *   DELETE /api/security/credentials/:name     — 删除凭据
 *   GET    /api/security/audit                 — 审计日志
 *   GET    /api/security/stats                 — 安全统计
 *   GET    /api/security/approvals/pending      — 待审批列表
 *   POST   /api/security/approvals/:id/resolve — 审批处理
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { securityRoutes } from "../routes/security.js";
import { buildApp } from "./test-helpers.js";
import type { AppContext } from "../context.js";

// Mock @super-agent/core imports used by security routes
vi.mock("@super-agent/core", () => ({
  queryConfigAuditLog: vi.fn(() => []),
  listPendingApprovals: vi.fn(() => []),
  resolveApproval: vi.fn(() => true),
}));

describe("安全路由", () => {
  let securityManager: Record<string, any>;
  let ctx: Partial<AppContext>;

  beforeEach(() => {
    const policies = new Map<string, any>();
    // 预置 default 策略
    policies.set("default", {
      id: "default", name: "Default Policy", defaultSandbox: "none",
      defaultPermission: "allow", blockedTools: [], auditEnabled: true,
    });

    const credentials = new Map<string, any>();
    const auditLog: any[] = [];

    securityManager = {
      listPolicies: () => Array.from(policies.values()),
      getPolicy: (id: string) => policies.get(id) || null,
      setPolicy: (p: any) => { policies.set(p.id, p); },
      deletePolicy: (id: string) => policies.delete(id),
      checkPermission: vi.fn().mockReturnValue({ allowed: true, reason: "test mock" }),
      listCredentials: () => Array.from(credentials.values()).map(
        (c: any) => ({ name: c.name, description: c.description, createdAt: c.createdAt }),
      ),
      storeCredential: (name: string, value: string, opts: any) => {
        const entry = { name, description: opts.description, createdAt: new Date().toISOString() };
        credentials.set(name, { ...entry, value });
        return entry;
      },
      deleteCredential: (name: string) => credentials.delete(name),
      getAuditLog: vi.fn(() => auditLog),
      getStats: vi.fn(() => ({ totalPolicies: policies.size, totalCredentials: credentials.size })),
    };

    ctx = { securityManager: securityManager as any } as unknown as Partial<AppContext>;
  });

  // ── Policies ────────────────────────────────────────────

  it("GET /policies 返回策略列表（含 default）", async () => {
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/security/policies" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe("Default Policy");
  });

  it("GET /policies/:id 返回单个策略", async () => {
    securityManager.setPolicy({ id: "p1", name: "Test Policy", defaultSandbox: "sandbox", defaultPermission: "deny", blockedTools: [], auditEnabled: true });
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/security/policies/p1" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.name).toBe("Test Policy");
  });

  it("GET /policies/:id 不存在返回 404", async () => {
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/security/policies/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("PUT /policies/:id 创建/更新策略", async () => {
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "PUT", url: "/api/security/policies/new-policy",
      payload: { name: "New Policy", defaultSandbox: "strict", blockedTools: ["rm"] },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.name).toBe("New Policy");
  });

  it("PUT /policies/:id 缺 name 返回 400", async () => {
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "PUT", url: "/api/security/policies/bad",
      payload: { defaultSandbox: "strict" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /policies/:id 删除非 default 策略成功", async () => {
    securityManager.setPolicy({ id: "p-delete", name: "To Delete", defaultSandbox: "none", defaultPermission: "allow", blockedTools: [], auditEnabled: true });
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({ method: "DELETE", url: "/api/security/policies/p-delete" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.deleted).toBe(true);
  });

  it("DELETE /policies/default 返回 400（不能删 default）", async () => {
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({ method: "DELETE", url: "/api/security/policies/default" });
    expect(res.statusCode).toBe(400);
  });

  // ── Permission Check ────────────────────────────────────

  it("POST /check 返回权限结果", async () => {
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/security/check",
      payload: { toolName: "read_file", agentId: "agent-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.allowed).toBe(true);
  });

  it("POST /check 缺 agentId 返回 400", async () => {
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/security/check",
      payload: { toolName: "read_file" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Credentials ─────────────────────────────────────────

  it("GET /credentials 返回凭据列表（脱敏）", async () => {
    securityManager.storeCredential("api-key-1", "secret-value", { description: "Test API key" });
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/security/credentials" });
    expect(res.statusCode).toBe(200);
    const items = JSON.parse(res.body).data.credentials;
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("api-key-1");
    // value 不应暴露
    expect(items[0].value).toBeUndefined();
  });

  it("POST /credentials 存储凭据成功", async () => {
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/security/credentials",
      payload: { name: "github-token", value: "ghp_xxxxxxxxxx", description: "GitHub PAT" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.name).toBe("github-token");
  });

  it("POST /credentials 缺 name 返回 400", async () => {
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/security/credentials",
      payload: { value: "some-secret" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /credentials/:name 删除成功", async () => {
    securityManager.storeCredential("to-delete", "xxx", {});
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({ method: "DELETE", url: "/api/security/credentials/to-delete" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.deleted).toBe(true);
  });

  // ── Audit & Stats ──────────────────────────────────────

  it("GET /audit 返回审计日志", async () => {
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/security/audit" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.entries).toBeInstanceOf(Array);
  });

  it("GET /stats 返回安全统计", async () => {
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/security/stats" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.totalPolicies).toBeGreaterThanOrEqual(1);
  });

  // ── Approvals ───────────────────────────────────────────

  it("GET /approvals/pending 返回待审批列表", async () => {
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/security/approvals/pending" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.approvals).toBeInstanceOf(Array);
  });

  it("POST /approvals/:id/resolve 审批通过", async () => {
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/security/approvals/approval-1/resolve",
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.resolved).toBe(true);
  });

  it("POST /approvals/:id/resolve 缺 approved 字段返回 400", async () => {
    const app = await buildApp(securityRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST", url: "/api/security/approvals/approval-1/resolve",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
