/**
 * Tracing Instrument — Agent Runtime 非侵入追踪埋点
 *
 * 通过方法包装（monkey-patch）为 AgentRuntime 的关键操作注入 Span，
 * 只在 ENABLE_TRACING=true 时生效，否则为空操作。
 *
 * 埋点覆盖：
 * - agent.chat / agent.stream 入口
 * - prompt.build 构建
 * - llm.call 模型调用
 * - tool.exec 工具执行
 * - security.check 安全检查
 * - memory.read/write 记忆操作
 */

import { withSpan, isTracingEnabled, currentTraceId } from "./tracer.js";
import { SpanOperations } from "./types.js";
import type { AgentRuntime } from "../agent/runtime.js";
import type { LLMProvider } from "../llm/provider.js";
import type { SecurityManager } from "../security/sandbox.js";
import type { MemoryManager } from "../memory/manager.js";
import type { PromptEngine } from "../prompt/engine.js";

/**
 * 为 AgentRuntime 实例注入全链路追踪
 * 非侵入：保留原始方法引用，包装后仍调用原始逻辑
 */
export function instrumentRuntime(runtime: AgentRuntime): void {
  if (!isTracingEnabled()) return;

  // 获取原型上的方法（chat 和 chatStream）
  const proto = Object.getPrototypeOf(runtime);

  // 包装 chat 方法
  const originalChat = proto.chat;
  if (originalChat && !((runtime as any).__traced_chat)) {
    const wrappedChat = function (this: AgentRuntime, ...args: any[]) {
      const message = args[0];
      const sessionId = args[1];
      return withSpan(SpanOperations.AGENT_CHAT, {
        agentId: this.id,
        sessionId: sessionId || "default",
        messageLength: typeof message === "string" ? message.length : 0,
      }, () => originalChat.apply(this, args));
    };
    (runtime as any).chat = wrappedChat;
    (runtime as any).__traced_chat = true;
  }

  // 包装 chatStream 方法
  const originalChatStream = proto.chatStream;
  if (originalChatStream && !((runtime as any).__traced_stream)) {
    const wrappedChatStream = function (this: AgentRuntime, ...args: any[]) {
      const message = args[0];
      const sessionId = args[1];
      return withSpan(SpanOperations.AGENT_STREAM, {
        agentId: this.id,
        sessionId: sessionId || "default",
        messageLength: typeof message === "string" ? message.length : 0,
      }, () => originalChatStream.apply(this, args));
    };
    (runtime as any).chatStream = wrappedChatStream;
    (runtime as any).__traced_stream = true;
  }
}

/**
 * 为 LLMProvider 注入追踪
 */
export function instrumentLLM(llm: LLMProvider): void {
  if (!isTracingEnabled()) return;
  if ((llm as any).__traced) return;

  const proto = Object.getPrototypeOf(llm);

  // 包装 complete / chat 方法
  const methodNames = ["complete", "chat", "chatCompletion"];
  for (const name of methodNames) {
    const original = proto[name] || (llm as any)[name];
    if (!original) continue;

    (llm as any)[name] = function (...args: any[]) {
      const config = (llm as any).config || {};
      return withSpan(SpanOperations.LLM_CALL, {
        model: config.model || "unknown",
        provider: config.provider || "unknown",
        traceId: currentTraceId(),
      }, () => original.apply(llm, args));
    };
  }

  (llm as any).__traced = true;
}

/**
 * 为 SecurityManager 注入追踪
 */
export function instrumentSecurity(security: SecurityManager): void {
  if (!isTracingEnabled()) return;
  if ((security as any).__traced) return;

  const proto = Object.getPrototypeOf(security);
  const originalCheck = proto.checkPermission || proto.check;
  if (originalCheck) {
    const methodName = proto.checkPermission ? "checkPermission" : "check";
    (security as any)[methodName] = function (...args: any[]) {
      return withSpan(SpanOperations.SECURITY_CHECK, {
        action: args[0] || "unknown",
        traceId: currentTraceId(),
      }, () => originalCheck.apply(security, args));
    };
  }

  (security as any).__traced = true;
}

/**
 * 为 MemoryManager 注入追踪
 */
export function instrumentMemory(memory: MemoryManager): void {
  if (!isTracingEnabled()) return;
  if ((memory as any).__traced) return;

  const proto = Object.getPrototypeOf(memory);

  // 读操作
  const readMethods = ["search", "recall", "get", "query"];
  for (const name of readMethods) {
    const original = proto[name] || (memory as any)[name];
    if (!original) continue;
    (memory as any)[name] = function (...args: any[]) {
      return withSpan(SpanOperations.MEMORY_READ, {
        operation: name,
        traceId: currentTraceId(),
      }, () => original.apply(memory, args));
    };
  }

  // 写操作
  const writeMethods = ["store", "save", "update", "delete", "add"];
  for (const name of writeMethods) {
    const original = proto[name] || (memory as any)[name];
    if (!original) continue;
    (memory as any)[name] = function (...args: any[]) {
      return withSpan(SpanOperations.MEMORY_WRITE, {
        operation: name,
        traceId: currentTraceId(),
      }, () => original.apply(memory, args));
    };
  }

  (memory as any).__traced = true;
}

/**
 * 为 PromptEngine 注入追踪
 */
export function instrumentPrompt(prompt: PromptEngine): void {
  if (!isTracingEnabled()) return;
  if ((prompt as any).__traced) return;

  const proto = Object.getPrototypeOf(prompt);
  const originalBuild = proto.build || proto.render;
  if (originalBuild) {
    const methodName = proto.build ? "build" : "render";
    (prompt as any)[methodName] = function (...args: any[]) {
      return withSpan(SpanOperations.PROMPT_BUILD, {
        traceId: currentTraceId(),
      }, () => originalBuild.apply(prompt, args));
    };
  }

  (prompt as any).__traced = true;
}

/**
 * 工具执行追踪包装器
 * 用于在工具调用处手动包装
 */
export function traceToolExec<T>(
  toolName: string,
  args: unknown,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!isTracingEnabled()) return Promise.resolve(fn() as T);

  // 截断参数避免过大
  const truncatedArgs = typeof args === "string"
    ? args.slice(0, 500)
    : JSON.stringify(args || {}).slice(0, 500);

  return withSpan(SpanOperations.TOOL_EXEC, {
    toolName,
    args: truncatedArgs,
    traceId: currentTraceId(),
  }, fn);
}
