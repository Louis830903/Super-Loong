/**
 * LLM Provider abstraction layer.
 * Supports OpenAI, Anthropic, Ollama, and custom endpoints.
 * Includes automatic fallback to backup provider on failure.
 */

import OpenAI from "openai";
import pino from "pino";
import type { LLMMessage, LLMProviderConfig, LLMResponse, LLMToolCall } from "../types/index.js";
import { partitionToolCallsByJsonValidity } from "./tool-call-validator.js";

const logger = pino({ name: "llm-provider" });

export interface LLMToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMCompletionParams {
  messages: LLMMessage[];
  tools?: LLMToolDef[];
  stream?: boolean;
  /** Optional AbortSignal to cancel the request (e.g. when client disconnects). */
  signal?: AbortSignal;
}

/**
 * Unified LLM client that wraps OpenAI-compatible APIs.
 * Works with OpenAI, Anthropic (via proxy), Ollama, and any compatible endpoint.
 *
 * Handles provider-specific reasoning/thinking mode requirements:
 * - Kimi/DeepSeek/GLM/Qwen: use `reasoning_content` field on assistant messages
 * - MiniMax: thinking is embedded in `content` via `<think>` tags (no separate field)
 * - Non-reasoning models: no reasoning fields needed
 */
export class LLMProvider {
  private client: OpenAI;
  private config: LLMProviderConfig;
  private fallbackProvider?: LLMProvider;

  constructor(config: LLMProviderConfig) {
    this.config = config;

    // [CORE-P1-03] Anthropic 原生 API 非 OpenAI 兼容格式
    //
    // 【问题】用 OpenAI SDK 调用 https://api.anthropic.com/v1/chat/completions
    //   会 404（Anthropic 端点是 /v1/messages，协议也不一样）。
    // 【修复】构造时即拦截，避免问题延迟到首次对话才暴露；
    //   用户必须显式配置 OpenAI 兼容代理（如 OpenRouter）或切其他 provider。
    if (config.type === "anthropic") {
      const url = config.baseUrl ?? "";
      if (!url || url.includes("anthropic.com")) {
        throw new Error(
          "Anthropic provider 不支持 OpenAI 兼容的 baseUrl 配置。" +
            "请使用 OpenAI 兼容代理（如 OpenRouter: https://openrouter.ai/api/v1）" +
            "或改用其他 OpenAI 兼容 provider。",
        );
      }
    }

    this.client = new OpenAI({
      apiKey: config.apiKey ?? "dummy",
      baseURL: this.resolveBaseUrl(config),
      timeout: 120_000,        // 120s — align with frontend AbortController timeout
      maxRetries: 3,           // 3 automatic retries on transient errors (+指数退避)
    });

    if (config.fallback) {
      this.fallbackProvider = new LLMProvider(config.fallback);
    }
  }

  /**
   * Check if this provider uses the `reasoning_content` field format.
   * Kimi, DeepSeek, GLM, and Qwen use this format.
   * MiniMax uses `<think>` tags embedded in `content` instead.
   */
  private usesReasoningContentField(): boolean {
    if (!this.config.supportsReasoning) return false;
    // MiniMax embeds thinking in content via <think> tags, not reasoning_content
    if (this.config.providerId === "minimax") return false;
    if (this.config.baseUrl?.includes("minimaxi.com")) return false;
    return true;
  }

  private resolveBaseUrl(config: LLMProviderConfig): string {
    if (config.baseUrl) return config.baseUrl;
    switch (config.type) {
      case "openai":
        return "https://api.openai.com/v1";
      case "anthropic":
        // [CORE-P1-03] Anthropic 原生 API 非 OpenAI 兼容，不能直接喂给 OpenAI SDK。
        // 用户必须显式配置 baseUrl 指向 OpenAI 兼容代理（如 OpenRouter:
        // https://openrouter.ai/api/v1 或本地代理）。若缺省则立即抛错，
        // 避免静默返回不可用端点导致运行期 "Connection error / 404 Not Found"。
        throw new Error(
          `Anthropic provider requires an OpenAI-compatible baseUrl (e.g. "https://openrouter.ai/api/v1"). ` +
            `Please set LLMProviderConfig.baseUrl; the native "https://api.anthropic.com/v1" endpoint is NOT supported by the OpenAI SDK used internally.`,
        );
      case "ollama":
        return "http://localhost:11434/v1";
      default:
        return "https://api.openai.com/v1";
    }
  }

  get modelName(): string {
    return this.config.model;
  }

  /**
   * Send a chat completion request.
   * Automatically falls back to backup provider on error.
   */
  async complete(params: LLMCompletionParams): Promise<LLMResponse> {
    try {
      return await this._complete(params);
    } catch (error) {
      if (this.fallbackProvider) {
        logger.warn(
          { provider: this.config.type, model: this.config.model, error },
          "Primary LLM failed, trying fallback"
        );
        return this.fallbackProvider.complete(params);
      }
      throw error;
    }
  }

  private async _complete(params: LLMCompletionParams): Promise<LLMResponse> {
    const needsReasoningField = this.usesReasoningContentField();

    // Hard AbortController timeout — ensures we NEVER hang beyond 120s
    // even if the upstream API accepts the connection but stops responding.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120_000);
    const signal = params.signal
      ? AbortSignal.any([params.signal, ac.signal])
      : ac.signal;

    try {
    const messages = params.messages.map((m) => {
      const base: OpenAI.Chat.ChatCompletionMessageParam = {
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      } as OpenAI.Chat.ChatCompletionMessageParam;

      if (m.role === "tool" && m.toolCallId) {
        return {
          role: "tool" as const,
          // B-3: tool 消息的 content 必须是 string（OpenAI 不支持 ContentPart[]）
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          tool_call_id: m.toolCallId,
        };
      }

      if (m.role === "assistant" && m.toolCalls?.length) {
        // P0-Qwen400-FIX: 双保险校验 — 即使上游 runtime 已过滤，
        // 到达 provider 层时仍再扫一遍，任何破损 tool_call 直接丢弃，
        // 确保发给 Qwen/OpenAI 的 payload 100% 合法，避免 400 InvalidParameter。
        const { valid: safeToolCalls, invalid: droppedToolCalls } =
          partitionToolCallsByJsonValidity(m.toolCalls);
        for (const dropped of droppedToolCalls) {
          logger.warn(
            {
              tool: dropped.toolCall.function.name,
              toolCallId: dropped.toolCall.id,
              error: dropped.error,
            },
            "Provider-layer safeguard dropped tool_call with invalid JSON arguments",
          );
        }

        // 所有 tool_call 都破损时降级成纯 content 消息（避免 API 拒收 toolCalls=[]）
        if (safeToolCalls.length === 0) {
          return {
            role: "assistant" as const,
            content: m.content ?? "",
          } as OpenAI.Chat.ChatCompletionMessageParam;
        }

        const msg: Record<string, unknown> = {
          role: "assistant" as const,
          content: m.content,
          tool_calls: safeToolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        };
        // Only inject reasoning_content for models that use this field format
        // (Kimi, DeepSeek, GLM, Qwen). MiniMax embeds thinking in <think> tags
        // within content, so it doesn't need this field.
        if (needsReasoningField) {
          msg.reasoning_content = m.reasoningContent ?? "";
        }
        return msg as any;
      }

      return base;
    });

    const requestParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.config.model,
      messages,
      ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
      max_tokens: this.config.maxTokens,
    };

    if (params.tools?.length) {
      requestParams.tools = params.tools.map((t) => ({
        type: "function" as const,
        function: t.function,
      }));
    }

    const response = await this.client.chat.completions.create(requestParams, { signal });
    const choice = response.choices[0];

    // Extract reasoning_content only for models that use this field format
    // MiniMax thinking is already embedded in content via <think> tags
    let reasoningContent: string | undefined;
    if (needsReasoningField) {
      const rawMessage = choice?.message as unknown as Record<string, unknown> | undefined;
      reasoningContent = (rawMessage?.reasoning_content as string) || undefined;
    }

    const toolCalls: LLMToolCall[] | undefined = choice?.message?.tool_calls?.map(
      (tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })
    );

    return {
      content: choice?.message?.content ?? null,
      toolCalls,
      reasoningContent,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
      finishReason: this.mapFinishReason(choice?.finish_reason),
    };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stream a chat completion. Yields partial content chunks.
   * Automatically falls back to backup provider on error (aligned with complete()).
   */
  async *stream(params: LLMCompletionParams): AsyncGenerator<string, void, unknown> {
    try {
      yield* this._stream(params);
    } catch (error) {
      if (this.fallbackProvider) {
        logger.warn(
          { provider: this.config.type, model: this.config.model, error },
          "Primary LLM stream failed, trying fallback"
        );
        yield* this.fallbackProvider.stream(params);
      } else {
        throw error;
      }
    }
  }

  private async *_stream(params: LLMCompletionParams): AsyncGenerator<string, void, unknown> {
    const needsReasoningField = this.usesReasoningContentField();

    // Hard AbortController timeout for streaming too
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120_000);
    const signal = params.signal
      ? AbortSignal.any([params.signal, ac.signal])
      : ac.signal;

    const messages = params.messages.map((m) => {
      // Tool result messages must include tool_call_id
      if (m.role === "tool" && m.toolCallId) {
        return {
          role: "tool" as const,
          // B-3: tool 消息的 content 必须是 string
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          tool_call_id: m.toolCallId,
        };
      }
      // Assistant messages with tool calls must include tool_calls array
      // (required by API when subsequent tool-result messages reference them)
      if (m.role === "assistant" && m.toolCalls?.length) {
        // P1 流式路径双保险：与 complete() 对齐，过滤破损 JSON 的 tool_calls
        const { valid: safeToolCalls, invalid: droppedToolCalls } =
          partitionToolCallsByJsonValidity(m.toolCalls);
        for (const dropped of droppedToolCalls) {
          logger.warn(
            {
              tool: dropped.toolCall.function.name,
              toolCallId: dropped.toolCall.id,
              error: dropped.error,
            },
            "Stream path: dropped tool_call with invalid JSON arguments",
          );
        }
        // 所有 tool_call 都破损时降级成纯 content 消息
        if (safeToolCalls.length === 0) {
          return {
            role: "assistant" as const,
            content: m.content ?? "",
          } as OpenAI.Chat.ChatCompletionMessageParam;
        }

        const msg: Record<string, unknown> = {
          role: "assistant" as const,
          content: m.content,
          tool_calls: safeToolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        };
        if (needsReasoningField) {
          msg.reasoning_content = m.reasoningContent ?? "";
        }
        return msg as any;
      }
      return {
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      };
    }) as OpenAI.Chat.ChatCompletionMessageParam[];

    const requestParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: this.config.model,
      messages,
      ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
      max_tokens: this.config.maxTokens,
      stream: true,
    };

    // B-9: 传递 tools 参数，与 complete() 对齐
    if (params.tools?.length) {
      requestParams.tools = params.tools.map((t) => ({
        type: "function" as const,
        function: t.function,
      }));
    }

    const stream = await this.client.chat.completions.create(requestParams, { signal });

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          yield delta;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private mapFinishReason(
    reason: string | null | undefined
  ): LLMResponse["finishReason"] {
    switch (reason) {
      case "stop":
        return "stop";
      case "tool_calls":
        return "tool_calls";
      case "length":
        return "length";
      default:
        return "stop";
    }
  }
}
