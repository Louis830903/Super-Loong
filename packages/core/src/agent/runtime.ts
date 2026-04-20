/**
 * Agent Runtime — the core execution engine for a single AI agent.
 *
 * Manages the agent lifecycle: receives messages, builds context (system prompt +
 * memory + tool definitions), calls the LLM, executes tool calls in a loop, and
 * returns the final response.
 *
 * References:
 * - OpenClaw agent runtime (src/agents/)
 * - Hermes run_agent.py (AIAgent class)
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import { zodToJsonSchema } from "zod-to-json-schema";
import { LLMProvider } from "../llm/provider.js";
import type { LLMToolDef } from "../llm/provider.js";
import type {
  AgentConfig,
  AgentState,
  AgentStatus,
  Attachment,
  ContentPart,
  LLMMessage,
  Session,
  ToolDefinition,
  ToolResult,
} from "../types/index.js";
import type { SecurityManager } from "../security/sandbox.js";
import type { MemoryManager } from "../memory/manager.js";
import type { SkillLoader } from "../skills/loader.js";
import { PromptEngine } from "../prompt/engine.js";
import type { PromptEngineConfig } from "../prompt/engine.js";
import { MarkdownMemory } from "../memory/markdown-memory.js";
import { ContextCompressor } from "../context/compressor.js";
import type { IContextStrategy } from "../context/compressor.js";
import { ContextSummarizer } from "../context/summarizer.js";
import { getModelById } from "../llm/model-catalog.js";
import { supportsVision } from "../llm/model-capabilities.js";
import {
  createConversation,
  getConversation,
  appendConvMessage,
  getConvMessages,
  updateConversationTitle,
  replaceConvMessages,
} from "../persistence/sqlite.js";
import path from "node:path";
import { splitMediaFromOutput } from "../media/parse.js";
import { resolveOutboundAttachment } from "../media/loader.js";
import { kindFromMime } from "../media/mime.js";
import type { AgentManager } from "./manager.js";
import type { HeartbeatConfig } from "../cron/heartbeat.js";
import { HeartbeatRunner, DEFAULT_HEARTBEAT_CONFIG } from "../cron/heartbeat.js";
import {
  truncateToolResult,
  calculateMaxSingleResultChars,
  truncateOversizedToolResultsInHistory,
  estimateToolResultReducibleChars,
} from "../context/tool-result-truncation.js";
import { shouldPreemptivelyCompact } from "../context/preemptive-check.js";

const logger = pino({ name: "agent-runtime" });

export interface AgentRuntimeOptions {
  config: AgentConfig;
  tools?: ToolDefinition[];
  securityManager?: SecurityManager;
  memoryManager?: MemoryManager;
  skillLoader?: SkillLoader;
  platform?: string;
  contextFilesRoot?: string;
  promptMode?: "full" | "minimal" | "none";
  /** Enable SQLite conversation persistence (default: true) */
  enablePersistence?: boolean;
  /** Phase A-1: AgentManager 反向引用，用于 evolution 闭环 */
  manager?: AgentManager;
  /** Phase 1: 心跳配置（学 OpenClaw Heartbeat System） */
  heartbeatConfig?: Partial<HeartbeatConfig>;
  onStream?: (chunk: string) => void;
  onToolCall?: (name: string, args: unknown) => void;
  onToolResult?: (name: string, result: ToolResult) => void;
}

export class AgentRuntime {
  readonly id: string;
  private config: AgentConfig;
  private llm: LLMProvider;
  private tools: Map<string, ToolDefinition>;
  private sessions: Map<string, Session>;
  private securityManager?: SecurityManager;
  private promptEngine: PromptEngine;
  private markdownMemory: MarkdownMemory;
  private compressor: IContextStrategy;
  private persistEnabled: boolean;
  private _status: AgentStatus = "idle";
  private _lastActivity: Date | null = null;
  private _createdAt: Date;
  // P0-A9: per-session 并发锁（参考 Hermes _AGENT_PENDING_SENTINEL 哨兵模式）
  private _sessionLocks = new Map<string, Promise<unknown>>();
  // Phase A-1: AgentManager 反向引用，用于访问 evolution 引擎
  private manager?: AgentManager;
  // Phase 1: 心跳引擎（学 OpenClaw Heartbeat System）
  private heartbeatRunner?: HeartbeatRunner;

  constructor(options: AgentRuntimeOptions) {
    this.id = options.config.id;
    this.config = options.config;
    this.llm = new LLMProvider(options.config.llmProvider);
    this.tools = new Map();
    this.sessions = new Map();
    this.securityManager = options.securityManager;
    this.persistEnabled = options.enablePersistence !== false;
    this._createdAt = new Date();
    this.manager = options.manager;

    // Initialize Markdown memory files (Hermes MEMORY.md/USER.md/SOUL.md pattern)
    this.markdownMemory = new MarkdownMemory();
    this.markdownMemory.ensureFiles();
    // B-1: 初始化时冻结快照（学 Hermes _system_prompt_snapshot）
    this.markdownMemory.captureSnapshot();

    // P0-3: Initialize context compressor with model's context window size
    const modelDef = getModelById(
      options.config.llmProvider?.providerId ?? "",
      options.config.llmProvider?.model ?? "",
    );
    const compressor = new ContextCompressor({
      contextWindowTokens: modelDef?.contextWindow ?? 8192,
    });
    this.compressor = compressor;

    // C-2: 自动检测模型 vision 能力（学 Hermes models_dev.py）
    // 优先使用 model-catalog 的权威声明，前缀启发式仅作 fallback
    if (this.config.llmProvider.supportsVision === undefined) {
      this.config.llmProvider.supportsVision =
        modelDef?.supportsVision ?? supportsVision(this.config.llmProvider.model);
    }

    // P2: 注入 LLM 结构化摘要器（使用同一个 LLM provider）
    // 压缩中间对话时用 LLM 生成结构化摘要，替代直接丢弃
    if (options.config.llmProvider) {
      const summarizerLLM = new LLMProvider(options.config.llmProvider);
      const summarizer = new ContextSummarizer({ llmProvider: summarizerLLM });
      compressor.setSummarizer(summarizer);
    }

    // Initialize PromptEngine
    this.promptEngine = new PromptEngine({
      agentConfig: options.config,
      memoryManager: options.memoryManager,
      skillLoader: options.skillLoader,
      platform: options.platform,
      contextFilesRoot: options.contextFilesRoot,
      promptMode: options.promptMode,
      markdownMemory: this.markdownMemory,
      // Phase 1: 心跳启用时注入系统提示心跳指导
      heartbeatEnabled: options.heartbeatConfig?.enabled ?? false,
    });

    // Register provided tools
    if (options.tools) {
      for (const tool of options.tools) {
        this.tools.set(tool.name, tool);
      }
    }

    // Phase 1: 初始化心跳引擎（学 OpenClaw HeartbeatRunner）
    // 心跳执行回调由上层 API 通过 setExecuteFn/setDeliverFn 注入
    if (options.heartbeatConfig?.enabled) {
      // CronScheduler 由外部注入，此处仅存储配置，start() 由外部调用
      this.heartbeatRunner = undefined; // 待外部注入 CronScheduler 后构造
    }
  }

  get status(): AgentStatus {
    return this._status;
  }

  get state(): AgentState {
    return {
      id: this.id,
      config: this.config,
      status: this._status,
      activeSessions: this.sessions.size,
      lastActivityAt: this._lastActivity,
      createdAt: this._createdAt,
    };
  }

  /** Register a tool at runtime. */
  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** Remove a tool at runtime. */
  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  /** Get or create a session. If persistence is enabled, loads messages from DB. */
  getSession(sessionId?: string): Session {
    if (sessionId && this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }
    const id = sessionId ?? `conv-${uuid()}`;

    // Try to restore from DB
    if (this.persistEnabled && sessionId) {
      try {
        const conv = getConversation(sessionId);
        if (conv) {
          // P0: 限制 DB 加载数量，防止旧会话历史过大导致 LLM 超时
          // 学 OpenClaw: 只加载最近 100 条，配合 preemptive-compaction 防溢出
          const MAX_RESTORE_MESSAGES = 100;
          const dbMsgs = getConvMessages(sessionId, { limit: MAX_RESTORE_MESSAGES });
          let rawMessages: LLMMessage[] = dbMsgs
            .filter((m) => m.role !== "system")
            .map((m) => {
              // B-0b: 尝试恢复多模态 ContentPart[] — 序列化存储时为 JSON string
              let content: string | null | ContentPart[] = m.content ?? "";
              if (typeof content === "string" && content.startsWith("[")) {
                try {
                  const parsed = JSON.parse(content);
                  if (Array.isArray(parsed) && parsed[0]?.type) {
                    content = parsed as ContentPart[];
                  }
                } catch { /* 不是 JSON，保留原字符串 */ }
              }
              return {
                role: m.role as LLMMessage["role"],
                content,
                ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
                ...(m.toolCalls ? { toolCalls: JSON.parse(m.toolCalls) } : {}),
              };
            });

          // P0: 二次截断 — 即使 DB 返回的消息也可能超限（并发写入等边界情况）
          if (rawMessages.length > MAX_RESTORE_MESSAGES) {
            rawMessages = rawMessages.slice(-MAX_RESTORE_MESSAGES);
          }

          // Sanitize: ensure every tool_calls has matching tool responses
          const messages = this.sanitizeMessages(rawMessages);
          logger.info(
            { sessionId, restoredCount: messages.length, dbCount: dbMsgs.length },
            "Session restored from DB",
          );

          const session: Session = {
            id: sessionId,
            agentId: this.id,
            messages,
            createdAt: new Date(conv.createdAt),
            updatedAt: new Date(conv.updatedAt),
            metadata: {},
          };
          this.sessions.set(sessionId, session);
          return session;
        }
      } catch (err) {
        logger.warn({ sessionId, error: err }, "Failed to restore session from DB, creating new");
      }
    }

    // Create new session
    const session: Session = {
      id,
      agentId: this.id,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {},
    };
    this.sessions.set(id, session);

    // B-1: 新 session 刷新快照，包含上次写入的内容（学 Hermes 每 session 刷新）
    this.markdownMemory.captureSnapshot();

    // Persist the new conversation
    if (this.persistEnabled) {
      try { createConversation(id, this.id); } catch { /* may already exist */ }
    }

    return session;
  }

  /** Find an existing session without creating a new one. */
  findSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Sanitize loaded message history for OpenAI-compatible API submission.
   *
   * Handles two corruption scenarios:
   * 1. Assistant message with tool_calls but missing tool responses → inject synthetic responses
   * 2. Orphaned tool messages without a preceding assistant tool_calls → remove them
   *
   * Also ensures that tool messages only reference tool_call_ids that exist
   * in the immediately preceding assistant message's tool_calls array.
   */
  private sanitizeMessages(messages: LLMMessage[]): LLMMessage[] {
    const result: LLMMessage[] = [];
    let currentToolCallIds: Set<string> | null = null; // valid tool_call_ids from the last assistant message

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === "tool") {
        // Drop tool messages that have no preceding assistant with tool_calls
        if (!currentToolCallIds) {
          logger.warn(
            { toolCallId: msg.toolCallId },
            "Dropping orphaned tool message (no preceding tool_calls)"
          );
          continue;
        }
        // Drop tool messages whose tool_call_id doesn't match any expected id
        if (msg.toolCallId && !currentToolCallIds.has(msg.toolCallId)) {
          logger.warn(
            { toolCallId: msg.toolCallId },
            "Dropping tool message with unmatched tool_call_id"
          );
          continue;
        }
        result.push(msg);
        // Mark this tool_call_id as satisfied
        if (msg.toolCallId) currentToolCallIds.delete(msg.toolCallId);
        continue;
      }

      // Non-tool message encountered: check if previous assistant still has unmatched tool_calls
      if (currentToolCallIds && currentToolCallIds.size > 0) {
        logger.warn(
          { orphanedIds: Array.from(currentToolCallIds) },
          "Injecting synthetic tool responses for orphaned tool_calls"
        );
        for (const orphanId of currentToolCallIds) {
          result.push({
            role: "tool",
            content: "[Tool execution was interrupted — no result available]",
            toolCallId: orphanId,
          });
        }
      }
      currentToolCallIds = null;

      // Push the current message
      result.push(msg);

      // If this is an assistant with tool_calls, start tracking expected responses
      if (msg.role === "assistant" && msg.toolCalls?.length) {
        currentToolCallIds = new Set(msg.toolCalls.map((tc) => tc.id));
      }
    }

    // Handle trailing orphaned tool_calls at end of history
    if (currentToolCallIds && currentToolCallIds.size > 0) {
      logger.warn(
        { orphanedIds: Array.from(currentToolCallIds) },
        "Injecting synthetic tool responses for trailing orphaned tool_calls"
      );
      for (const orphanId of currentToolCallIds) {
        result.push({
          role: "tool",
          content: "[Tool execution was interrupted — no result available]",
          toolCallId: orphanId,
        });
      }
    }

    return result;
  }

  /** Delete a session. */
  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** List all active sessions. */
  listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  // P0-A9: per-session 并发锁实现（带 60s 超时保护）
  /** 等待指定 session 的前一个请求完成，超时后强制放行 */
  private async acquireSessionLock(sessionId: string): Promise<void> {
    const existing = this._sessionLocks.get(sessionId);
    if (existing) {
      const LOCK_TIMEOUT_MS = 60_000;
      try {
        await Promise.race([
          existing,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Session lock timeout (${LOCK_TIMEOUT_MS}ms) for ${sessionId}`)),
              LOCK_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (err) {
        logger.warn(
          { sessionId, error: err instanceof Error ? err.message : String(err) },
          "Session lock wait failed or timed out, proceeding to avoid deadlock",
        );
      }
    }
  }

  /** 创建新的 session 锁，返回释放函数 */
  private createSessionLock(sessionId: string): () => void {
    let releaseFn: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    this._sessionLocks.set(sessionId, lockPromise);
    return () => {
      releaseFn();
      // 如果当前锁仍然是我们创建的那个，清理它
      if (this._sessionLocks.get(sessionId) === lockPromise) {
        this._sessionLocks.delete(sessionId);
      }
    };
  }

  /**
   * Process a user message and return the agent's response.
   * Runs the tool-calling loop up to maxToolIterations times.
   */
  async chat(
    userMessage: string,
    sessionId?: string,
    options?: {
      onStream?: (chunk: string) => void;
      onToolCall?: (name: string, args: unknown) => void;
      onToolResult?: (name: string, result: ToolResult) => void;
    }
  ): Promise<{ sessionId: string; response: string; toolCalls: string[]; attachments: Attachment[] }> {
    const session = this.getSession(sessionId);

    // P0-A9: per-session 并发锁—等待前一个请求完成后再进入
    await this.acquireSessionLock(session.id);
    const lockRelease = this.createSessionLock(session.id);

    this._status = "running";
    this._lastActivity = new Date();

    // P0-A11: 快照消息数量，用于错误时回滚
    const msgCountBeforeChat = session.messages.length;

    // P1: 与 chatStream() 对齐 sanitize 策略
    // 防止前一次崩溃留下的孤立 tool_calls 导致 LLM 400 错误
    session.messages = this.sanitizeMessages(session.messages);

    // Add user message
    session.messages.push({ role: "user", content: userMessage });
    this.persistMessage(session.id, "user", userMessage);

    // Build system prompt via PromptEngine (10-layer architecture)
    const systemMessage: LLMMessage = {
      role: "system",
      content: this.promptEngine.build(session, this.tools),
    };

    // Build tool definitions for the LLM
    const toolDefs = this.buildToolDefinitions();

    let iterations = 0;
    const maxIter = this.config.maxToolIterations;
    const calledTools: string[] = [];
    const attachments: Attachment[] = [];

    try {
      while (iterations < maxIter) {
        iterations++;

        // Phase 0: 修剪旧工具结果（每轮都执行，成本极低）
        const pruneResult = this.compressor.pruneOldToolResults(session.messages);
        if (pruneResult.prunedCount > 0) {
          session.messages = pruneResult.messages;
          logger.info({ pruned: pruneResult.prunedCount }, "Pruned old tool results (chat)");
        }

        // P0: 预防性溢出 4 路路由（与 chatStream 对齐，替代简单 shouldCompress）
        const sysTokens = this.compressor.estimateTokens([systemMessage]);
        const histTokens = this.compressor.estimateTokens(session.messages);
        const chatToolDefsTokens = Math.ceil(JSON.stringify(toolDefs).length / 4);
        const chatMaxSingleChars = this.getMaxToolResultChars();
        const chatToolResultReducible = estimateToolResultReducibleChars(session.messages, chatMaxSingleChars);
        const chatModelInfo = this.getModelDef();
        const chatRouteResult = shouldPreemptivelyCompact({
          contextWindowTokens: chatModelInfo?.contextWindow ?? 8192,
          reserveTokens: chatModelInfo?.maxOutputTokens ?? 4096,
          estimatedPromptTokens: sysTokens + histTokens + chatToolDefsTokens,
          toolResultReducibleChars: chatToolResultReducible,
          historyTokens: histTokens,
          performanceThreshold: 20000,
        });

        if (chatRouteResult.route !== "fits") {
          logger.info(
            { route: chatRouteResult.route, overflow: chatRouteResult.overflowTokens, budget: chatRouteResult.promptBudget },
            "Preemptive context management triggered (chat)",
          );
        }

        switch (chatRouteResult.route) {
          case "fits":
            break;
          case "truncate_tool_results_only": {
            const trResult = truncateOversizedToolResultsInHistory(session.messages, chatMaxSingleChars);
            session.messages = trResult.messages;
            break;
          }
          case "compress":
            session.messages = await this.compressor.compress(session.messages);
            this.persistCompressedMessages(session.id, session.messages);
            break;
          case "compress_then_truncate": {
            session.messages = await this.compressor.compress(session.messages);
            const trResult2 = truncateOversizedToolResultsInHistory(session.messages, chatMaxSingleChars);
            session.messages = trResult2.messages;
            this.persistCompressedMessages(session.id, session.messages);
            break;
          }
        }

        const messages: LLMMessage[] = [systemMessage, ...session.messages];
        const response = await this.llm.complete({
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
        });

        // If there are tool calls, execute them
        if (response.toolCalls?.length) {
          // Add assistant message with tool calls
          session.messages.push({
            role: "assistant",
            content: response.content ?? "",
            toolCalls: response.toolCalls,
            reasoningContent: response.reasoningContent,
          });
          this.persistMessage(session.id, "assistant", response.content ?? "", {
            toolCalls: JSON.stringify(response.toolCalls),
            ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
          });

          // Execute each tool call
          for (const toolCall of response.toolCalls) {
            const toolName = toolCall.function.name;
            calledTools.push(toolName);
            options?.onToolCall?.(toolName, toolCall.function.arguments);

            const result = await this.executeTool(
              toolName,
              toolCall.function.arguments,
              session
            );

            options?.onToolResult?.(toolName, result);

            // Collect file attachments from tool results
            this.collectAttachments(result, attachments);

            // P0: 工具结果源头截断（学 OpenClaw tool-result-truncation）
            const maxResultChars = this.getMaxToolResultChars();
            const truncatedOutput = truncateToolResult(result.output, maxResultChars);

            // Add tool result message
            session.messages.push({
              role: "tool",
              content: truncatedOutput,
              toolCallId: toolCall.id,
            });
            this.persistMessage(session.id, "tool", truncatedOutput, {
              toolCallId: toolCall.id,
              toolName,
            });
          }

          // Continue the loop for another LLM call
          continue;
        }

        // No tool calls — we have the final response
        const responseText = response.content ?? "";

        // MEDIA: 自动处理管道 — 从 LLM 输出中解析附件
        const { cleanText, attachments: mediaAttachments } =
          await this.resolveMediaFromOutput(responseText);
        attachments.push(...mediaAttachments);

        session.messages.push({ role: "assistant", content: cleanText });
        this.persistMessage(session.id, "assistant", cleanText);
        session.updatedAt = new Date();
        this._status = "idle";

        // Phase A-1: 自动驱动进化引擎（学 Hermes run_agent.py:7660-7676）
        this.recordEvolutionInteraction({
          sessionId: session.id, userMessage, agentResponse: cleanText,
          toolCalls: calledTools, success: true,
        });

        return {
          sessionId: session.id,
          response: cleanText,
          toolCalls: calledTools,
          attachments,
        };
      }

      // Max iterations reached
      const fallback =
        "I've reached the maximum number of tool iterations. Here's what I've done so far.";
      session.messages.push({ role: "assistant", content: fallback });
      this.persistMessage(session.id, "assistant", fallback);
      this._status = "idle";

      // Phase A-1: 超时也记录到进化引擎
      this.recordEvolutionInteraction({
        sessionId: session.id, userMessage, agentResponse: fallback,
        toolCalls: calledTools, success: false, failureReason: "max_iterations_reached",
      });

      return {
        sessionId: session.id,
        response: fallback,
        toolCalls: calledTools,
        attachments,
      };
    } catch (error) {
      this._status = "error";
      // P0-A11: 错误时回滚消息，避免污染 session 历史（与 chatStream 对齐）
      if (session.messages.length > msgCountBeforeChat) {
        session.messages.length = msgCountBeforeChat;
      }
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ agentId: this.id, error: errMsg }, "Agent chat error");
      throw error;
    } finally {
      // P0-A9: 释放 session 锁
      lockRelease();
    }
  }

  /**
   * Stream a response to the user. Yields SSE-compatible JSON event strings.
   * Supports full tool-call loop: uses complete() for tool iterations,
   * then stream() for the final text response.
   *
   * @param opts.llmOverride  Per-request LLM config override (e.g. model/apiKey/baseUrl).
   *   Creates a temporary LLMProvider for this request only — does NOT mutate the agent's
   *   global config. Inspired by Letta's model_copy(update=...) immutable override pattern.
   */
  async *chatStream(
    userMessage: string,
    sessionId?: string,
    opts?: {
      llmOverride?: Record<string, unknown>;
      signal?: AbortSignal;
      images?: Array<{ data: string; mimeType: string }>;  // B-4: 多模态图片
    }
  ): AsyncGenerator<{ type: string; [key: string]: unknown }, void, unknown> {
    const session = this.getSession(sessionId);

    // P0-A9: per-session 并发锁
    await this.acquireSessionLock(session.id);
    const lockRelease = this.createSessionLock(session.id);

    this._status = "running";
    this._lastActivity = new Date();

    // Create a per-request LLM provider if override is specified (avoids global mutation)
    const llm = opts?.llmOverride
      ? new LLMProvider({ ...this.config.llmProvider, ...opts.llmOverride } as any)
      : this.llm;

    // P0: Sanitize session messages BEFORE every chatStream call.
    // Handles corrupted state from previous crashed chatStream runs
    // (e.g. assistant with tool_calls pushed but tool execution failed).
    session.messages = this.sanitizeMessages(session.messages);

    // B-4: 根据是否有图片决定用 string 还是 ContentPart[]
    const images = opts?.images;
    if (images?.length && this.config.llmProvider.supportsVision) {
      // 学 OpenClaw: 支持 vision 的模型用多模态格式
      const contentParts: ContentPart[] = [
        { type: "text", text: userMessage },
        ...images.map(img => ({
          type: "image_url" as const,
          image_url: { url: `data:${img.mimeType};base64,${img.data}` },
        })),
      ];
      session.messages.push({ role: "user", content: contentParts });
    } else if (images?.length) {
      // 学 Hermes: 不支持 vision 的模型，添加占位提示
      const hint = images.map((_, i) => `[图片 ${i + 1}: 当前模型不支持图片分析]`).join("\n");
      const combined = userMessage ? `${hint}\n\n${userMessage}` : hint;
      session.messages.push({ role: "user", content: combined });
    } else {
      session.messages.push({ role: "user", content: userMessage });
    }
    this.persistMessage(session.id, "user", userMessage);

    const systemContent = this.promptEngine.build(session, this.tools);
    const systemMessage: LLMMessage = { role: "system", content: systemContent };

    const toolDefs = this.buildToolDefinitions();

    // P0-token: Log token budget before first LLM call for debugging timeouts
    const sysPromptTokens = this.compressor.estimateTokens([systemMessage]);
    const toolDefsJson = JSON.stringify(toolDefs);
    const toolDefsTokenEst = Math.ceil(toolDefsJson.length / 4);
    const histTokensEst = this.compressor.estimateTokens(session.messages);
    logger.info(
      { agentId: this.id, sessionId: session.id,
        sysPromptTokens, toolDefsTokens: toolDefsTokenEst, historyTokens: histTokensEst,
        totalEstimate: sysPromptTokens + toolDefsTokenEst + histTokensEst,
        toolCount: toolDefs.length, msgCount: session.messages.length },
      "Token budget before LLM call"
    );

    let iterations = 0;
    const maxIter = this.config.maxToolIterations;
    const calledTools: string[] = []; // Phase A-1: 跟踪工具调用，供进化引擎使用
    // Snapshot message count so we can rollback on error
    const msgCountBeforeLoop = session.messages.length;

    try {
      while (iterations < maxIter) {
        iterations++;

        // Phase 0: 修剪旧工具结果（每轮都执行，成本极低）
        const pruneResult = this.compressor.pruneOldToolResults(session.messages);
        if (pruneResult.prunedCount > 0) {
          session.messages = pruneResult.messages;
          logger.info({ pruned: pruneResult.prunedCount }, "Pruned old tool results (chatStream)");
        }

        // P0: 预防性溢出 4 路路由（替代简单 shouldCompress）
        // 学 OpenClaw preemptive-compaction: fits / truncate_only / compress / compress+truncate
        const sysTokens = this.compressor.estimateTokens([systemMessage]);
        const histTokens = this.compressor.estimateTokens(session.messages);
        const maxSingleChars = this.getMaxToolResultChars();
        const toolResultReducible = estimateToolResultReducibleChars(session.messages, maxSingleChars);
        const modelInfo = this.getModelDef();
        const routeResult = shouldPreemptivelyCompact({
          contextWindowTokens: modelInfo?.contextWindow ?? 8192,
          reserveTokens: modelInfo?.maxOutputTokens ?? 4096,
          estimatedPromptTokens: sysTokens + histTokens + toolDefsTokenEst,
          toolResultReducibleChars: toolResultReducible,
          historyTokens: histTokens,
          performanceThreshold: 20000,
        });

        if (routeResult.route !== "fits") {
          logger.info(
            { route: routeResult.route, overflow: routeResult.overflowTokens, budget: routeResult.promptBudget },
            "Preemptive context management triggered",
          );
        }

        switch (routeResult.route) {
          case "fits":
            break;
          case "truncate_tool_results_only": {
            const trResult = truncateOversizedToolResultsInHistory(session.messages, maxSingleChars);
            session.messages = trResult.messages;
            break;
          }
          case "compress":
            session.messages = await this.compressor.compress(session.messages);
            this.persistCompressedMessages(session.id, session.messages);
            break;
          case "compress_then_truncate": {
            session.messages = await this.compressor.compress(session.messages);
            const trResult2 = truncateOversizedToolResultsInHistory(session.messages, maxSingleChars);
            session.messages = trResult2.messages;
            this.persistCompressedMessages(session.id, session.messages);
            break;
          }
        }

        const messages: LLMMessage[] = [systemMessage, ...session.messages];

        // Use complete() to detect and execute tool calls
        const response = await llm.complete({
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          signal: opts?.signal,
        });

        logger.info(
          { agentId: this.id, iteration: iterations,
            finishReason: response.finishReason,
            hasContent: !!response.content,
            toolCallCount: response.toolCalls?.length ?? 0 },
          "LLM complete() response received"
        );

        if (response.toolCalls?.length) {
          // Yield any text content generated alongside tool calls
          if (response.content) {
            yield { type: "content", content: response.content };
          }

          session.messages.push({
            role: "assistant",
            content: response.content ?? "",
            toolCalls: response.toolCalls,
            reasoningContent: response.reasoningContent,
          });
          this.persistMessage(session.id, "assistant", response.content ?? "", {
            toolCalls: JSON.stringify(response.toolCalls),
            ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
          });

          // Execute each tool call
          for (const toolCall of response.toolCalls) {
            const toolName = toolCall.function.name;
            calledTools.push(toolName); // Phase A-1: 跟踪工具名

            yield { type: "tool_call", toolCallId: toolCall.id, name: toolName, args: toolCall.function.arguments };

            const result = await this.executeTool(
              toolName,
              toolCall.function.arguments,
              session
            );

            yield {
              type: "tool_result",
              toolCallId: toolCall.id,
              name: toolName,
              success: result.success,
              output: result.output?.slice(0, 2000),
              error: result.success ? undefined : result.error,
            };

            // 从工具结果中提取文件附件（与 chat() 对齐）
            const toolAttachments: Attachment[] = [];
            this.collectAttachments(result, toolAttachments);
            for (const att of toolAttachments) {
              yield { type: "attachment", ...att };
            }

            // P0: 工具结果源头截断（学 OpenClaw tool-result-truncation）
            const streamMaxChars = this.getMaxToolResultChars();
            const streamTruncated = truncateToolResult(result.output, streamMaxChars);

            session.messages.push({
              role: "tool",
              content: streamTruncated,
              toolCallId: toolCall.id,
            });
            this.persistMessage(session.id, "tool", streamTruncated, {
              toolCallId: toolCall.id,
              toolName,
            });
          }

          // Continue loop for next LLM call with tool results
          continue;
        }

        // No tool calls — use the content from complete() directly.
        // All reference frameworks (Hermes, CrewAI, Letta) use the single-call
        // result as the final response. Do NOT make a redundant stream() call.
        const finalContent = response.content ?? "";

        if (finalContent) {
          // MEDIA: 自动处理管道 — 检测并解析输出中的 MEDIA: 标记
          const { cleanText, attachments: mediaAttachments } =
            await this.resolveMediaFromOutput(finalContent);

          yield { type: "content", content: cleanText };

          // 推送 MEDIA: 解析出的附件事件
          for (const att of mediaAttachments) {
            yield { type: "attachment", ...att };
          }

          session.messages.push({ role: "assistant", content: cleanText });
          this.persistMessage(session.id, "assistant", cleanText);
        } else {
          // Edge case: complete() returned neither toolCalls nor content.
          // Fall back to stream() as a safety net (e.g. model quirk).
          logger.warn({ agentId: this.id }, "complete() returned no content and no toolCalls, falling back to stream()");
          let streamed = "";
          for await (const chunk of llm.stream({ messages, signal: opts?.signal })) {
            streamed += chunk;
            yield { type: "content", content: chunk };
          }

          // 流式完成后也执行 MEDIA: 解析（附件事件追加发送）
          const { cleanText: streamClean, attachments: streamAttachments } =
            await this.resolveMediaFromOutput(streamed);

          for (const att of streamAttachments) {
            yield { type: "attachment", ...att };
          }

          session.messages.push({ role: "assistant", content: streamClean });
          this.persistMessage(session.id, "assistant", streamClean);
        }

        session.updatedAt = new Date();
        this._status = "idle";

        // Phase A-1: chatStream 也驱动进化引擎
        this.recordEvolutionInteraction({
          sessionId: session.id, userMessage,
          agentResponse: session.messages[session.messages.length - 1]?.content as string ?? "",
          toolCalls: calledTools, success: true,
        });
        return;
      }

      // Max iterations reached
      const fallback = "已达到最大工具调用次数，以上是目前的处理结果。";
      yield { type: "content", content: fallback };
      session.messages.push({ role: "assistant", content: fallback });
      this.persistMessage(session.id, "assistant", fallback);
      this._status = "idle";

      // Phase A-1: 超时也记录到进化引擎
      this.recordEvolutionInteraction({
        sessionId: session.id, userMessage, agentResponse: fallback,
        toolCalls: calledTools, success: false, failureReason: "max_iterations_reached",
      });
    } catch (error) {
      this._status = "error";
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ agentId: this.id, error: errMsg }, "Agent chatStream error");

      // Rollback session to the state right after the user message was added.
      // This prevents corrupted assistant/tool messages from poisoning future calls.
      if (session.messages.length > msgCountBeforeLoop) {
        logger.warn(
          { agentId: this.id, rollbackFrom: session.messages.length, rollbackTo: msgCountBeforeLoop },
          "Rolling back session messages after chatStream error"
        );
        session.messages.length = msgCountBeforeLoop;
      }

      // Yield error event so the SSE stream can communicate it to the frontend,
      // instead of just throwing (which may not propagate through async generators).
      yield { type: "error", error: errMsg };
    } finally {
      // P0-A9: 始终释放 session 锁，防止死锁
      // 修复：之前 lockRelease 只在 catch 和函数末尾调用，
      // 导致正常 return 路径（第640/647行）锁永不释放，后续请求死锁
      lockRelease();
    }
  }

  /** @deprecated Replaced by PromptEngine — kept as reference for migration. */
  // private buildSystemPrompt removed — now handled by PromptEngine.build()

  /** 获取当前模型定义（用于上下文管理决策） */
  private getModelDef() {
    return getModelById(
      this.config.llmProvider?.providerId ?? "",
      this.config.llmProvider?.model ?? "",
    );
  }

  /** 获取单条工具结果的最大字符数（基于模型上下文窗口） */
  private getMaxToolResultChars(): number {
    const modelDef = this.getModelDef();
    return calculateMaxSingleResultChars(modelDef?.contextWindow ?? 8192);
  }

  /**
   * Convert registered tools to LLM tool definitions.
   * Task 4: 动态裁剪 — 工具数超过上限时优先保留核心工具
   * Task 7: 模型不支持函数调用时跳过工具定义
   */
  private buildToolDefinitions(): LLMToolDef[] {
    // Task 7: 如果模型不支持函数调用，跳过工具定义（节省 token）
    const modelDef = this.getModelDef();
    if (modelDef && !modelDef.supportsFunctions) {
      logger.info(
        { model: modelDef.id, supportsFunctions: false },
        "Model does not support functions, skipping tool definitions",
      );
      return [];
    }

    const defs: LLMToolDef[] = [];
    for (const [name, tool] of this.tools) {
      // Prefer rawJsonSchema (used by MCP tools) over Zod→JSON conversion
      const parameters = tool.rawJsonSchema
        ? tool.rawJsonSchema
        : tool.parameters
          ? (zodToJsonSchema(tool.parameters, { target: "openAi" }) as Record<string, unknown>)
          : { type: "object", properties: {} };

      defs.push({
        type: "function",
        function: {
          name,
          description: tool.description,
          parameters,
        },
      });
    }

    // Task 4: 动态裁剪 — 工具数超过上限时，优先保留核心工具
    // 学 OpenClaw tool pruning: MCP 外部工具优先裁剪
    const MAX_TOOL_DEFS = 40;
    if (defs.length > MAX_TOOL_DEFS) {
      const core = defs.filter((d) => !d.function.name.startsWith("mcp_"));
      const external = defs.filter((d) => d.function.name.startsWith("mcp_"));
      const remaining = MAX_TOOL_DEFS - core.length;
      const pruned = remaining > 0
        ? [...core, ...external.slice(0, remaining)]
        : core.slice(0, MAX_TOOL_DEFS);
      logger.warn(
        { original: defs.length, pruned: pruned.length, droppedExternal: external.length - Math.max(0, remaining) },
        "Dynamic tool pruning: too many tools, truncated to limit",
      );
      return pruned;
    }

    return defs;
  }

  /**
   * Extract file attachments from a tool result.
   * Supports ToolResult.data containing filePath (string), outputPath (string),
   * or files (array of strings or {path, caption} objects).
   */
  private collectAttachments(result: ToolResult, attachments: Attachment[]): void {
    if (!result.success || !result.data) return;
    const d = result.data as Record<string, unknown>;

    // Single file path
    if (typeof d.filePath === "string" && d.filePath) {
      attachments.push({ path: d.filePath, caption: typeof d.caption === "string" ? d.caption : undefined });
    }
    if (typeof d.outputPath === "string" && d.outputPath) {
      attachments.push({ path: d.outputPath });
    }

    // Array of files
    if (Array.isArray(d.files)) {
      for (const f of d.files) {
        if (typeof f === "string" && f) {
          attachments.push({ path: f });
        } else if (f && typeof f === "object" && typeof (f as Record<string, unknown>).path === "string") {
          const fo = f as Record<string, unknown>;
          attachments.push({
            path: fo.path as string,
            caption: typeof fo.caption === "string" ? fo.caption : undefined,
            mimeType: typeof fo.mimeType === "string" ? fo.mimeType : undefined,
          });
        }
      }
    }
  }

  /**
   * MEDIA: 自动处理管道
   * 从 LLM 输出文本中解析 MEDIA: 标记，加载并存储为本地附件
   *
   * 对标 OpenClaw 的自动媒体处理流程：
   * 1. 调用 splitMediaFromOutput() 分离文本和 MEDIA: 标记
   * 2. 对每个标记调用 resolveOutboundAttachment() 加载 → 验证 → 存储
   * 3. 失败时仅记录警告，不中断主流程
   */
  private async resolveMediaFromOutput(raw: string): Promise<{
    cleanText: string;
    attachments: Attachment[];
  }> {
    const parsed = splitMediaFromOutput(raw);
    if (parsed.mediaUrls.length === 0) {
      return { cleanText: raw, attachments: [] };
    }

    logger.info(
      { count: parsed.mediaUrls.length, urls: parsed.mediaUrls },
      "Detected MEDIA: tokens in LLM output"
    );

    const attachments: Attachment[] = [];
    for (const mediaUrl of parsed.mediaUrls) {
      try {
        const saved = await resolveOutboundAttachment(mediaUrl);
        attachments.push({
          path: saved.path,
          mimeType: saved.contentType,
          kind: kindFromMime(saved.contentType),
          size: saved.size,
          filename: path.basename(saved.path),
        });
      } catch (err) {
        logger.warn(
          { mediaUrl, error: err instanceof Error ? err.message : String(err) },
          "Failed to resolve MEDIA: token — skipping"
        );
      }
    }

    return { cleanText: parsed.text, attachments };
  }

  /** Execute a tool by name. */
  private async executeTool(
    name: string,
    argsString: string,
    session: Session
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: `Tool "${name}" not found.`,
        error: `Unknown tool: ${name}`,
      };
    }

    try {
      // Security check: verify tool permission
      let sandboxLevel: "none" | "process" | "container" | "docker" | "ssh" = "none";
      if (this.securityManager) {
        const perm = this.securityManager.checkPermission(name, this.id);
        if (!perm.allowed) {
          logger.warn({ agentId: this.id, tool: name, reason: perm.reason }, "Tool execution denied");
          return {
            success: false,
            output: `Permission denied for tool "${name}": ${perm.reason ?? "blocked by policy"}`,
            error: "Permission denied",
          };
        }
        sandboxLevel = perm.sandboxLevel;
      }

      // P2-09: Parse args separately with clear error message
      let args: unknown;
      try {
        args = JSON.parse(argsString);
      } catch (parseErr) {
        const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        logger.warn({ agentId: this.id, tool: name, error: parseMsg }, "Invalid tool arguments JSON");
        return {
          success: false,
          output: `Invalid arguments for tool "${name}": ${parseMsg}`,
          error: `JSON parse error: ${parseMsg}`,
        };
      }

      // Security: resolve {{secret:NAME}} token references in args
      if (this.securityManager) {
        args = this.securityManager.tokenProxy.resolveObject(args, this.id, name);
      }

      const context = {
        agentId: this.id,
        sessionId: session.id,
        userId: session.userId,
        channelId: session.channelId,
      };

      // Execute with process-level sandbox if required
      if (sandboxLevel === "process" && this.securityManager) {
        logger.info({ agentId: this.id, tool: name }, "Executing tool in process sandbox");
        const sandboxResult = await this.securityManager.sandbox.executeWithTimeout(
          () => tool.execute(args, context),
          { timeoutMs: 30000, maxHeapMB: 128 },
        );

        if (sandboxResult.timedOut) {
          this.securityManager.recordExecution(name, this.id, "error");
          return {
            success: false,
            output: `Tool "${name}" timed out in sandbox`,
            error: sandboxResult.error,
          };
        }
        if (sandboxResult.error) {
          this.securityManager.recordExecution(name, this.id, "error");
          return {
            success: false,
            output: `Tool "${name}" error in sandbox: ${sandboxResult.error}`,
            error: sandboxResult.error,
          };
        }

        // P1-10: Safe access — result may be undefined if sandbox had an unexpected exit
        this.securityManager.recordExecution(name, this.id, "success");
        return sandboxResult.result ?? {
          success: true,
          output: "Tool completed (no structured result returned)",
        };
      }

      // Execute with Docker container sandbox
      if ((sandboxLevel === "docker" || sandboxLevel === "container") && this.securityManager) {
        const dockerBackend = this.securityManager.dockerSandbox;
        if (dockerBackend) {
          logger.info({ agentId: this.id, tool: name }, "Executing tool in Docker sandbox");
          const dockerResult = await dockerBackend.execute(
            JSON.stringify(args),
            "javascript",
          );

          if (!dockerResult.success) {
            this.securityManager.recordExecution(name, this.id, "error");
            return {
              success: false,
              output: `Tool "${name}" error in Docker sandbox: ${dockerResult.error ?? dockerResult.output}`,
              error: dockerResult.error,
            };
          }

          this.securityManager.recordExecution(name, this.id, "success");
          return { success: true, output: dockerResult.output };
        }
        // Fallback to process sandbox if Docker not available
        logger.warn({ agentId: this.id, tool: name }, "Docker sandbox not available, falling back to process sandbox");
        const fallbackResult = await this.securityManager.sandbox.executeWithTimeout(
          () => tool.execute(args, context),
          { timeoutMs: 30000, maxHeapMB: 128 },
        );
        this.securityManager.recordExecution(name, this.id, fallbackResult.error ? "error" : "success");
        return fallbackResult.result ?? {
          success: !fallbackResult.error,
          output: fallbackResult.error ?? "Tool completed (fallback from Docker to process sandbox)",
          error: fallbackResult.error,
        };
      }

      // Execute with SSH remote sandbox
      if (sandboxLevel === "ssh" && this.securityManager) {
        const sshBackend = this.securityManager.sshSandbox;
        if (sshBackend) {
          logger.info({ agentId: this.id, tool: name }, "Executing tool in SSH sandbox");
          const sshResult = await sshBackend.execute(
            JSON.stringify(args),
            "javascript",
          );

          if (!sshResult.success) {
            this.securityManager.recordExecution(name, this.id, "error");
            return {
              success: false,
              output: `Tool "${name}" error in SSH sandbox: ${sshResult.error ?? sshResult.output}`,
              error: sshResult.error,
            };
          }

          this.securityManager.recordExecution(name, this.id, "success");
          return { success: true, output: sshResult.output };
        }
        // Fallback to process sandbox if SSH not configured
        logger.warn({ agentId: this.id, tool: name }, "SSH sandbox not available, falling back to process sandbox");
        const fallbackResult = await this.securityManager.sandbox.executeWithTimeout(
          () => tool.execute(args, context),
          { timeoutMs: 30000, maxHeapMB: 128 },
        );
        this.securityManager.recordExecution(name, this.id, fallbackResult.error ? "error" : "success");
        return fallbackResult.result ?? {
          success: !fallbackResult.error,
          output: fallbackResult.error ?? "Tool completed (fallback from SSH to process sandbox)",
          error: fallbackResult.error,
        };
      }

      // Normal execution (no sandbox or sandbox level is "none")
      const result = await tool.execute(args, context);
      if (this.securityManager) {
        this.securityManager.recordExecution(name, this.id, "success");
      }
      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ agentId: this.id, tool: name, error: errMsg }, "Tool execution error");
      if (this.securityManager) {
        this.securityManager.recordExecution(name, this.id, "error");
      }
      return {
        success: false,
        output: `Error executing tool "${name}": ${errMsg}`,
        error: errMsg,
      };
    }
  }

  /** Update agent configuration. */
  updateConfig(partial: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...partial };
    if (partial.llmProvider) {
      this.llm = new LLMProvider(this.config.llmProvider);

      // Sync compressor's context window when model changes
      const modelDef = getModelById(
        this.config.llmProvider.providerId ?? "",
        this.config.llmProvider.model ?? "",
      );
      if (this.compressor && "updateContextWindow" in this.compressor) {
        (this.compressor as ContextCompressor).updateContextWindow(
          modelDef?.contextWindow ?? 8192,
        );
      }
    }
    // Invalidate prompt cache when config changes
    this.promptEngine.updateConfig({ agentConfig: this.config });
  }

  /**
   * C-4: 清除 Prompt 缓存（技能文件变更后调用）。
   * 学 Hermes clear_skills_system_prompt_cache 模式。
   */
  invalidatePromptCache(): void {
    this.promptEngine.invalidateCache();
  }

  // ─── Persistence helpers ──────────────────────────────────

  /**
   * 压缩后将内存消息持久化回 DB — 防止重启后历史还原。
   * 使用事务性 replaceConvMessages 原子替换所有消息。
   */
  private persistCompressedMessages(sessionId: string, messages: LLMMessage[]): void {
    if (!this.persistEnabled) return;
    try {
      const dbMessages = messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : m.content ? JSON.stringify(m.content) : null,
        toolCallId: m.toolCallId,
        toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : undefined,
      }));
      replaceConvMessages(sessionId, dbMessages);
      logger.info(
        { sessionId, messageCount: messages.length },
        "Compressed messages persisted to DB",
      );
    } catch (err) {
      logger.warn({ sessionId, error: err }, "Failed to persist compressed messages to DB");
    }
  }

  /** Persist a single message to SQLite and auto-generate title on first user message. */
  private persistMessage(
    convId: string,
    role: string,
    content: string,
    opts?: { toolCallId?: string; toolCalls?: string; toolName?: string; reasoningContent?: string },
  ): void {
    if (!this.persistEnabled) return;
    try {
      appendConvMessage(convId, role, content, opts);
      // Auto-generate title from first user message
      if (role === "user") {
        const conv = getConversation(convId);
        if (conv && !conv.title && conv.messageCount <= 1) {
          const title = content.replace(/\s+/g, " ").trim().slice(0, 50);
          if (title) updateConversationTitle(convId, title);
        }
      }
    } catch (err) {
      logger.warn({ convId, role, error: err }, "Failed to persist message");
    }
  }

  // ─── Evolution 闭环集成 (Phase A-1) ──────────────────────

  /**
   * 获取最近 N 条对话消息（用于 nudge review 上下文）。
   * 从最近更新的 session 中取消息。
   */
  getRecentMessages(count: number): LLMMessage[] {
    const sessions = Array.from(this.sessions.values());
    if (sessions.length === 0) return [];
    const latest = sessions.sort(
      (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
    )[0];
    return latest.messages.slice(-count);
  }

  /**
   * 记录交互到进化引擎（学 Hermes run_agent.py:7660-7676）。
   * 安全包裹：进化引擎故障不影响正常对话。
   */
  private recordEvolutionInteraction(data: {
    sessionId: string;
    userMessage: string;
    agentResponse: string;
    toolCalls: string[];
    success: boolean;
    failureReason?: string;
  }): void {
    const evolution = this.manager?.evolution;
    if (!evolution) return;
    try {
      evolution.recordInteraction({
        agentId: this.id,
        sessionId: data.sessionId,
        userMessage: data.userMessage,
        agentResponse: data.agentResponse,
        toolCalls: data.toolCalls,
        success: data.success,
        failureReason: data.failureReason,
      });
    } catch { /* 进化记录不应阻塞主流程 */ }
  }

  /** Stop the agent and clear sessions. */
  stop(): void {
    this._status = "stopped";
    this.sessions.clear();
  }

  /**
   * 释放临时 agent 资源（Phase B-1: 供 review agent 等临时实例使用）。
   * 清理对话历史和事件监听，防止内存泄漏。
   * 学 Hermes review_agent.close() 模式。
   */
  destroy(): void {
    this.sessions.clear();
    this._sessionLocks.clear();
    this.tools.clear();
    this._status = "stopped";
  }
}
