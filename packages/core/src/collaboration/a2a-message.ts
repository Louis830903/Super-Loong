/**
 * A2A Message / Part / Artifact 映射层
 *
 * 提供 Attachment ↔ Part 双向映射的统一导出，
 * 以及 A2AMessage / Artifact 工厂函数（自动生成 ID + 默认值填充）。
 *
 * @see a2a-types.ts — 基础类型定义 + 底层映射实现
 */

import { randomUUID } from "node:crypto";
import type { Attachment } from "../types/index.js";
import {
  type A2AMessage,
  type Artifact,
  type Part,
  mapAttachmentToA2APart,
  mapA2APartToAttachment,
} from "./a2a-types.js";

// ─── 统一重导出底层映射函数 ─────────────────────────────────
// 消费方只需从 a2a-message.ts 导入即可，无需关心底层实现位置

export { mapAttachmentToA2APart, mapA2APartToAttachment };

// ─── Message 工厂 ───────────────────────────────────────────

/** createMessage 选项（除 role 和 parts 外的可选字段） */
export interface CreateMessageOptions {
  /** 自定义 messageId，不传则自动生成 UUID */
  messageId?: string;
  /** 会话上下文 ID */
  contextId?: string;
  /** 关联的 Task ID */
  taskId?: string;
  /** 引用的历史 Task ID 列表 */
  referenceTaskIds?: string[];
  /** 自定义元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 创建 A2AMessage，自动生成 messageId。
 *
 * @param role - 发送方角色（"user" | "agent"）
 * @param parts - 消息内容（Part 数组）
 * @param opts  - 可选参数（contextId / taskId / 自定义 messageId 等）
 */
export function createMessage(
  role: "user" | "agent",
  parts: Part[],
  opts?: CreateMessageOptions,
): A2AMessage {
  return {
    messageId: opts?.messageId ?? randomUUID(),
    role,
    parts,
    ...(opts?.contextId != null && { contextId: opts.contextId }),
    ...(opts?.taskId != null && { taskId: opts.taskId }),
    ...(opts?.referenceTaskIds && { referenceTaskIds: opts.referenceTaskIds }),
    ...(opts?.metadata && { metadata: opts.metadata }),
  };
}

// ─── Artifact 工厂 ──────────────────────────────────────────

/**
 * 创建 Artifact 产物，自动生成 artifactId。
 *
 * @param name        - 产物名称（人类可读）
 * @param parts       - 产物内容（Part 数组）
 * @param description - 可选描述
 * @param metadata    - 自定义元数据
 */
export function createArtifact(
  name: string,
  parts: Part[],
  description?: string,
  metadata?: Record<string, unknown>,
): Artifact {
  return {
    artifactId: randomUUID(),
    name,
    parts,
    ...(description != null && { description }),
    ...(metadata && { metadata }),
  };
}

// ─── 批量转换便利函数 ───────────────────────────────────────

/**
 * 将本地 Attachment 数组批量转换为 A2A Part 数组。
 * 便利函数，避免消费方手写 .map()。
 */
export function attachmentsToParts(attachments: Attachment[]): Part[] {
  return attachments.map(mapAttachmentToA2APart);
}

/**
 * 将 A2A Part 数组批量转换为本地 Attachment 数组。
 */
export function partsToAttachments(parts: Part[]): Attachment[] {
  return parts.map(mapA2APartToAttachment);
}

/**
 * 从纯文本快速构建一条 user 消息（最常见场景的快捷方式）。
 *
 * @param text      - 消息文本
 * @param contextId - 可选上下文 ID
 */
export function createTextMessage(
  text: string,
  contextId?: string,
): A2AMessage {
  return createMessage("user", [{ kind: "text", text }], { contextId });
}
