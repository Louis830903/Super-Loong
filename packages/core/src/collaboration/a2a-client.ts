/**
 * A2A 客户端 — JSON-RPC 2.0 over HTTP
 *
 * 封装远端 A2A Agent 的所有 RPC 调用，包括：
 * - SendMessage / GetTask / ListTasks / CancelTask
 * - fetchAgentCard（GET well-known + ETag 缓存）
 * - sendStreamingMessage（SSE 流式）
 *
 * 重试策略：指数退避（initial=500ms, max=8s, attempts=3），仅对 transient 错误重试。
 * 自动注入 x-a2a-trace-id header 串联跨进程 tracing。
 *
 * @see a2a-types.ts — 类型定义
 * @see a2a-spec.md — 协议规范
 */

import { randomUUID } from "node:crypto";
import pino from "pino";
import {
  type A2AAgentCard,
  type A2ATask,
  type A2AMessage,
  type SendMessageRequest,
  type SendMessageResponse,
  type StreamFrame,
  type TaskFilter,
  type JsonRpcRequest,
  type JsonRpcResponse,
  A2A_ERROR_CODES,
} from "./a2a-types.js";
import { currentTraceId, withSpan } from "../tracing/tracer.js";
import { retryWithBackoff } from "./retry.js";

// ─── 日志（P2-1：统一使用 pino） ──────────────────────────────

const logger = pino({ name: "A2AClient" });

const log = {
  info: (msg: string, data?: unknown) => data ? logger.info(data, msg) : logger.info(msg),
  warn: (msg: string, data?: unknown) => data ? logger.warn(data, msg) : logger.warn(msg),
  error: (msg: string, data?: unknown) => data ? logger.error(data, msg) : logger.error(msg),
};

// ─── 错误类型 ───────────────────────────────────────────────

/** A2A RPC 调用错误 */
export class A2AClientError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "A2AClientError";
  }

  /** 是否为 transient 错误（可重试） */
  get isTransient(): boolean {
    // 5xx 和网络错误可重试，4xx 不可重试
    return this.code >= 500 || this.code === -1;
  }
}

// ─── 重试配置 ───────────────────────────────────────────────

interface RetryConfig {
  /** 初始延迟（毫秒），默认 500 */
  initialDelayMs: number;
  /** 最大延迟（毫秒），默认 8000 */
  maxDelayMs: number;
  /** 最大重试次数，默认 3 */
  maxAttempts: number;
  /** 单次请求超时（毫秒），默认 30000（P1-2 新增） */
  requestTimeoutMs: number;
}

const DEFAULT_RETRY: RetryConfig = {
  initialDelayMs: 500,
  maxDelayMs: 8000,
  maxAttempts: 3,
  requestTimeoutMs: 30_000,
};

// ─── 认证配置 ───────────────────────────────────────────────

export interface A2AAuthConfig {
  type: "bearer" | "apiKey";
  token: string;
  /** apiKey 时使用的 header 名称，默认 x-api-key */
  headerName?: string;
}

// ─── ETag 缓存条目 ──────────────────────────────────────────

interface CacheEntry {
  card: A2AAgentCard;
  etag: string;
}

// ─── A2AClient ──────────────────────────────────────────────

/**
 * A2A 客户端：封装所有远端 A2A Agent RPC 调用。
 */
export class A2AClient {
  private readonly endpoint: string;
  private readonly auth?: A2AAuthConfig;
  private readonly retry: RetryConfig;

  /** AgentCard ETag 缓存（按 URL 存储） */
  private readonly cardCache = new Map<string, CacheEntry>();

  constructor(endpoint: string, auth?: A2AAuthConfig, retry?: Partial<RetryConfig>) {
    // 去掉末尾斜杠
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.auth = auth;
    this.retry = { ...DEFAULT_RETRY, ...retry };
  }

  // ─── 公开 API ─────────────────────────────────────────────

  /**
   * 发送消息（SendMessage RPC）。
   * 返回 Task 或纯 Message（由服务端决定）。
   */
  async sendMessage(request: SendMessageRequest): Promise<SendMessageResponse> {
    return withSpan("a2a.sendMessage", { endpoint: this.endpoint }, async () => {
      const result = await this.rpcCall<SendMessageResponse>("SendMessage", request);
      return result;
    });
  }

  /**
   * 获取 Task 详情。
   */
  async getTask(taskId: string): Promise<A2ATask> {
    return withSpan("a2a.getTask", { taskId }, async () => {
      const result = await this.rpcCall<A2ATask>("GetTask", { taskId });
      return result;
    });
  }

  /**
   * 列出 Tasks（支持过滤）。
   */
  async listTasks(filter?: TaskFilter): Promise<A2ATask[]> {
    return withSpan("a2a.listTasks", { filter: filter ?? {} }, async () => {
      const result = await this.rpcCall<A2ATask[]>("ListTasks", filter ?? {});
      return result;
    });
  }

  /**
   * 取消 Task。
   */
  async cancelTask(taskId: string): Promise<A2ATask> {
    return withSpan("a2a.cancelTask", { taskId }, async () => {
      const result = await this.rpcCall<A2ATask>("CancelTask", { taskId });
      return result;
    });
  }

  /**
   * 获取 Agent Card（GET well-known，支持 ETag 缓存 + 304）。
   *
   * @param cardUrl - 可选自定义 Card URL，默认使用 endpoint 的 well-known 路径
   */
  async fetchAgentCard(cardUrl?: string): Promise<A2AAgentCard> {
    const url = cardUrl ?? `${this.endpoint}/.well-known/agent-card.json`;

    return withSpan("a2a.fetchAgentCard", { url }, async () => {
      const headers: Record<string, string> = {
        Accept: "application/json",
      };

      // 如有 ETag 缓存，附带 If-None-Match 请求条件缓存
      const cached = this.cardCache.get(url);
      if (cached) {
        headers["If-None-Match"] = cached.etag;
      }

      const response = await this.httpGet(url, headers);

      // 304 Not Modified → 返回缓存
      if (response.status === 304 && cached) {
        log.info("AgentCard 命中 ETag 缓存（304）", { url });
        return cached.card;
      }

      if (!response.ok) {
        throw new A2AClientError(
          `fetchAgentCard 失败: ${response.status} ${response.statusText}`,
          response.status,
        );
      }

      const card = (await response.json()) as A2AAgentCard;

      // 缓存 ETag
      const etag = response.headers.get("etag");
      if (etag) {
        this.cardCache.set(url, { card, etag });
      }

      return card;
    });
  }

  /**
   * 发送流式消息（SendStreamingMessage），通过回调接收 SSE 帧。
   *
   * @param request  - 消息请求
   * @param onFrame  - 每收到一帧 SSE 事件时的回调
   * @param signal   - 可选 AbortSignal，用于取消流
   */
  async sendStreamingMessage(
    request: SendMessageRequest,
    onFrame: (frame: StreamFrame) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return withSpan("a2a.sendStreamingMessage", { endpoint: this.endpoint }, async () => {
      const rpcPayload: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "SendStreamingMessage",
        params: request,
      };

      const headers = this.buildHeaders();
      headers["Content-Type"] = "application/json";
      headers["Accept"] = "text/event-stream";

      // P1-2修复：流式超时 2 分钟，用 AbortSignal.any() 合并用户信号与超时
      const timeoutSignal = AbortSignal.timeout(120_000);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      // P0-1修复：SSE 流式端点路径必须与服务端 POST /a2a/stream 对齐
      const response = await fetch(`${this.endpoint}/a2a/stream`, {
        method: "POST",
        headers,
        body: JSON.stringify(rpcPayload),
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw new A2AClientError(
          `SendStreamingMessage 失败: ${response.status}`,
          response.status,
        );
      }

      if (!response.body) {
        throw new A2AClientError("SSE 响应体为空", -1);
      }

      // 解析 SSE 事件流
      await this.parseSSEStream(response.body, onFrame);
    });
  }

  // ─── 内部方法 ─────────────────────────────────────────────

  /**
   * JSON-RPC 调用（含指数退避重试，委托 retryWithBackoff 公共函数）。
   */
  private async rpcCall<T>(method: string, params: unknown): Promise<T> {
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    };

    return retryWithBackoff(
      async () => {
        try {
          const headers = this.buildHeaders();
          headers["Content-Type"] = "application/json";

          const response = await fetch(`${this.endpoint}/a2a`, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            // P1-2修复：单次请求超时防止远端无响应时永久挂起
            signal: AbortSignal.timeout(this.retry.requestTimeoutMs),
          });

          if (!response.ok) {
            throw new A2AClientError(
              `HTTP ${response.status}: ${response.statusText}`,
              response.status,
            );
          }

          const rpcResponse = (await response.json()) as JsonRpcResponse;

          // JSON-RPC 错误
          if ("error" in rpcResponse) {
            throw new A2AClientError(
              rpcResponse.error.message,
              rpcResponse.error.code,
              rpcResponse.error.data,
            );
          }

          return rpcResponse.result as T;
        } catch (err) {
          // 统一包装为 A2AClientError，保留 isTransient 判断能力
          if (err instanceof A2AClientError) throw err;
          throw new A2AClientError(
            err instanceof Error ? err.message : String(err),
            -1, // 网络错误码
          );
        }
      },
      {
        maxAttempts: this.retry.maxAttempts,
        initialDelayMs: this.retry.initialDelayMs,
        maxDelayMs: this.retry.maxDelayMs,
      },
      (err) => err instanceof A2AClientError && err.isTransient,
    );
  }

  /**
   * 构建通用请求 headers（认证 + trace）。
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};

    // 注入 trace ID 串联跨进程追踪
    const traceId = currentTraceId();
    if (traceId) {
      headers["x-a2a-trace-id"] = traceId;
    }

    // 认证
    if (this.auth) {
      if (this.auth.type === "bearer") {
        headers["Authorization"] = `Bearer ${this.auth.token}`;
      } else {
        headers[this.auth.headerName ?? "x-api-key"] = this.auth.token;
      }
    }

    return headers;
  }

  /**
   * HTTP GET 请求（用于 AgentCard 获取）。
   */
  private async httpGet(url: string, headers: Record<string, string>): Promise<Response> {
    const authHeaders = this.buildHeaders();
    return fetch(url, {
      method: "GET",
      headers: { ...authHeaders, ...headers },
      // P1-2修复：GET 请求也需超时控制
      signal: AbortSignal.timeout(this.retry.requestTimeoutMs),
    });
  }

  /**
   * 解析 SSE 事件流，逐帧回调。
   */
  private async parseSSEStream(
    body: ReadableStream<Uint8Array>,
    onFrame: (frame: StreamFrame) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE 格式：以双换行 \n\n 分隔事件
        const parts = buffer.split("\n\n");
        // 最后一段可能不完整，留在 buffer 中
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          // P2-3增强：同时提取 event: 和 data: 行，按 SSE 标准解析
          const lines = part.split("\n");
          let eventType = "";
          let dataStr = "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              dataStr = line.slice(6);
            }
          }

          if (!dataStr) continue;

          // 如果 event: 类型为 error，直接抛出（不等待 JSON 解析）
          if (eventType === "error") {
            throw new A2AClientError(dataStr, -1);
          }

          try {
            const frame: StreamFrame = JSON.parse(dataStr);

            // P0-4修复：服务端发送的 error 帧必须抛出而非静默丢弃
            if (frame.type === "error") {
              throw new A2AClientError(
                frame.error,
                frame.code ?? -1,
              );
            }

            onFrame(frame);

            // 收到 done 帧则结束
            if (frame.type === "done") return;
          } catch (err) {
            // 如果是 A2AClientError 则向上抛出，否则记录 JSON 解析失败
            if (err instanceof A2AClientError) throw err;
            log.warn("SSE 帧 JSON 解析失败", { raw: dataStr });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
