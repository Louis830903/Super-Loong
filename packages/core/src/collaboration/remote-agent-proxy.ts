/**
 * RemoteAgentProxy — 将远端 A2A Agent 包装为本地 IAgentLike 接口
 *
 * 使 SpeakerSelectionMethod / CrewExecutor 等算法无需区分本地/远端 Agent，
 * 通过统一的 chat() 签名透明化远端调用。
 *
 * - chat()    → 调用 A2AClient.sendMessage → 提取结果映射为 IAgentLike 返回值
 * - stream()  → 调用 A2AClient.sendStreamingMessage → 逐帧回调
 * - 自动注入 x-a2a-trace-id 串联跨进程追踪（由 A2AClient 内部处理）
 *
 * @see a2a-types.ts — IAgentLike 接口
 * @see a2a-client.ts — A2AClient
 */

import { randomUUID } from "node:crypto";
import pino from "pino";
import type { Attachment, ToolResult } from "../types/index.js";
import type {
  IAgentLike,
  A2AAgentCard,
  SendMessageResponse,
  StreamFrame,
} from "./a2a-types.js";
import { A2AClient, type A2AAuthConfig } from "./a2a-client.js";
import { createTextMessage } from "./a2a-message.js";
import { mapA2APartToAttachment } from "./a2a-types.js";

// ─── 日志（P2-1：统一使用 pino） ──────────────────────────────

const logger = pino({ name: "RemoteAgentProxy" });

const log = {
  info: (msg: string, data?: unknown) => data ? logger.info(data, msg) : logger.info(msg),
  warn: (msg: string, data?: unknown) => data ? logger.warn(data, msg) : logger.warn(msg),
  error: (msg: string, data?: unknown) => data ? logger.error(data, msg) : logger.error(msg),
};

// ─── RemoteAgentProxy ───────────────────────────────────────

/**
 * 远端 A2A Agent 代理：implements IAgentLike，
 * 使编排器 / CrewExecutor 无需感知本地 vs 远端差异。
 */
export class RemoteAgentProxy implements IAgentLike {
  /** 远端 Agent 元数据 */
  public readonly card: A2AAgentCard;

  /** 底层 A2A 客户端 */
  private readonly client: A2AClient;

  constructor(card: A2AAgentCard, auth?: A2AAuthConfig) {
    this.card = card;
    this.client = new A2AClient(card.url, auth);
  }

  // ─── IAgentLike.chat() 实现 ───────────────────────────────

  /**
   * 通过 A2A SendMessage RPC 调用远端 Agent。
   * 将远端响应（Task 或 Message）映射为 IAgentLike 标准返回值。
   */
  async chat(
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
  }> {
    const contextId = sessionId ?? randomUUID();

    // 如果有 onStream 回调且远端支持流式 → 走 SSE
    if (options?.onStream && this.card.capabilities.streaming) {
      return this.chatStreaming(userMessage, contextId, options);
    }

    // 非流式：同步 SendMessage
    const message = createTextMessage(userMessage, contextId);
    const response: SendMessageResponse = await this.client.sendMessage({
      message,
      protocolVersion: "0.3.0",
    });

    return this.mapResponse(response, contextId);
  }

  // ─── 流式调用 ─────────────────────────────────────────────

  /**
   * SSE 流式调用远端 Agent。
   */
  private async chatStreaming(
    userMessage: string,
    contextId: string,
    options: {
      onStream?: (chunk: string) => void;
      onToolCall?: (name: string, args: unknown) => void;
      onToolResult?: (name: string, result: ToolResult) => void;
    },
  ): Promise<{
    sessionId: string;
    response: string;
    toolCalls: string[];
    attachments: Attachment[];
  }> {
    const message = createTextMessage(userMessage, contextId);
    let fullResponse = "";
    const allAttachments: Attachment[] = [];

    await this.client.sendStreamingMessage(
      { message, protocolVersion: "0.3.0" },
      (frame: StreamFrame) => {
        switch (frame.type) {
          case "message": {
            // 提取文本内容并流式回调
            for (const part of frame.message.parts) {
              if (part.kind === "text") {
                fullResponse += part.text;
                options.onStream?.(part.text);
              }
            }
            break;
          }
          case "artifact": {
            // 产物映射为附件
            for (const part of frame.artifact.parts) {
              allAttachments.push(mapA2APartToAttachment(part));
            }
            break;
          }
          case "status": {
            log.info("远端 Task 状态更新", {
              taskId: frame.taskId,
              state: frame.status.state,
            });
            break;
          }
          case "done": {
            log.info("远端流式调用完成", { taskId: frame.taskId });
            break;
          }
          // P0-4修复：处理服务端发送的 error 帧，记录错误并合并到返回结果
          case "error": {
            log.error("远端流式调用收到错误帧", {
              error: frame.error,
              code: frame.code,
            });
            fullResponse += `[Error: ${frame.error}]`;
            break;
          }
        }
      },
    );

    return {
      sessionId: contextId,
      response: fullResponse,
      toolCalls: [],
      attachments: allAttachments,
    };
  }

  // ─── 响应映射 ─────────────────────────────────────────────

  /**
   * 将 A2A SendMessageResponse 映射为 IAgentLike 返回值。
   */
  private mapResponse(
    response: SendMessageResponse,
    contextId: string,
  ): {
    sessionId: string;
    response: string;
    toolCalls: string[];
    attachments: Attachment[];
  } {
    if (response.type === "message") {
      // 纯 Message 响应：提取文本和附件
      const texts: string[] = [];
      const attachments: Attachment[] = [];

      for (const part of response.message.parts) {
        if (part.kind === "text") {
          texts.push(part.text);
        } else {
          attachments.push(mapA2APartToAttachment(part));
        }
      }

      return {
        sessionId: contextId,
        response: texts.join("\n"),
        toolCalls: [],
        attachments,
      };
    }

    // Task 响应：提取最后一条 agent message + artifacts
    const task = response.task;
    const texts: string[] = [];
    const attachments: Attachment[] = [];

    // 从 history 提取最后一条 agent 消息
    const lastAgentMsg = [...task.history].reverse().find((m) => m.role === "agent");
    if (lastAgentMsg) {
      for (const part of lastAgentMsg.parts) {
        if (part.kind === "text") {
          texts.push(part.text);
        } else {
          attachments.push(mapA2APartToAttachment(part));
        }
      }
    }

    // 从 artifacts 提取附件
    for (const artifact of task.artifacts) {
      for (const part of artifact.parts) {
        attachments.push(mapA2APartToAttachment(part));
      }
    }

    return {
      sessionId: task.contextId,
      response: texts.join("\n") || `[Task ${task.id}: ${task.status.state}]`,
      toolCalls: [],
      attachments,
    };
  }
}
