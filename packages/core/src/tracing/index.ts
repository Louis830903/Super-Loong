/**
 * Tracing Module — 全链路追踪公开接口
 *
 * 统一导出追踪模块的所有公开 API
 */

// 核心 Tracer
export {
  runInContext,
  currentTrace,
  currentSpanId,
  currentTraceId,
  startSpan,
  withSpan,
  withSpanSync,
  endSpan,
  addSpanEvent,
  onSpan,
  offSpan,
  isTracingEnabled,
  setTracingEnabled,
  createRootContext,
} from "./tracer.js";

// 类型定义
export type { Span, SpanEvent, TraceContext, SpanStatus, SpanCallback } from "./types.js";
export { SpanOperations } from "./types.js";

// 存储层
export { initTraceStore, getTraceSpans, getRecentTraces, closeTraceStore } from "./store.js";
export type { TraceListItem } from "./store.js";

// 非侵入埋点工具
export {
  instrumentRuntime,
  instrumentLLM,
  instrumentSecurity,
  instrumentMemory,
  instrumentPrompt,
  traceToolExec,
} from "./instrument.js";
