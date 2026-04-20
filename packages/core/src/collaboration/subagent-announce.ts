/**
 * Sub-Agent Announce — 子代理完成通报系统（学 OpenClaw Sub-Agent Announce）
 *
 * 对标 OpenClaw:
 * - src/agents/subagent-announce-delivery.ts (推送式通报 + 递归回退)
 *
 * 核心流程：
 * 1. 子代理完成后，将结果格式化为通报消息
 * 2. 注入到父代理会话作为系统/用户消息
 * 3. 若父代理会话已关闭，递归回退到更上层
 * 4. 深度1→主会话：作为用户消息注入
 * 5. 深度2→深度1：作为内部事件注入
 */

import pino from "pino";
import type { SubagentRecord } from "./subagent-spawn.js";

const logger = pino({ name: "subagent-announce" });

// ─── 通报载荷 ──────────────────────────────────────────────

export interface AnnouncePayload {
  /** 子代理 ID */
  subagentId: string;
  /** 子代理会话 ID */
  childSessionId: string;
  /** 父代理会话 ID */
  parentSessionId: string;
  /** 任务描述 */
  task: string;
  /** 可选标签 */
  label?: string;
  /** 完成状态 */
  status: "success" | "error" | "timeout" | "killed";
  /** 结果文本 */
  result: string;
  /** 错误信息（status != "success" 时） */
  error?: string;
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** 嵌套深度 */
  depth: number;
}

// ─── 消息注入回调 ───────────────────────────────────────────

/**
 * 消息注入回调：将通报消息注入到目标会话。
 * 由上层 API 注入，实际实现为向目标 session 追加消息。
 */
export type InjectMessageFn = (
  targetSessionId: string,
  content: string,
  role: "user" | "system",
) => Promise<boolean>;

// ─── 格式化工具 ─────────────────────────────────────────────

/**
 * 将子代理完成结果格式化为通报消息。
 * 对标 OpenClaw 的 announce-delivery 格式。
 */
export const formatAnnounceMessage = (payload: AnnouncePayload): string => {
  const statusEmoji: Record<string, string> = {
    success: "✅",
    error: "❌",
    timeout: "⏰",
    killed: "🛑",
  };

  const emoji = statusEmoji[payload.status] ?? "ℹ️";
  const durationStr = payload.durationMs < 1000
    ? `${payload.durationMs}ms`
    : `${(payload.durationMs / 1000).toFixed(1)}s`;

  const lines = [
    `${emoji} **Sub-agent report** ${payload.label ? `[${payload.label}]` : ""}`,
    "",
    `**Task**: ${payload.task}`,
    `**Status**: ${payload.status} (${durationStr})`,
  ];

  if (payload.status === "success" && payload.result) {
    lines.push("", "**Result**:", payload.result);
  } else if (payload.error) {
    lines.push("", `**Error**: ${payload.error}`);
  } else if (payload.result) {
    lines.push("", "**Partial result**:", payload.result);
  }

  return lines.join("\n");
};

// ─── 通报路由器 ─────────────────────────────────────────────

/**
 * SubagentAnnouncer — 管理通报投递逻辑。
 *
 * 支持递归回退：若目标会话不可达，尝试向上一级投递。
 */
export class SubagentAnnouncer {
  private injectFn?: InjectMessageFn;
  /** parentSessionId → 回调监听器（可选，用于通知编排器） */
  private listeners = new Map<string, Array<(payload: AnnouncePayload) => void>>();

  /** 注入消息投递回调 */
  setInjectFn(fn: InjectMessageFn): void {
    this.injectFn = fn;
  }

  /**
   * 注册通报监听器（编排器用于收集多个子代理结果）。
   */
  onAnnounce(parentSessionId: string, callback: (payload: AnnouncePayload) => void): () => void {
    if (!this.listeners.has(parentSessionId)) {
      this.listeners.set(parentSessionId, []);
    }
    this.listeners.get(parentSessionId)!.push(callback);

    // 返回取消注册函数
    return () => {
      const cbs = this.listeners.get(parentSessionId);
      if (cbs) {
        const idx = cbs.indexOf(callback);
        if (idx !== -1) cbs.splice(idx, 1);
        if (cbs.length === 0) this.listeners.delete(parentSessionId);
      }
    };
  }

  /**
   * 投递子代理完成通报。
   *
   * 对标 OpenClaw subagent-announce-delivery.ts 的推送式通报 + 递归回退。
   *
   * @param record 子代理记录
   * @param getParent 获取父子代理记录的函数（用于递归回退）
   */
  async announce(
    record: SubagentRecord,
    getParent?: (sessionId: string) => SubagentRecord | undefined,
  ): Promise<boolean> {
    const payload = this.buildPayload(record);

    // 1. 触发监听器（编排器可收集结果）
    const listeners = this.listeners.get(record.parentSessionId);
    if (listeners) {
      for (const cb of listeners) {
        try { cb(payload); } catch (e) {
          logger.warn({ error: e }, "Announce listener error");
        }
      }
    }

    // 2. 注入消息到父会话
    if (!this.injectFn) {
      logger.warn("No inject function set, cannot deliver announce");
      return false;
    }

    const message = formatAnnounceMessage(payload);

    // 深度1子代理 → 主会话：作为 user 消息注入（触发父代理响应）
    // 深度2+ → 上级子代理：作为 system 消息注入（不触发自动响应）
    const role = record.depth === 1 ? "user" : "system";

    try {
      const delivered = await this.injectFn(record.parentSessionId, message, role);

      if (delivered) {
        logger.info(
          { subagentId: record.id, parentSessionId: record.parentSessionId },
          "Announce delivered to parent"
        );
        return true;
      }

      // 3. 投递失败，递归回退到更上层
      if (getParent) {
        const parentRecord = getParent(record.parentSessionId);
        if (parentRecord && parentRecord.parentSessionId) {
          logger.info(
            { subagentId: record.id, fallbackTo: parentRecord.parentSessionId },
            "Parent session unreachable, falling back to grandparent"
          );
          // 修改 payload 的目标，追加回退说明
          const fallbackMsg = `[Fallback from ${record.parentSessionId}]\n${message}`;
          return await this.injectFn(parentRecord.parentSessionId, fallbackMsg, "system");
        }
      }

      logger.warn(
        { subagentId: record.id },
        "Announce delivery failed and no fallback available"
      );
      return false;
    } catch (err: any) {
      logger.error(
        { subagentId: record.id, error: err.message },
        "Announce delivery error"
      );
      return false;
    }
  }

  /** 从子代理记录构建通报载荷 */
  private buildPayload(record: SubagentRecord): AnnouncePayload {
    const durationMs = record.completedAt
      ? record.completedAt.getTime() - record.createdAt.getTime()
      : Date.now() - record.createdAt.getTime();

    return {
      subagentId: record.id,
      childSessionId: record.sessionId,
      parentSessionId: record.parentSessionId,
      task: record.task,
      label: record.label,
      status: record.status === "running" ? "success" : record.status as AnnouncePayload["status"],
      result: record.result ?? "",
      error: record.error,
      durationMs,
      depth: record.depth,
    };
  }

  /** 清理所有监听器 */
  destroy(): void {
    this.listeners.clear();
  }
}
