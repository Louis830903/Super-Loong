/**
 * auth.test.ts — 身份认证路由集成测试
 *
 * 覆盖端点 (需 AUTH_ENABLED=true):
 *   POST   /api/auth/login         — 用户登录换取 JWT
 *   POST   /api/auth/token/refresh — 刷新 JWT
 *   GET    /api/auth/me            — 当前用户信息
 *   GET    /api/auth/keys          — 列出 API Key
 *   POST   /api/auth/keys          — 创建 API Key
 *   DELETE /api/auth/keys/:key      — 撤销 API Key
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { registerAuth, authRoutes } from "../auth/index.js";
import { initDatabase, closeDatabase } from "@super-agent/core";

describe("身份认证路由", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let tmpDir: string;

  // 共享 SQLite 单例：ApiKeyStore 迁移到 getDatabase() 后，测试须先 initDatabase
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-auth-"));
    await initDatabase(path.join(tmpDir, "test.db"));
  });

  afterAll(async () => {
    // 先 flush 事件循环：validate() 内 setImmediate 异步写 last_used_at，
    // 避免在 closeDatabase() 之后才触发、对已关闭 DB 写入产生噪音
    await new Promise((resolve) => setImmediate(resolve));
    await closeDatabase();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  });

  beforeEach(async () => {
    // 启用完整认证链路
    process.env.AUTH_ENABLED = "true";
    process.env.JWT_SECRET = "test-jwt-secret-9a7f3c2e1b4d8f6a0c2e4f7a9b1d3c5e";
    process.env.ADMIN_USERNAME = "admin";
    process.env.ADMIN_PASSWORD = "test-pass-123";

    app = Fastify({ logger: false });
    await registerAuth(app);
    await authRoutes(app);
    await app.ready();

    // 登录获取 admin token
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "test-pass-123" },
    });
    const loginBody = JSON.parse(loginRes.body);
    adminToken = loginBody.token;
  });

  afterEach(async () => {
    await app.close();
    delete process.env.AUTH_ENABLED;
    delete process.env.JWT_SECRET;
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
  });

  // ── POST /api/auth/login ────────────────────────────────

  it("POST /login 正确凭据返回 JWT token", () => {
    expect(adminToken).toBeTruthy();
    expect(adminToken).toMatch(/^eyJ/);
  });

  it("POST /login 错误密码返回 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /login 空凭据返回 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "", password: "" },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── POST /api/auth/token/refresh ────────────────────────

  it("POST /token/refresh 有效 token 返回新 token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/token/refresh",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.token).toBeTruthy();
    // JWT 同 payload+同secret 生成的签名相同（无 jti），验证是新签发的即可
    expect(body.token).toMatch(/^eyJ/);
  });

  it("POST /token/refresh 无效 token 返回 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/token/refresh",
      headers: { authorization: "Bearer invalid-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /token/refresh 无 token 返回 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/token/refresh",
    });
    expect(res.statusCode).toBe(401);
  });

  // ── GET /api/auth/me ────────────────────────────────────

  it("GET /me 返回当前用户信息", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe("admin");
    expect(body.role).toBe("admin");
    expect(body.permissions).toContain("*");
  });

  it("GET /me 无 token 返回 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
    });
    expect(res.statusCode).toBe(401);
  });

  // ── API Key CRUD ────────────────────────────────────────

  let testKey: string;

  it("POST /keys 创建 API Key（需 admin 权限）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/keys",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "test-key", role: "operator" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe("test-key");
    expect(body.role).toBe("operator");
    expect(body.key).toMatch(/^sk-/);
    testKey = body.key;
  });

  it("POST /keys 创建 API Key 缺 name 返回错误", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/keys",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Name required");
  });

  it("POST /keys 无 token 返回 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/keys",
      payload: { name: "anonymous-key" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /keys 列出所有 API Key（脱敏）", async () => {
    // 先创建一个 key
    const createRes = await app.inject({
      method: "POST",
      url: "/api/auth/keys",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "list-test", role: "viewer" },
    });
    testKey = JSON.parse(createRes.body).key;

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/keys",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.keys).toBeInstanceOf(Array);
    // key 应该被脱敏 (前8位 + ...)
    const found = body.keys.find((k: any) => k.name === "list-test");
    expect(found).toBeTruthy();
    expect(found.key).not.toBe(testKey); // 脱敏后不等于原始 key
    expect(found.key).toMatch(/\.\.\.$/);
  });

  it("DELETE /keys/:key 撤销 API Key 成功", async () => {
    // 先创建
    const createRes = await app.inject({
      method: "POST",
      url: "/api/auth/keys",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "to-revoke", role: "operator" },
    });
    const keyToRevoke = JSON.parse(createRes.body).key;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/auth/keys/${keyToRevoke}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("revoked");

    // 撤销后不能再用于认证
    const authRes = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { "x-api-key": keyToRevoke },
    });
    expect(authRes.statusCode).toBe(401);
  });

  it("DELETE /keys/:key 不存在返回 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/auth/keys/sk-nonexistentkey123",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── API Key 认证方式 ────────────────────────────────────

  it("API Key 可替代 JWT 进行认证", async () => {
    // 创建一个 API key
    const createRes = await app.inject({
      method: "POST",
      url: "/api/auth/keys",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "key-auth-test", role: "admin" },
    });
    const apiKey = JSON.parse(createRes.body).key;

    // 使用 API key 访问 /me
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { "x-api-key": apiKey },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe("key-auth-test");
  });
});
