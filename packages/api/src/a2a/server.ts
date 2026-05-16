/**
 * A2A Fastify Server Plugin
 *
 * 按 A2A v1.0 协议暴露以下端点：
 * - GET  /.well-known/agent-card.json → 公开 Agent Card + ETag + 304
 * - POST /a2a                         → JSON-RPC 分发（SendMessage / GetTask / ListTasks / CancelTask / GetExtendedAgentCard）
 * - POST /a2a/stream                  → SSE 流式（SendStreamingMessage）
 * - Bearer Token 校验中间件（process.env.A2A_TOKEN）
 *
 * 注意：well-known 端点在 index.ts 中根级注册（绕过前缀），
 * 本 Plugin 仅注册 /a2a 和 /a2a/stream。
 *
 * @see a2a-types.ts — 类型定义
 * @see a2a-spec.md — 协议规范
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import pino from "pino";
import {
  type A2AAgentCard,
  type JsonRpcRequest,
  type JsonRpcErrorResponse,
  type SendMessageRequest,
  type TaskFilter,
  type TaskStore,
  type IAgentRegistry,
  type PushNotificationDispatcher,
  A2A_ERROR_CODES,
  TaskState,
  InvalidTransitionError,
  TaskNotFoundError,
  runInContext,
  createRootContext,
  verifyA2AMessage,
  type A2AMessage,
} from "@super-agent/core";

// ─── 日志 ───────────────────────────────────────────────────

const logger = pino({ name: "A2AServer" });

// ─── Token 安全比较（P1-1 修复） ────────────────────────────────

/**
 * 防时序侧信道的 Token 比较。
 * 内部处理 null/undefined，避免 well-known 路由未配置 A2A_TOKEN 时 crash。
 */
function safeCompareTokens(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ─── Plugin 配置 ────────────────────────────────────────────

export interface A2APluginOptions {
  /** Agent Card 提供器（返回公开 / 扩展版） */
  getAgentCard: (extended?: boolean) => A2AAgentCard;
  /** Task 状态机存储 */
  taskStore: TaskStore;
  /** Agent 注册表（可选） */
  registry?: IAgentRegistry;
  /** Push 分发器（可选） */
  pushDispatcher?: PushNotificationDispatcher;
  /** 处理 SendMessage 的业务逻辑回调 */
  onSendMessage: (request: SendMessageRequest) => Promise<unknown>;
  /** 处理 SendStreamingMessage 的业务逻辑回调（流式） */
  onStreamMessage?: (
    request: SendMessageRequest,
    write: (frame: string) => void,
  ) => Promise<void>;
}

// ─── JSON-RPC 辅助 ──────────────────────────────────────────

/** 构建 JSON-RPC 成功响应 */
const rpcOk = (id: string | number, result: unknown) => ({
  jsonrpc: "2.0" as const,
  id,
  result,
});

/** 构建 JSON-RPC 错误响应 */
const rpcErr = (id: string | number | null, code: number, message: string, data?: unknown): JsonRpcErrorResponse => ({
  jsonrpc: "2.0",
  id: id ?? 0,
  error: { code, message, ...(data !== undefined && { data }) },
});

// ─── Well-Known 路由（独立函数，在 index.ts 根级注册） ─────

/**
 * 注册 GET /.well-known/agent-card.json 端点。
 * 此函数需在 Fastify 根级调用（避免 plugin prefix 干扰）。
 */
export async function registerWellKnownRoute(
  app: FastifyInstance,
  getAgentCard: (extended?: boolean) => A2AAgentCard,
): Promise<void> {
  app.get("/.well-known/agent-card.json", async (request: FastifyRequest, reply: FastifyReply) => {
    // 检查是否有 Bearer Token → 返回扩展 Card
    const authHeader = request.headers.authorization;
    const hasValidToken = authHeader?.startsWith("Bearer ") && safeCompareTokens(authHeader.slice(7), process.env.A2A_TOKEN);

    const card = getAgentCard(!!hasValidToken);

    // 计算 ETag（基于 card JSON 的 MD5）
    const cardJson = JSON.stringify(card);
    const etag = `"${createHash("md5").update(cardJson).digest("hex")}"`;

    // 304 Not Modified
    if (request.headers["if-none-match"] === etag) {
      return reply.code(304).send();
    }

    return reply
      .header("Content-Type", "application/json")
      .header("Cache-Control", "public, max-age=300")
      .header("ETag", etag)
      .send(card);
  });
}

// ─── A2A Plugin（/a2a 路径下的 JSON-RPC 端点） ─────────────

/**
 * A2A Fastify Plugin：注册 POST /a2a 和 POST /a2a/stream。
 */
export async function a2aPlugin(app: FastifyInstance, opts: A2APluginOptions): Promise<void> {
  const { taskStore, onSendMessage, onStreamMessage } = opts;
  const a2aToken = process.env.A2A_TOKEN;

  // ─── Bearer Token 校验钩子 ────────────────────────────────

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    // 仅校验 /a2a 路径下的请求
    if (!a2aToken) return; // 未配置则跳过认证（开发模式）

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ") || !safeCompareTokens(authHeader.slice(7), a2aToken)) {
      return reply
        .code(401)
        .send(rpcErr(null, A2A_ERROR_CODES.UNAUTHORIZED, "Unauthorized: invalid or missing A2A token"));
    }
  });

  // ─── POST /a2a — JSON-RPC 分发 ───────────────────────────

  app.post("/a2a", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as JsonRpcRequest | undefined;

    // 基础校验
    if (!body || body.jsonrpc !== "2.0" || !body.method) {
      return reply.code(400).send(
        rpcErr(body?.id ?? null, A2A_ERROR_CODES.INVALID_REQUEST, "Invalid JSON-RPC 2.0 request"),
      );
    }

    // 跨进程 Trace 还原：从 HTTP 头提取 traceId 并注入 AsyncLocalStorage
    const incomingTraceId = request.headers["x-a2a-trace-id"] as string | undefined;

    try {
      const result = await runInContext(
        createRootContext(incomingTraceId ?? randomUUID()),
        () => dispatchRpc(body, taskStore, onSendMessage, reply),
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send(
        rpcErr(body.id, -32603, `Internal error: ${msg}`),
      );
    }
  });

  // ─── POST /a2a/stream — SSE 流式 ─────────────────────────

  if (onStreamMessage) {
    app.post("/a2a/stream", async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as JsonRpcRequest | undefined;

      if (!body || body.jsonrpc !== "2.0" || body.method !== "SendStreamingMessage") {
        return reply.code(400).send(
          rpcErr(body?.id ?? null, A2A_ERROR_CODES.INVALID_REQUEST, "Expected SendStreamingMessage"),
        );
      }

      const params = body.params as SendMessageRequest;

      // P1-5修复：运行时校验 SendMessageRequest 结构
      if (!validateSendMessageParams(params)) {
        return reply.code(400).send(
          rpcErr(body.id, A2A_ERROR_CODES.INVALID_REQUEST,
            "Invalid SendMessageRequest: missing or malformed message/parts/role"),
        );
      }

      // protocolVersion 协商检查
      if (params.protocolVersion && !params.protocolVersion.startsWith("0.3")) {
        return reply.code(400).send(
          rpcErr(body.id, A2A_ERROR_CODES.PROTOCOL_VERSION_MISMATCH, `Unsupported protocol version: ${params.protocolVersion}`),
        );
      }

      // 跨进程 Trace 还原
      const incomingTraceId = request.headers["x-a2a-trace-id"] as string | undefined;

      // SSE：手动写入 HTTP 头并接管原始连接
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // nginx 不缓冲
      });

      const write = (frame: string) => {
        reply.raw.write(`data: ${frame}\n\n`);
      };

      try {
        await runInContext(
          createRootContext(incomingTraceId ?? randomUUID()),
          () => onStreamMessage(params, write),
        );

        // 发送 done 帧并结束连接
        write(JSON.stringify({ type: "done", taskId: (params.message as any)?.taskId ?? "" }));
        reply.raw.end();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        write(JSON.stringify({ type: "error", error: msg }));
        reply.raw.end();
      }
    });
  }
}

// ─── SendMessage 参数校验（P1-5 修复） ──────────────────────

/**
 * 运行时校验 SendMessageRequest 结构，防止恶意/空请求导致后续解引用 crash。
 * 校验 message 存在、parts 为数组、role 为字符串。
 */
function validateSendMessageParams(params: unknown): params is SendMessageRequest {
  if (!params || typeof params !== "object") return false;
  const p = params as Record<string, unknown>;
  if (!p.message || typeof p.message !== "object") return false;
  const msg = p.message as Record<string, unknown>;
  return Array.isArray(msg.parts) && typeof msg.role === "string";
}

// ─── RPC 方法分发 ───────────────────────────────────────────

/**
 * JSON-RPC 方法路由：根据 method 字段分发到对应处理函数。
 */
async function dispatchRpc(
  rpc: JsonRpcRequest,
  taskStore: TaskStore,
  onSendMessage: (request: SendMessageRequest) => Promise<unknown>,
  reply: FastifyReply,
): Promise<unknown> {
  const params = rpc.params as Record<string, unknown> | undefined;

  switch (rpc.method) {
    // ── SendMessage ──────────────────────────────────────────
    case "SendMessage": {
      if (!params) {
        return reply.send(rpcErr(rpc.id, A2A_ERROR_CODES.INVALID_REQUEST, "Missing params"));
      }
      // P1-5修复：运行时校验 SendMessageRequest 结构
      if (!validateSendMessageParams(params)) {
        return reply.send(rpcErr(rpc.id, A2A_ERROR_CODES.INVALID_REQUEST,
          "Invalid SendMessageRequest: missing or malformed message/parts/role"));
      }
      // P0 安全加固：HMAC-SHA256 签名校验（防篡改，向后兼容旧客户端）
      if (process.env.A2A_TOKEN) {
        const msg = (params as SendMessageRequest).message as A2AMessage & { timestamp?: number; nonce?: string; signature?: string };
        const verifyResult = verifyA2AMessage(msg, process.env.A2A_TOKEN);
        if (!verifyResult.valid) {
          return reply.send(rpcErr(rpc.id, A2A_ERROR_CODES.UNAUTHORIZED, `消息签名校验失败: ${verifyResult.reason}`));
        }
        if (verifyResult.degraded) {
          logger.warn({ messageId: msg.messageId }, "A2A 消息未携带签名（旧客户端），降级为无签名模式");
        }
      }
      // protocolVersion 协商
      const pv = (params as unknown as SendMessageRequest).protocolVersion;
      if (pv && !pv.startsWith("0.3")) {
        return reply.send(
          rpcErr(rpc.id, A2A_ERROR_CODES.PROTOCOL_VERSION_MISMATCH, `Unsupported: ${pv}`),
        );
      }
      const result = await onSendMessage(params as unknown as SendMessageRequest);
      return reply.send(rpcOk(rpc.id, result));
    }

    // ── GetTask ──────────────────────────────────────────────
    case "GetTask": {
      const taskId = params?.taskId as string | undefined;
      if (!taskId) {
        return reply.send(rpcErr(rpc.id, A2A_ERROR_CODES.INVALID_REQUEST, "Missing taskId"));
      }
      const task = taskStore.getTask(taskId);
      if (!task) {
        return reply.send(rpcErr(rpc.id, A2A_ERROR_CODES.TASK_NOT_FOUND, `Task not found: ${taskId}`));
      }
      return reply.send(rpcOk(rpc.id, task));
    }

    // ── ListTasks ────────────────────────────────────────────
    case "ListTasks": {
      const filter = (params ?? {}) as TaskFilter;
      // P1-4修复：强制 limit 上限防止恶意请求耗尽内存
      filter.limit = Math.min(filter.limit ?? 100, 500);
      const tasks = taskStore.listTasks(filter);
      return reply.send(rpcOk(rpc.id, tasks));
    }

    // ── CancelTask ───────────────────────────────────────────
    case "CancelTask": {
      const taskId = params?.taskId as string | undefined;
      if (!taskId) {
        return reply.send(rpcErr(rpc.id, A2A_ERROR_CODES.INVALID_REQUEST, "Missing taskId"));
      }
      try {
        const task = taskStore.transition(taskId, TaskState.CANCELED);
        return reply.send(rpcOk(rpc.id, task));
      } catch (err) {
        // P1-3修复：区分 TaskNotFoundError 和 InvalidTransitionError
        if (err instanceof TaskNotFoundError) {
          return reply.send(rpcErr(rpc.id, A2A_ERROR_CODES.TASK_NOT_FOUND, err.message));
        }
        if (err instanceof InvalidTransitionError) {
          return reply.send(rpcErr(rpc.id, A2A_ERROR_CODES.INVALID_REQUEST, err.message));
        }
        const msg = err instanceof Error ? err.message : String(err);
        return reply.send(rpcErr(rpc.id, A2A_ERROR_CODES.TASK_NOT_FOUND, msg));
      }
    }

    // ── GetExtendedAgentCard ─────────────────────────────────
    case "GetExtendedAgentCard": {
      // 由 well-known 端点处理（带 auth 返回扩展字段）
      return reply.send(rpcErr(rpc.id, A2A_ERROR_CODES.METHOD_NOT_FOUND,
        "Use GET /.well-known/agent-card.json with Bearer token for extended card"));
    }

    // ── 未知方法 ─────────────────────────────────────────────
    default:
      return reply.send(rpcErr(rpc.id, A2A_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${rpc.method}`));
  }
}
