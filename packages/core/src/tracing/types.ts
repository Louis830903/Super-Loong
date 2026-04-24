/**
 * Tracing Types — 全链路追踪数据结构定义
 *
 * 定义 Span、SpanEvent、TraceContext 等核心类型，
 * 用于贯穿 API→Agent→Prompt→LLM→Tool→Security 的完整调用链追踪。
 */

/** Span 状态枚举 */
export type SpanStatus = "running" | "ok" | "error";

/** Span 内的时间线事件 */
export interface SpanEvent {
  /** 事件名称 */
  name: string;
  /** 事件发生时间（高精度 ms） */
  time: number;
  /** 附加数据 */
  data?: Record<string, unknown>;
}

/** 单个操作的追踪记录 */
export interface Span {
  /** 贯穿整个请求的唯一 ID（所有子 Span 共享） */
  traceId: string;
  /** 当前操作的唯一 ID */
  spanId: string;
  /** 父操作 ID（根 Span 无此字段） */
  parentSpanId?: string;
  /** 操作名称，格式: "category.action" */
  operation: string;
  /** 操作开始时间（performance.now() 或 Date.now()） */
  startTime: number;
  /** 操作结束时间 */
  endTime?: number;
  /** 操作耗时（ms），endTime - startTime */
  duration?: number;
  /** 当前状态 */
  status: SpanStatus;
  /** 附加属性（agentId, model, toolName 等） */
  attributes: Record<string, unknown>;
  /** 时间线事件列表 */
  events: SpanEvent[];
}

/** 在 AsyncLocalStorage 中传播的追踪上下文 */
export interface TraceContext {
  /** 当前 Trace 的根 ID */
  traceId: string;
  /** 当前活跃的 Span ID */
  spanId: string;
}

/** Span 完成时的回调类型 */
export type SpanCallback = (span: Span) => void;

/** 预定义的操作类型常量 */
export const SpanOperations = {
  HTTP_REQUEST: "http.request",
  WS_MESSAGE: "ws.message",
  AGENT_CHAT: "agent.chat",
  AGENT_STREAM: "agent.stream",
  PROMPT_BUILD: "prompt.build",
  LLM_CALL: "llm.call",
  TOOL_EXEC: "tool.exec",
  SECURITY_CHECK: "security.check",
  MEMORY_READ: "memory.read",
  MEMORY_WRITE: "memory.write",
  APPROVAL_CHECK: "approval.check",
} as const;
