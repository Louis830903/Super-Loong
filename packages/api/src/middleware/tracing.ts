/**
 * Tracing Middleware — HTTP 请求自动追踪
 *
 * 为每个进入的 HTTP 请求创建根 Span，在响应完成时自动结束。
 * 通过 AsyncLocalStorage 传播 TraceContext，使下游所有操作自动关联。
 *
 * 仅在 ENABLE_TRACING=true 时激活，否则完全跳过（零开销）。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  runInContext,
  createRootContext,
  startSpan,
  endSpan,
  SpanOperations,
  isTracingEnabled,
  initTraceStore,
  onSpan,
} from "@super-agent/core";
import type { Span } from "@super-agent/core";
import pino from "pino";

const logger = pino({ name: "tracing-middleware" });

/** 存储请求对应的 spanId，用于 onResponse 时结束 */
const requestSpanMap = new WeakMap<FastifyRequest, string>();

/**
 * 注册追踪中间件
 * 放在 registerRequestId 之后调用
 *
 * 始终注册 hooks（禁用时 startSpan 返回 null，自动跳过，零开销）
 * 这样运行时通过 setTracingEnabled 开启后立即生效
 */
export async function registerTracing(app: FastifyInstance): Promise<void> {
  // 初始化 SQLite 存储（幂等，内部有 initialized 守卫）
  initTraceStore();

  // 注册 Span 完成回调：将 Span 以特殊 JSON 写入 stdout（供 log-monitor 捕获）
  onSpan((span: Span) => {
    const output = JSON.stringify({
      _type: "span",
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      operation: span.operation,
      startTime: span.startTime,
      endTime: span.endTime,
      duration: span.duration,
      status: span.status,
      attributes: span.attributes,
      events: span.events,
    });
    process.stdout.write(output + "\n");
  });

  // onRequest: 为每个 HTTP 请求创建根追踪上下文和 Span
  app.addHook("onRequest", (request: FastifyRequest, _reply: FastifyReply, done) => {
    const traceId = (request as any).requestId || (request.headers["x-request-id"] as string);
    const ctx = createRootContext(traceId);

    runInContext(ctx, () => {
      const span = startSpan(SpanOperations.HTTP_REQUEST, {
        method: request.method,
        url: request.url,
        ip: request.ip,
        userAgent: request.headers["user-agent"] || "",
      });

      if (span) {
        requestSpanMap.set(request, span.spanId);
      }

      done();
    });
  });

  // onResponse: 结束根 Span
  app.addHook("onResponse", (request: FastifyRequest, reply: FastifyReply, done) => {
    const spanId = requestSpanMap.get(request);
    if (spanId) {
      const status = reply.statusCode < 400 ? "ok" : "error";
      endSpan(spanId, status, {
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      });
      requestSpanMap.delete(request);
    }
    done();
  });
}
