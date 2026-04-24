/**
 * Tracer — 轻量级全链路追踪引擎
 *
 * 基于 Node.js AsyncLocalStorage 实现自动上下文传播，
 * 无需显式传参即可在异步调用链中保持 traceId/spanId 关联。
 *
 * 设计原则：
 * - ENABLE_TRACING=true 时启用，否则所有方法为空操作（零开销）
 * - 不依赖任何外部追踪 SDK，自包含实现
 * - 通过 onSpan 回调将完成的 Span 推送给存储层和监控层
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { v4 as uuid } from "uuid";
import type { Span, SpanStatus, SpanCallback, TraceContext, SpanEvent } from "./types.js";

/** 追踪功能是否启用（运行时可通过 setTracingEnabled 动态切换） */
let enabled = process.env.ENABLE_TRACING === "true";

/** AsyncLocalStorage 存储当前追踪上下文 */
const asyncStore = new AsyncLocalStorage<TraceContext>();

/** 活跃的 Span 集合（spanId → Span） */
const activeSpans = new Map<string, Span>();

/** Span 完成回调列表 */
const spanCallbacks: SpanCallback[] = [];

/**
 * 在指定追踪上下文中运行异步函数
 * 所有在 fn 内部的异步操作都会继承该上下文
 */
export function runInContext<T>(ctx: TraceContext, fn: () => T): T {
  if (!enabled) return fn();
  return asyncStore.run(ctx, fn);
}

/**
 * 获取当前追踪上下文（从 AsyncLocalStorage 中读取）
 * 如果没有活跃上下文则返回 undefined
 */
export function currentTrace(): TraceContext | undefined {
  if (!enabled) return undefined;
  return asyncStore.getStore();
}

/**
 * 获取当前活跃的 spanId
 */
export function currentSpanId(): string | undefined {
  return currentTrace()?.spanId;
}

/**
 * 获取当前 traceId
 */
export function currentTraceId(): string | undefined {
  return currentTrace()?.traceId;
}

/**
 * 开始一个新的 Span
 *
 * 自动挂到当前上下文的父 Span 下；如果没有父上下文则成为根 Span。
 * 返回创建的 Span 对象。
 */
export function startSpan(operation: string, attributes: Record<string, unknown> = {}): Span | null {
  if (!enabled) return null;

  const parentCtx = asyncStore.getStore();
  const traceId = parentCtx?.traceId || uuid();
  const spanId = uuid();
  const parentSpanId = parentCtx?.spanId;

  const span: Span = {
    traceId,
    spanId,
    parentSpanId,
    operation,
    startTime: Date.now(),
    status: "running",
    attributes,
    events: [],
  };

  activeSpans.set(spanId, span);

  // 更新 AsyncLocalStorage 中的当前 spanId
  // 注意：这不会改变已经在运行的父上下文
  const store = asyncStore.getStore();
  if (store) {
    // 通过修改引用来更新当前 spanId（非理想但轻量）
    // 实际上我们需要在 wrap 中使用新上下文
  }

  return span;
}

/**
 * 在新的 Span 上下文中执行异步函数
 * 推荐使用此方法替代手动 startSpan + endSpan
 */
export async function withSpan<T>(
  operation: string,
  attributes: Record<string, unknown>,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!enabled) return fn();

  const parentCtx = asyncStore.getStore();
  const traceId = parentCtx?.traceId || uuid();
  const spanId = uuid();
  const parentSpanId = parentCtx?.spanId;

  const span: Span = {
    traceId,
    spanId,
    parentSpanId,
    operation,
    startTime: Date.now(),
    status: "running",
    attributes,
    events: [],
  };

  activeSpans.set(spanId, span);

  const childCtx: TraceContext = { traceId, spanId };

  try {
    const result = await asyncStore.run(childCtx, fn);
    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.status = "ok";
    activeSpans.delete(spanId);
    notifySpanComplete(span);
    return result;
  } catch (err) {
    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.status = "error";
    span.attributes["error"] = err instanceof Error ? err.message : String(err);
    activeSpans.delete(spanId);
    notifySpanComplete(span);
    throw err;
  }
}

/**
 * 同步版本的 withSpan（用于不需要 async 的场景）
 */
export function withSpanSync<T>(
  operation: string,
  attributes: Record<string, unknown>,
  fn: () => T,
): T {
  if (!enabled) return fn();

  const parentCtx = asyncStore.getStore();
  const traceId = parentCtx?.traceId || uuid();
  const spanId = uuid();
  const parentSpanId = parentCtx?.spanId;

  const span: Span = {
    traceId,
    spanId,
    parentSpanId,
    operation,
    startTime: Date.now(),
    status: "running",
    attributes,
    events: [],
  };

  activeSpans.set(spanId, span);

  const childCtx: TraceContext = { traceId, spanId };

  try {
    const result = asyncStore.run(childCtx, fn);
    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.status = "ok";
    activeSpans.delete(spanId);
    notifySpanComplete(span);
    return result;
  } catch (err) {
    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.status = "error";
    span.attributes["error"] = err instanceof Error ? err.message : String(err);
    activeSpans.delete(spanId);
    notifySpanComplete(span);
    throw err;
  }
}

/**
 * 手动结束一个 Span（用于无法使用 withSpan 的场景）
 */
export function endSpan(spanId: string, status: SpanStatus = "ok", attrs?: Record<string, unknown>): void {
  if (!enabled) return;

  const span = activeSpans.get(spanId);
  if (!span) return;

  span.endTime = Date.now();
  span.duration = span.endTime - span.startTime;
  span.status = status;
  if (attrs) Object.assign(span.attributes, attrs);

  activeSpans.delete(spanId);
  notifySpanComplete(span);
}

/**
 * 为当前活跃的 Span 添加事件
 */
export function addSpanEvent(spanId: string, name: string, data?: Record<string, unknown>): void {
  if (!enabled) return;
  const span = activeSpans.get(spanId);
  if (!span) return;
  const evt: SpanEvent = { name, time: Date.now(), data };
  span.events.push(evt);
}

/**
 * 注册 Span 完成回调
 * 用于将完成的 Span 推送到存储层、日志系统或 SSE 广播
 */
export function onSpan(callback: SpanCallback): void {
  spanCallbacks.push(callback);
}

/**
 * 移除 Span 完成回调
 */
export function offSpan(callback: SpanCallback): void {
  const idx = spanCallbacks.indexOf(callback);
  if (idx >= 0) spanCallbacks.splice(idx, 1);
}

/** 通知所有回调 Span 已完成 */
function notifySpanComplete(span: Span): void {
  for (const cb of spanCallbacks) {
    try {
      cb(span);
    } catch {
      // 回调错误不应影响主流程
    }
  }
}

/**
 * 获取追踪是否启用
 */
export function isTracingEnabled(): boolean {
  return enabled;
}

/**
 * 动态设置追踪开关（运行时切换，无需重启）
 * 同步更新 process.env 以便其他模块读取一致状态
 */
export function setTracingEnabled(value: boolean): void {
  enabled = value;
  process.env.ENABLE_TRACING = value ? "true" : "false";
}

/**
 * 创建一个新的根追踪上下文（用于 HTTP 入口或 WS 消息入口）
 */
export function createRootContext(traceId?: string): TraceContext {
  return {
    traceId: traceId || uuid(),
    spanId: uuid(),
  };
}
