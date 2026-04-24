/**
 * Traces API — 全链路追踪查询接口
 *
 * 提供 REST API 和 SSE 实时推送，供前端监控面板展示追踪数据。
 *
 * 端点:
 * - GET  /api/traces          — 查询最近的 Trace 列表（分页）
 * - GET  /api/traces/live     — SSE 实时推送新完成的 Span
 * - GET  /api/traces/:traceId — 获取单条 Trace 的完整 Span 树
 * - POST /api/traces/toggle   — 动态开关追踪（运行时切换，无需重启）
 */

import type { FastifyInstance } from "fastify";
import {
  getRecentTraces,
  getTraceSpans,
  onSpan,
  offSpan,
  isTracingEnabled,
  setTracingEnabled,
  initTraceStore,
} from "@super-agent/core";
import type { Span } from "@super-agent/core";

export async function registerTracesRoutes(app: FastifyInstance): Promise<void> {

  /**
   * POST /api/traces/toggle — 动态开关追踪
   * Body: { enabled: boolean }
   * 返回: { enabled: boolean, message: string }
   */
  app.post<{ Body: { enabled?: boolean } }>("/api/traces/toggle", async (request, reply) => {
    const body = request.body as { enabled?: boolean } | undefined;
    if (body?.enabled === undefined || typeof body.enabled !== "boolean") {
      return reply.status(400).send({ error: "body.enabled is required (boolean)" });
    }

    setTracingEnabled(body.enabled);

    // 开启时确保存储已初始化
    if (body.enabled) {
      initTraceStore();
    }

    app.log.info(`Tracing toggled: ${body.enabled ? "ON" : "OFF"}`);
    return reply.send({
      enabled: body.enabled,
      message: body.enabled ? "追踪已开启，新请求将被自动追踪" : "追踪已关闭",
    });
  });

  /**
   * GET /api/traces — 查询最近的 Trace 列表
   * Query: limit (default 50), offset (default 0)
   */
  app.get<{
    Querystring: { limit?: string; offset?: string };
  }>("/api/traces", async (request, reply) => {
    if (!isTracingEnabled()) {
      return reply.send({ enabled: false, traces: [], pagination: { limit: 50, offset: 0, count: 0 } });
    }
    const limit = Math.min(parseInt(request.query.limit || "50", 10), 200);
    const offset = parseInt(request.query.offset || "0", 10);
    const traces = getRecentTraces(limit, offset);
    return reply.send({ enabled: true, traces, pagination: { limit, offset, count: traces.length } });
  });

  /**
   * GET /api/traces/live — SSE 实时推送新完成的 Span
   * 客户端通过 EventSource 连接，接收实时 Span 数据
   */
  app.get("/api/traces/live", async (request, reply) => {
    // 设置 SSE 响应头
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // 发送初始连接确认（含当前追踪状态）
    reply.raw.write(`data: ${JSON.stringify({ type: "connected", enabled: isTracingEnabled(), time: Date.now() })}\n\n`);

    // 注册 Span 回调（仅当追踪启用时会触发）
    const handler = (span: Span) => {
      try {
        const data = JSON.stringify({
          type: "span",
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          operation: span.operation,
          startTime: span.startTime,
          endTime: span.endTime,
          duration: span.duration,
          status: span.status,
          attributes: span.attributes,
        });
        reply.raw.write(`data: ${data}\n\n`);
      } catch {
        // 写入失败（连接已断开），忽略
      }
    };

    onSpan(handler);

    // 保持心跳
    const heartbeat = setInterval(() => {
      try {
        // 心跳中携带当前追踪状态，前端可据此更新开关 UI
        reply.raw.write(`data: ${JSON.stringify({ type: "heartbeat", enabled: isTracingEnabled(), time: Date.now() })}\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);

    // 清理：客户端断开时移除回调
    request.raw.on("close", () => {
      offSpan(handler);
      clearInterval(heartbeat);
    });
  });

  /**
   * GET /api/traces/:traceId — 获取单条 Trace 的完整 Span 树
   */
  app.get<{
    Params: { traceId: string };
  }>("/api/traces/:traceId", async (request, reply) => {
    if (!isTracingEnabled()) {
      return reply.send({ enabled: false, spans: [], message: "Tracing is disabled." });
    }
    const { traceId } = request.params;
    const spans = getTraceSpans(traceId);

    if (spans.length === 0) {
      return reply.status(404).send({ error: "Trace not found", traceId });
    }

    // 构建 Span 树结构
    const tree = buildSpanTree(spans);
    const rootSpan = spans[0];

    return reply.send({
      traceId,
      startTime: rootSpan?.startTime,
      endTime: spans[spans.length - 1]?.endTime,
      totalDuration: rootSpan ? (spans[spans.length - 1]?.endTime || Date.now()) - rootSpan.startTime : 0,
      spanCount: spans.length,
      spans,
      tree,
    });
  });

  app.log.info("Traces API registered: GET /api/traces, /api/traces/:traceId, /api/traces/live, POST /api/traces/toggle");
}

// ─── 辅助函数 ───────────────────────────────────────────────

interface SpanTreeNode {
  span: Span;
  children: SpanTreeNode[];
}

/**
 * 将扁平 Span 列表构建为树形结构
 */
function buildSpanTree(spans: Span[]): SpanTreeNode[] {
  const nodeMap = new Map<string, SpanTreeNode>();
  const roots: SpanTreeNode[] = [];

  // 创建所有节点
  for (const span of spans) {
    nodeMap.set(span.spanId, { span, children: [] });
  }

  // 构建父子关系
  for (const span of spans) {
    const node = nodeMap.get(span.spanId)!;
    if (span.parentSpanId && nodeMap.has(span.parentSpanId)) {
      nodeMap.get(span.parentSpanId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
