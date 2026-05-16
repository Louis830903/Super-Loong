/**
 * A2A 协议核心类型定义
 *
 * 严格对齐 A2A v1.0 标准（a2a.proto），由方案 C（完全自研）翻译。
 * protocolVersion 锁定 0.3.x。
 *
 * @see a2a-spec.md — SDK 选型决策与方法集对照表
 */

import type { Attachment, ToolResult } from "../types/index.js";

// ─── IAgentLike：本地 Agent 与远端 Agent 的公共调用契约 ───────────

/**
 * 本地 AgentRuntime 和远端 RemoteAgentProxy 都满足的最小接口。
 * 签名严格对齐 AgentRuntime.chat()（runtime.ts L441-449）。
 * AgentRuntime 天然满足（鸭子类型兼容），RemoteAgentProxy 显式 implements。
 */
export interface IAgentLike {
  chat(
    userMessage: string,
    sessionId?: string,
    options?: {
      onStream?: (chunk: string) => void;
      onToolCall?: (name: string, args: unknown) => void;
      onToolResult?: (name: string, result: ToolResult) => void;
    },
  ): Promise<{
    sessionId: string;
    response: string;
    toolCalls: string[];
    attachments: Attachment[];
  }>;
}

// ─── TaskState 枚举（8 态状态机） ──────────────────────────────

/** Task 生命周期状态（对齐 a2a.proto TaskState 枚举） */
export enum TaskState {
  SUBMITTED = "submitted",
  WORKING = "working",
  /** 终止态：任务完成 */
  COMPLETED = "completed",
  /** 终止态：任务失败 */
  FAILED = "failed",
  /** 终止态：任务被取消 */
  CANCELED = "canceled",
  /** 终止态：Agent 拒绝执行 */
  REJECTED = "rejected",
  /** 中断态：需要用户额外输入 */
  INPUT_REQUIRED = "input-required",
  /** 中断态：需要认证 */
  AUTH_REQUIRED = "auth-required",
}

/** 终止态集合 — 一旦进入不可转换，需在同 contextId 下新建 Task */
const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.COMPLETED,
  TaskState.FAILED,
  TaskState.CANCELED,
  TaskState.REJECTED,
]);

/** 中断态集合 — 可恢复到 working */
const INTERRUPTED_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.INPUT_REQUIRED,
  TaskState.AUTH_REQUIRED,
]);

/** 判断是否为终止态（不可恢复） */
export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/** 判断是否为中断态（可恢复） */
export function isInterruptedState(state: TaskState): boolean {
  return INTERRUPTED_STATES.has(state);
}

// ─── 合法转换矩阵 ──────────────────────────────────────────

/**
 * 状态转换合法性矩阵：key = 当前态，value = 允许转向的态集合。
 * 终止态不在 key 中 → 不允许任何转换。
 */
export const VALID_TRANSITIONS: ReadonlyMap<TaskState, ReadonlySet<TaskState>> = new Map<TaskState, ReadonlySet<TaskState>>([
  [TaskState.SUBMITTED, new Set([TaskState.WORKING, TaskState.REJECTED])],
  [
    TaskState.WORKING,
    new Set([
      TaskState.COMPLETED,
      TaskState.FAILED,
      TaskState.CANCELED,
      TaskState.INPUT_REQUIRED,
      TaskState.AUTH_REQUIRED,
    ]),
  ],
  [TaskState.INPUT_REQUIRED, new Set([TaskState.WORKING])],
  [TaskState.AUTH_REQUIRED, new Set([TaskState.WORKING])],
]);

// ─── Part 联合类型（text / raw / url / data 四种） ─────────

/** 文本内容部分 */
export interface TextPart {
  kind: "text";
  text: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

/** 原始二进制内容部分（base64 编码） */
export interface RawPart {
  kind: "raw";
  raw: string; // base64
  mediaType: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}

/** URL 引用内容部分 */
export interface UrlPart {
  kind: "url";
  url: string;
  mediaType?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}

/** 结构化数据内容部分 */
export interface DataPart {
  kind: "data";
  data: unknown;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

/** A2A Part 联合类型 — 消息和产物的内容容器 */
export type Part = TextPart | RawPart | UrlPart | DataPart;

// ─── Message ────────────────────────────────────────────────

/** A2A Message — 客户端与服务端之间的通信单元 */
export interface A2AMessage {
  /** 消息唯一标识（由创建方生成，如 UUID） */
  messageId: string;
  /** 发送方角色 */
  role: "user" | "agent";
  /** 消息内容 */
  parts: Part[];
  /** 会话上下文 ID（串联多个 Task） */
  contextId?: string;
  /** 关联的 Task ID */
  taskId?: string;
  /** 引用的历史 Task ID 列表（追问/精炼场景） */
  referenceTaskIds?: string[];
  /** 自定义元数据 */
  metadata?: Record<string, unknown>;
  // ─── P0 安全加固：消息签名字段（可选，向后兼容） ───
  /** 签名时间戳（毫秒，Unix epoch） */
  timestamp?: number;
  /** 一次性随机数（防重放，UUID v4） */
  nonce?: string;
  /** HMAC-SHA256 签名（hex 编码） */
  signature?: string;
}

// ─── Artifact ───────────────────────────────────────────────

/** A2A Artifact — Task 输出产物（同 name 不同 artifactId 表达版本演化） */
export interface Artifact {
  /** 产物唯一标识（Task 内唯一） */
  artifactId: string;
  /** 人类可读名称 */
  name: string;
  /** 可选描述 */
  description?: string;
  /** 产物内容 */
  parts: Part[];
  /** 自定义元数据 */
  metadata?: Record<string, unknown>;
}

// ─── TaskStatus / A2ATask ───────────────────────────────────

/** Task 状态快照 */
export interface TaskStatus {
  state: TaskState;
  message?: A2AMessage;
  /** ISO 8601 时间戳 */
  timestamp: string;
}

/** A2A Task — 核心操作单元 */
export interface A2ATask {
  /** Task 唯一标识（服务端生成） */
  id: string;
  /** 会话上下文 ID（串联同一会话内多个 Task） */
  contextId: string;
  /** 当前状态 */
  status: TaskStatus;
  /** 输出产物列表 */
  artifacts: Artifact[];
  /** 多轮消息历史 */
  history: A2AMessage[];
  /** 自定义元数据 */
  metadata?: Record<string, unknown>;
}

// ─── AgentCard / AgentSkill ─────────────────────────────────

/** Agent 服务提供商 */
export interface AgentProvider {
  organization: string;
  url: string;
}

/** Agent 能力声明 */
export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extendedAgentCard?: boolean;
}

/** Agent 技能描述 */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

/** OpenAPI 风格安全方案 */
export interface SecurityScheme {
  type: "apiKey" | "http" | "oauth2" | "openIdConnect";
  scheme?: string; // "bearer" 等
  bearerFormat?: string;
  in?: "header" | "query" | "cookie";
  name?: string;
}

/** 安全需求引用 */
export interface SecurityRequirement {
  [schemeName: string]: string[];
}

/** A2A Agent Card — 自描述清单（对齐 a2a.proto AgentCard） */
export interface A2AAgentCard {
  /** Agent 名称 */
  name: string;
  /** Agent 描述 */
  description: string;
  /** Agent 版本 */
  version: string;
  /** 协议版本（锁定 0.3.x） */
  protocolVersion: string;
  /** 主端点 URL */
  url: string;
  /** 服务提供商 */
  provider?: AgentProvider;
  /** 能力声明 */
  capabilities: AgentCapabilities;
  /** 技能列表 */
  skills: AgentSkill[];
  /** 安全方案（公开 Card 不含此字段，ExtendedCard 含） */
  securitySchemes?: Record<string, SecurityScheme>;
  /** 安全需求 */
  securityRequirements?: SecurityRequirement[];
  /** 默认输入模态 */
  defaultInputModes: string[];
  /** 默认输出模态 */
  defaultOutputModes: string[];
  /** 图标 URL */
  iconUrl?: string;
  /** 文档 URL */
  documentationUrl?: string;
}

// ─── RPC 载体类型 ───────────────────────────────────────────

/** SendMessage 请求体 */
export interface SendMessageRequest {
  /** 要发送的消息 */
  message: A2AMessage;
  /** 可选：协议版本（用于协商校验） */
  protocolVersion?: string;
}

/** SendMessage 响应体 — Task 或纯 Message 二选一 */
export type SendMessageResponse =
  | { type: "task"; task: A2ATask }
  | { type: "message"; message: A2AMessage };

/** SSE 流帧（SendStreamingMessage / SubscribeToTask） */
export type StreamFrame =
  | { type: "status"; taskId: string; status: TaskStatus }
  | { type: "artifact"; taskId: string; artifact: Artifact; append?: boolean; lastChunk?: boolean }
  | { type: "message"; message: A2AMessage }
  | { type: "done"; taskId: string }
  | { type: "error"; error: string; code?: number };

/** Task 查询过滤条件 */
export interface TaskFilter {
  contextId?: string;
  state?: TaskState;
  limit?: number;
  offset?: number;
}

// ─── Push Notification 类型 ─────────────────────────────────

/** Push Notification 配置 */
export interface TaskPushNotificationConfig {
  /** 配置 ID */
  id: string;
  /** 关联的 Task ID */
  taskId: string;
  /** Webhook 推送 URL（强制 HTTPS） */
  webhookUrl: string;
  /** 鉴权令牌 */
  authToken?: string;
  /** 订阅的事件类型 */
  events?: Array<"status_update" | "artifact_update" | "task_complete">;
}

/** Push 事件载荷 */
export interface PushEvent {
  taskId: string;
  eventType: "status_update" | "artifact_update" | "task_complete";
  status?: TaskStatus;
  artifact?: Artifact;
  timestamp: string;
}

// ─── JSON-RPC 2.0 基础类型 ──────────────────────────────────

/** JSON-RPC 请求 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

/** JSON-RPC 成功响应 */
export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

/** JSON-RPC 错误响应 */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ─── A2A 错误码 ─────────────────────────────────────────────

/** A2A 专用 JSON-RPC 错误码 */
export const A2A_ERROR_CODES = {
  /** 未授权（token 无效/缺失） */
  UNAUTHORIZED: -32001,
  /** Task 不存在 */
  TASK_NOT_FOUND: -32002,
  /** 协议版本不匹配 */
  PROTOCOL_VERSION_MISMATCH: -32003,
  /** 无效请求 */
  INVALID_REQUEST: -32600,
  /** 方法不存在 */
  METHOD_NOT_FOUND: -32601,
} as const;

// ─── Attachment ↔ Part 映射辅助 ─────────────────────────────

/**
 * 将本地 Attachment 转换为 A2A Part。
 * 优先级：base64 > url > path（path 在跨进程场景无效，降级为 text 提示）。
 */
export function mapAttachmentToA2APart(att: Attachment): Part {
  if (att.base64 && att.mimeType) {
    return {
      kind: "raw",
      raw: att.base64,
      mediaType: att.mimeType,
      filename: att.filename,
    };
  }
  if (att.url) {
    return {
      kind: "url",
      url: att.url,
      mediaType: att.mimeType,
      filename: att.filename,
    };
  }
  // path 在跨进程场景无法直接传输，降级为文本描述
  return {
    kind: "text",
    text: att.caption || att.filename || `[attachment: ${att.path ?? "unknown"}]`,
    mediaType: att.mimeType,
  };
}

/**
 * 将 A2A Part 转换为本地 Attachment。
 */
export function mapA2APartToAttachment(part: Part): Attachment {
  switch (part.kind) {
    case "raw":
      return {
        base64: part.raw,
        mimeType: part.mediaType,
        filename: part.filename,
      };
    case "url":
      return {
        url: part.url,
        mimeType: part.mediaType,
        filename: part.filename,
      };
    case "text":
      return {
        caption: part.text,
        mimeType: part.mediaType || "text/plain",
      };
    case "data":
      return {
        base64: Buffer.from(JSON.stringify(part.data)).toString("base64"),
        mimeType: part.mediaType || "application/json",
      };
  }
}
