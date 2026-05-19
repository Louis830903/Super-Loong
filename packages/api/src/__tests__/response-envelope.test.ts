/**
 * v3 Task 3：响应壳 onSend hook 单元测试
 *
 * 测试矩阵：
 *   1. FEATURE_FLAG_RESP_ENVELOPE=false → 不包装
 *   2. FEATURE_FLAG_RESP_ENVELOPE=true：
 *      - 标准 JSON 200 → 包装 {success, data, traceId}
 *      - 4xx 响应 → 包装 {success:false, error}
 *      - 已带 success 字段（来自 sendSuccess） → 透传
 *      - JSON-RPC（jsonrpc 字段） → 透传
 *      - Buffer 二进制 → 不包装
 *      - SSE / stream 路径 → 不包装
 *      - /webhook/* → 不包装
 *      - 路由级 config.skipEnvelope → 不包装
 *      - 非 /api/* → 不包装
 *      - x-request-id 透传成 traceId
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { registerResponseEnvelope } from "../middleware/response-envelope.js";
import { sendSuccess, sendError } from "../routes/response-helper.js";

async function buildApp(envelope: boolean): Promise<FastifyInstance> {
  process.env.FEATURE_FLAG_RESP_ENVELOPE = envelope ? "true" : "false";
  const app = Fastify({ logger: false });

  // 模拟 registerRequestId hook：把 x-request-id 注入 request.requestId
  app.addHook("onRequest", async (req) => {
    (req as any).requestId = (req.headers["x-request-id"] as string) ?? "test-trace-id";
  });

  // 普通成功路由
  app.get("/api/items", async () => ({ count: 3, list: [1, 2, 3] }));

  // 4xx 路由（直接抛字符串错误）
  app.get("/api/notfound", async (_req, reply) => {
    return reply.status(404).send({ message: "missing" });
  });

  // 已经走 sendSuccess
  app.get("/api/wrapped", async (_req, reply) => sendSuccess(reply, { ok: 1 }));

  // 已经走 sendError
  app.get("/api/wrapped-err", async (_req, reply) =>
    sendError(reply, 400, "BAD_REQUEST", "bad input", undefined, true),
  );

  // JSON-RPC 路径
  app.get("/api/jsonrpc", async () => ({ jsonrpc: "2.0", id: 1, result: { ok: true } }));

  // Buffer 二进制
  app.get("/api/binary", async (_req, reply) => {
    reply.header("content-type", "application/octet-stream");
    return reply.send(Buffer.from([1, 2, 3]));
  });

  // SSE 路径（URL 含 /stream）
  app.get("/api/chat/stream", async (_req, reply) => ({ chunks: [] }));

  // Webhook 路径
  app.get("/webhook/feishu", async () => ({ challenge: "abc" }));

  // 非 API 路径
  app.get("/static/info", async () => ({ note: "static" }));

  // 路由级 skipEnvelope
  app.get(
    "/api/skip",
    { config: { skipEnvelope: true } },
    async () => ({ raw: true }),
  );

  await registerResponseEnvelope(app);
  await app.ready();
  return app;
}

describe("v3 Task 3: response-envelope onSend hook", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    delete process.env.FEATURE_FLAG_RESP_ENVELOPE;
  });

  describe("FEATURE_FLAG_RESP_ENVELOPE=false", () => {
    beforeEach(async () => {
      app = await buildApp(false);
    });

    it("不包装任何响应（保持现有行为）", async () => {
      const res = await app.inject({ method: "GET", url: "/api/items" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ count: 3, list: [1, 2, 3] });
    });
  });

  describe("FEATURE_FLAG_RESP_ENVELOPE=true", () => {
    beforeEach(async () => {
      app = await buildApp(true);
    });

    it("标准 JSON 200 → 包装为 {success, data, traceId}", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/items",
        headers: { "x-request-id": "trace-a" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data).toEqual({ count: 3, list: [1, 2, 3] });
      expect(body.traceId).toBe("trace-a");
    });

    it("4xx 响应 → 包装为 {success:false, error}", async () => {
      const res = await app.inject({ method: "GET", url: "/api/notfound" });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("CLIENT_ERROR_404");
      expect(body.error.message).toBe("missing");
    });

    it("已经走 sendSuccess 的响应 → 透传不二次包装", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/wrapped",
        headers: { "x-request-id": "trace-b" },
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data).toEqual({ ok: 1 });
      // traceId 由 response-helper 注入，不应有 data.data 嵌套
      expect((body as any).data?.data).toBeUndefined();
      expect(body.traceId).toBe("trace-b");
    });

    it("已经走 sendError 的响应 → 透传", async () => {
      const res = await app.inject({ method: "GET", url: "/api/wrapped-err" });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("BAD_REQUEST");
      expect((body as any).error?.error).toBeUndefined();
    });

    it("JSON-RPC 响应 → 透传不包装", async () => {
      const res = await app.inject({ method: "GET", url: "/api/jsonrpc" });
      const body = res.json();
      expect(body.jsonrpc).toBe("2.0");
      expect((body as any).success).toBeUndefined();
    });

    it("Buffer 二进制响应 → 不包装", async () => {
      const res = await app.inject({ method: "GET", url: "/api/binary" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/octet-stream");
      expect(res.rawPayload).toEqual(Buffer.from([1, 2, 3]));
    });

    it("SSE / stream 路径 → 不包装", async () => {
      const res = await app.inject({ method: "GET", url: "/api/chat/stream" });
      expect(res.json()).toEqual({ chunks: [] });
      expect((res.json() as any).success).toBeUndefined();
    });

    it("/webhook/* 路径 → 不包装（飞书 challenge 兼容）", async () => {
      const res = await app.inject({ method: "GET", url: "/webhook/feishu" });
      expect(res.json()).toEqual({ challenge: "abc" });
    });

    it("非 /api/* 路径 → 不包装", async () => {
      const res = await app.inject({ method: "GET", url: "/static/info" });
      expect(res.json()).toEqual({ note: "static" });
    });

    it("路由级 config.skipEnvelope=true → 不包装", async () => {
      const res = await app.inject({ method: "GET", url: "/api/skip" });
      expect(res.json()).toEqual({ raw: true });
    });
  });
});
