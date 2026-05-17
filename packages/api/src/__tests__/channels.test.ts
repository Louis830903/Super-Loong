/**
 * 渠道管理路由集成测试（channels.test.ts）
 *
 * 覆盖：
 *   GET  /api/channels          — 渠道列表（空列表 + 含数据）
 *   GET  /api/channels/:id      — 渠道详情（正常 + 404）
 *   POST /api/channels          — 创建渠道（正常 + 非法配置 400）
 *   DELETE /api/channels/:id    — 删除（正常 + 404）
 *   GET  /api/system/health     — 系统健康检查
 *   GET  /api/ping              — 轻量 ping
 *
 * Mock 策略：🟢 低依赖。渠道 CRUD 使用模块级 Map，不依赖 ctx。
 *   health 端点使用 ctx.agentManager + ctx.skillLoader，需简单 mock。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import type { AppContext } from "../context.js";
import { channelRoutes } from "../routes/channels.js";
import { MockAgentManager } from "./test-helpers.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });

  const mockSkillLoader = {
    listSkills: () => [],
    loadAll: () => {},
    startWatching: () => {},
  };

  const ctx = {
    agentManager: new MockAgentManager(),
    skillLoader: mockSkillLoader,
    router: {
      getDefaultAgentId: () => null,
      listBindings: () => [],
      addBinding: () => {},
      removeBinding: () => {},
    },
  } as unknown as AppContext;

  await channelRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// ─── Ping ────────────────────────────────────────────

describe("GET /api/ping", () => {
  it("返回 ok 状态", async () => {
    const res = await app.inject({ method: "GET", url: "/api/ping" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("ok");
  });
});

// ─── 系统健康检查 ────────────────────────────────────

describe("GET /api/system/health", () => {
  it("返回 ok 状态含 agents/skills/channels/uptime 字段", async () => {
    const res = await app.inject({ method: "GET", url: "/api/system/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("ok");
    expect(typeof body.data.channels).toBe("number");
    expect(typeof body.data.sessions).toBe("number");
    expect(typeof body.data.uptime).toBe("number");
  });
});

// ─── 渠道列表 ────────────────────────────────────────

describe("GET /api/channels", () => {
  it("初始空列表", async () => {
    const res = await app.inject({ method: "GET", url: "/api/channels" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.channels)).toBe(true);
  });
});

// ─── 创建渠道 ────────────────────────────────────────

describe("POST /api/channels", () => {
  it("创建飞书渠道成功", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/channels",
      payload: {
        platform: "feishu",
        enabled: true,
        credentials: { appId: "test-app-id", appSecret: "test-secret" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.channel.id).toMatch(/^ch_/);
    expect(body.data.channel.status).toBe("configuring");
  });

  it("非法配置返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/channels",
      payload: { invalid: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
  });
});

// ─── 渠道详情 ────────────────────────────────────────

describe("GET /api/channels/:id", () => {
  it("存在时返回渠道详情", async () => {
    // 先创建一个渠道
    const createRes = await app.inject({
      method: "POST",
      url: "/api/channels",
      payload: { platform: "dingtalk", enabled: true, credentials: { appKey: "key1", appSecret: "sec1" } },
    });
    const id = createRes.json().data.channel.id;

    const res = await app.inject({ method: "GET", url: `/api/channels/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.channel.id).toBe(id);
  });

  it("不存在时返回 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/channels/nonexistent" });
    expect(res.statusCode).toBe(404);
    expect(res.json().success).toBe(false);
  });
});

// ─── 删除渠道 ────────────────────────────────────────

describe("DELETE /api/channels/:id", () => {
  it("删除成功", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/channels",
      payload: { platform: "wecom", enabled: true, credentials: { corpId: "corp1" } },
    });
    const id = createRes.json().data.channel.id;

    const res = await app.inject({ method: "DELETE", url: `/api/channels/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.success).toBe(true);

    // 再次查询应 404
    const getRes = await app.inject({ method: "GET", url: `/api/channels/${id}` });
    expect(getRes.statusCode).toBe(404);
  });

  it("不存在 ID 返回 404", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/channels/nonexistent" });
    expect(res.statusCode).toBe(404);
  });
});
