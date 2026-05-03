/**
 * Fastify 健康检查端点冒烟测试
 *
 * 验证 Fastify 实例创建、CORS 注册、JSON 序列化 三条基础链路。
 * 不测试完整启动流程（避免 GatewayLauncher 副作用），仅测试 app 核心。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";

describe("Fastify 健康检查", () => {
  const app = Fastify({ logger: false });

  beforeAll(async () => {
    await app.register(cors, { origin: ["http://localhost:3000"] });
    app.get("/api/health", async () => ({ status: "ok" }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/health 返回 200", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("未知路由返回 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/nonexistent" });
    expect(res.statusCode).toBe(404);
  });
});
