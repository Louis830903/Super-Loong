/**
 * 工具结果源头截断 — 学 OpenClaw tool-result-truncation.ts
 *
 * 三层防御体系：
 *   Layer 1: 单条工具结果截断（truncateToolResult）
 *   Layer 2: 单轮聚合预算控制（enforceAggregateBudget）
 *   Layer 3: 历史消息中超大工具结果截断（truncateOversizedToolResultsInHistory）
 *
 * References:
 * - OpenClaw tool-result-truncation.ts: calculateMaxToolResultChars, truncateToolResultText,
 *   buildAggregateToolResultReplacements
 * - Hermes tool_result_storage.py: maybe_persist_tool_result, enforce_turn_budget
 */

import pino from "pino";
import { getContentText } from "../utils/content-helpers.js";
import type { LLMMessage } from "../types/index.js";

const logger = pino({ name: "tool-result-truncation" });

// ─── Constants ──────────────────────────────────────────────

/** 单条工具结果最大字符数的硬上限（学 OpenClaw DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS） */
const ABSOLUTE_MAX_SINGLE_CHARS = 40_000;

/** 单条结果占上下文窗口的比例（学 OpenClaw 30%） */
const SINGLE_RESULT_WINDOW_RATIO = 0.30;

/** 单轮所有工具结果聚合预算占上下文窗口比例（学 OpenClaw 50%） */
const AGGREGATE_BUDGET_WINDOW_RATIO = 0.50;

/** token → 字符的换算系数（粗估 1 token ≈ 4 字符） */
const CHARS_PER_TOKEN = 4;

/** 截断时保留的最小头部字符数 */
const MIN_HEAD_CHARS = 2000;

/** 截断时保留的最大尾部字符数 */
const MAX_TAIL_CHARS = 4000;

/** 省略标记 */
const TRUNCATION_MARKER =
  "\n\n... [内容已截断以节省上下文空间 — 原始内容过长] ...\n\n";

// ─── Exports ────────────────────────────────────────────────

export { TRUNCATION_MARKER };

/**
 * 根据模型上下文窗口计算单条工具结果的最大字符数。
 * 学 OpenClaw calculateMaxToolResultChars。
 */
export function calculateMaxSingleResultChars(contextWindowTokens: number): number {
  const fromWindow = Math.floor(contextWindowTokens * SINGLE_RESULT_WINDOW_RATIO * CHARS_PER_TOKEN);
  return Math.min(fromWindow, ABSOLUTE_MAX_SINGLE_CHARS);
}

/**
 * 根据模型上下文窗口计算单轮聚合工具结果的预算字符数。
 */
export function calculateAggregateBudgetChars(contextWindowTokens: number): number {
  return Math.floor(contextWindowTokens * AGGREGATE_BUDGET_WINDOW_RATIO * CHARS_PER_TOKEN);
}

/**
 * 检测字符串尾部是否包含重要信息（错误、JSON 闭合、摘要等）。
 * 学 OpenClaw hasImportantTail。
 */
function hasImportantTail(text: string): boolean {
  const tail = text.slice(-2000);
  const patterns = [
    /error/i,
    /exception/i,
    /failed/i,
    /summary/i,
    /result/i,
    /conclusion/i,
    /\}\s*$/,       // JSON 闭合
    /\]\s*$/,       // JSON 数组闭合
    /```\s*$/,      // 代码块闭合
    /total/i,
    /status/i,
  ];
  return patterns.some((p) => p.test(tail));
}

/**
 * 智能截断工具结果文本 — 学 OpenClaw truncateToolResultText。
 *
 * 策略：
 * - 检测尾部是否包含错误/摘要/JSON闭合等重要信息
 * - 是：保留头部(≥2000字符) + 省略标记 + 尾部(≤4000字符)
 * - 否：仅保留头部 + 省略标记
 *
 * @param content  原始工具结果文本
 * @param maxChars 允许的最大字符数
 * @returns 截断后的文本（如果不需要截断则返回原文）
 */
export function truncateToolResult(content: string, maxChars: number): string {
  if (!content || content.length <= maxChars) return content;

  if (hasImportantTail(content)) {
    // 保留头部和尾部
    const tailLen = Math.min(MAX_TAIL_CHARS, Math.floor(maxChars * 0.3));
    const headLen = Math.max(MIN_HEAD_CHARS, maxChars - tailLen - TRUNCATION_MARKER.length);
    const head = content.slice(0, headLen);
    const tail = content.slice(-tailLen);
    return head + TRUNCATION_MARKER + tail;
  }

  // 仅保留头部
  const headLen = maxChars - TRUNCATION_MARKER.length;
  return content.slice(0, headLen) + TRUNCATION_MARKER;
}

/**
 * 对单轮多个工具结果执行聚合预算控制。
 * 学 Hermes enforce_turn_budget + OpenClaw buildAggregateToolResultReplacements。
 *
 * 从最大的结果开始截断，直到总字符数在预算内。
 *
 * @param results  工具结果数组 [{toolCallId, content}]
 * @param budgetChars 聚合预算字符数
 * @param maxSingleChars 单条最大字符数
 * @returns 截断后的结果数组
 */
export function enforceAggregateBudget(
  results: Array<{ toolCallId: string; content: string }>,
  budgetChars: number,
  maxSingleChars: number,
): Array<{ toolCallId: string; content: string }> {
  let totalChars = results.reduce((sum, r) => sum + r.content.length, 0);

  if (totalChars <= budgetChars) return results;

  // 按内容长度降序排列（优先截断最大的）
  const sortedIndices = results
    .map((_, i) => i)
    .sort((a, b) => results[b].content.length - results[a].content.length);

  const truncated = results.map((r) => ({ ...r }));

  for (const idx of sortedIndices) {
    if (totalChars <= budgetChars) break;
    const item = truncated[idx];
    if (item.content.length > maxSingleChars) {
      const oldLen = item.content.length;
      item.content = truncateToolResult(item.content, maxSingleChars);
      totalChars -= oldLen - item.content.length;
    }
  }

  // 如果仍超预算，进一步截断
  if (totalChars > budgetChars) {
    for (const idx of sortedIndices) {
      if (totalChars <= budgetChars) break;
      const item = truncated[idx];
      const targetLen = Math.max(MIN_HEAD_CHARS, Math.floor(budgetChars / results.length));
      if (item.content.length > targetLen) {
        const oldLen = item.content.length;
        item.content = truncateToolResult(item.content, targetLen);
        totalChars -= oldLen - item.content.length;
      }
    }
  }

  logger.info(
    { originalChars: results.reduce((s, r) => s + r.content.length, 0), afterChars: totalChars, budgetChars },
    "Aggregate tool result budget enforced",
  );

  return truncated;
}

/**
 * 截断历史消息中超大的工具结果（无 LLM 调用，纯字符串操作）。
 * 学 OpenClaw truncateOversizedToolResultsInSessionManager。
 *
 * 用于预防性溢出路由的 "truncate_tool_results_only" 路径。
 *
 * @param messages 消息数组
 * @param maxSingleChars 单条工具结果最大字符数
 * @returns 截断后的消息数组和截断统计
 */
export function truncateOversizedToolResultsInHistory(
  messages: LLMMessage[],
  maxSingleChars: number,
): { messages: LLMMessage[]; truncatedCount: number; charsSaved: number } {
  let truncatedCount = 0;
  let charsSaved = 0;

  const result = messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    const content = getContentText(msg.content);
    if (content.length <= maxSingleChars) return msg;

    const truncated = truncateToolResult(content, maxSingleChars);
    truncatedCount++;
    charsSaved += content.length - truncated.length;
    return { ...msg, content: truncated };
  });

  if (truncatedCount > 0) {
    logger.info(
      { truncatedCount, charsSaved, maxSingleChars },
      "Oversized tool results truncated in history",
    );
  }

  return { messages: result, truncatedCount, charsSaved };
}

/**
 * 估算消息列表中工具结果的可削减字符数。
 * 学 OpenClaw estimateToolResultReductionPotential。
 *
 * 用于预防性路由决策。
 */
export function estimateToolResultReducibleChars(
  messages: LLMMessage[],
  maxSingleChars: number,
): number {
  let reducible = 0;
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    const len = getContentText(msg.content).length;
    if (len > maxSingleChars) {
      reducible += len - maxSingleChars;
    }
  }
  return reducible;
}
