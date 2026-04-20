/**
 * Core type definitions for Super Agent Platform.
 * Defines the fundamental interfaces for agents, messages, channels, skills, and memory.
 */

import { z } from "zod";

// ─── Agent Types ───────────────────────────────────────────────

export type AgentStatus = "idle" | "running" | "error" | "stopped";

export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  role?: string;
  goal?: string;
  backstory?: string;
  systemPrompt: string;
  llmProvider: LLMProviderConfig;
  tools: string[];
  skills: string[];
  channels: string[];
  memoryEnabled: boolean;
  maxToolIterations: number;
  metadata: Record<string, unknown>;
}

export interface AgentState {
  id: string;
  config: AgentConfig;
  status: AgentStatus;
  activeSessions: number;
  lastActivityAt: Date | null;
  createdAt: Date;
  error?: string;
}

// ─── LLM Provider Types ───────────────────────────────────────

export type LLMProviderType = "openai" | "anthropic" | "ollama" | "custom";

export interface LLMProviderConfig {
  type: LLMProviderType;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  fallback?: LLMProviderConfig;
  /** Provider ID from model catalog (e.g. "moonshot", "zhipu", "minimax") */
  providerId?: string;
  /** Whether the current model supports reasoning/thinking mode */
  supportsReasoning?: boolean;
  /** B-2: 模型是否支持图片视觉输入 */
  supportsVision?: boolean;
  /** B-2: 模型是否支持原生 PDF 输入 (Anthropic/Google) */
  supportsPdf?: boolean;
}

/** B-1: 多模态消息内容部件（学 OpenClaw ChatImageContent + OpenAI 多模态格式） */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];  // B-1: 扩展支持多模态数组
  name?: string;
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
  /** Reasoning/thinking content from models with thinking mode (e.g. Kimi K2.5) */
  reasoningContent?: string;
}

export interface LLMToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMResponse {
  content: string | null;
  toolCalls?: LLMToolCall[];
  /** Reasoning/thinking content from models with thinking mode */
  reasoningContent?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: "stop" | "tool_calls" | "length" | "error";
}

// ─── Message Types ────────────────────────────────────────────

export type ChatType = "dm" | "group" | "channel" | "thread";

export interface InboundMessage {
  id: string;
  channelId: string;
  platform: string;
  chatId: string;
  chatType: ChatType;
  senderId: string;
  senderName?: string;
  text: string;
  threadId?: string;
  replyToId?: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  channelId: string;
  chatId: string;
  text: string;
  threadId?: string;
  replyToId?: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

// ─── Media Types ─────────────────────────────────────────────

/** 媒体分类，用于渠道适配器选择发送方法 */
export type MediaKind = "image" | "video" | "audio" | "document" | "file";

/** 增强的附件接口 — 对标 OpenClaw 多源支持 */
export interface Attachment {
  /** 本地文件绝对路径 */
  path?: string;
  /** 远程 URL (HTTP/HTTPS) */
  url?: string;
  /** Base64 编码的文件内容 (不含 data: 前缀) */
  base64?: string;
  /** MIME 类型 (自动检测或显式指定) */
  mimeType?: string;
  /** 原始文件名 */
  filename?: string;
  /** 附件说明/标题 */
  caption?: string;
  /** 媒体分类 (自动推断或显式指定) */
  kind?: MediaKind;
  /** 文件大小 (字节) */
  size?: number;
}

/** 媒体服务内部描述符 — 加载完成后的标准化结构 */
export interface MediaDescriptor {
  /** 本地临时文件路径 */
  localPath: string;
  /** Buffer 数据 */
  buffer: Buffer;
  /** 确定的 MIME 类型 */
  contentType: string;
  /** 媒体分类 */
  kind: MediaKind;
  /** 原始/推断的文件名 */
  filename: string;
  /** 文件大小 (字节) */
  size: number;
}

// ─── Session Types ────────────────────────────────────────────

export interface Session {
  id: string;
  agentId: string;
  channelId?: string;
  platform?: string;
  chatId?: string;
  userId?: string;
  messages: LLMMessage[];
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  /** Phase 2: 子代理嵌套深度（0 = 主会话，1 = 直接子代理，2 = 孙代理） */
  spawnDepth?: number;
  /** Phase 2: 父会话 ID（子代理会话才有） */
  parentSessionId?: string;
}

// ─── Channel Types ────────────────────────────────────────────

export type ChannelStatus = "connected" | "disconnected" | "error" | "configuring";

export interface ChannelConfig {
  id: string;
  platform: string;
  enabled: boolean;
  displayName?: string;
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
}

export interface ChannelState {
  id: string;
  config: ChannelConfig;
  status: ChannelStatus;
  connectedAt?: Date;
  error?: string;
}

// ─── Skill Types ──────────────────────────────────────────────

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  platforms?: string[];
  prerequisites?: {
    envVars?: string[];
    commands?: string[];
  };
  security?: {
    sandbox?: "strict" | "standard" | "none";
    networkWhitelist?: string[];
    maxMemoryMb?: number;
    executionTimeout?: number;
  };
  metadata?: {
    tags?: string[];
    relatedSkills?: string[];
  };
}

export interface Skill {
  id: string;
  frontmatter: SkillFrontmatter;
  content: string;
  filePath: string;
  enabled: boolean;
  loadedAt: Date;
  /** Spec v3 Task 2: 技能就绪状态缓存 */
  readiness?: {
    status: "available" | "setup_needed" | "unsupported";
    missingEnvVars: string[];
    missingBins: string[];
    setupHelp?: string;
  };
}

// ─── Tool Types ───────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodType;
  /**
   * Raw JSON Schema for the tool parameters.
   * When present, buildToolDefinitions() uses this directly instead of
   * converting `parameters` via zodToJsonSchema.
   * Used by MCP tools whose inputSchema is already a JSON Schema object.
   */
  rawJsonSchema?: Record<string, unknown>;
  execute: (params: unknown, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  agentId: string;
  sessionId: string;
  userId?: string;
  channelId?: string;
}

export interface ToolResult {
  success: boolean;
  output: string;
  data?: unknown;
  error?: string;
}

// ─── Memory Types ─────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  agentId: string;
  userId?: string;
  content: string;
  type: "core" | "recall" | "archival";
  embedding?: number[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  // C-1: 信任评分系统（学 Hermes store.py 非对称反馈）
  trustScore?: number;     // 默认 0.5，范围 [0, 1]
  helpfulCount?: number;   // 正反馈计数
  retrievalCount?: number; // 检索次数
  // F-2: 嵌入类型标记（区分 HRR 相位向量 / Qwen 语义向量 / Simple hash 向量）
  embeddingType?: "hrr" | "qwen" | "simple";
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

// ─── Event Types ──────────────────────────────────────────────

export type PlatformEventType =
  | "agent:start"
  | "agent:stop"
  | "agent:error"
  | "session:start"
  | "session:end"
  | "message:inbound"
  | "message:outbound"
  | "channel:connected"
  | "channel:disconnected"
  | "channel:error"
  | "skill:loaded"
  | "skill:updated"
  | "skill:removed"
  | "memory:updated";

export interface PlatformEvent {
  type: PlatformEventType;
  timestamp: Date;
  data: Record<string, unknown>;
}

// ─── Zod Schemas (for API validation) ─────────────────────────

export const AgentConfigSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(1024).optional(),
  role: z.string().optional(),
  goal: z.string().optional(),
  backstory: z.string().optional(),
  systemPrompt: z.string().default("You are a helpful AI assistant."),
  llmProvider: z.object({
    type: z.enum(["openai", "anthropic", "ollama", "custom"]),
    model: z.string(),
    apiKey: z.string().optional(),
    baseUrl: z.string().url().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().positive().optional(),
    // E-4: 与 LLMProviderConfig 接口对齐
    fallback: z.lazy(() => z.object({
      type: z.enum(["openai", "anthropic", "ollama", "custom"]),
      model: z.string(),
      apiKey: z.string().optional(),
      baseUrl: z.string().url().optional(),
    })).optional(),
    providerId: z.string().optional(),
    supportsReasoning: z.boolean().optional(),
  }),
  tools: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  channels: z.array(z.string()).default([]),
  memoryEnabled: z.boolean().default(true),
  maxToolIterations: z.number().min(1).default(25),
  metadata: z.record(z.unknown()).default({}),
});

export const ChatMessageSchema = z.object({
  agentId: z.string(),
  sessionId: z.string().optional(),
  // 允许空字符串 — 非文本消息（图片/文件/音频）的 message 可能为空，
  // 媒体信息通过 metadata.media_urls 携带
  message: z.string(),
  stream: z.boolean().default(false),
  metadata: z.record(z.unknown()).optional(),  // B-6: 携带 images 等附加数据
});

export const ChannelConfigSchema = z.object({
  platform: z.string(),
  enabled: z.boolean().default(true),
  displayName: z.string().optional(),
  credentials: z.record(z.string()).default({}),
  settings: z.record(z.unknown()).default({}),
});
