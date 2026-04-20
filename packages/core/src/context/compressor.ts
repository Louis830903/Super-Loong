/**
 * ContextCompressor — 高级 token-budget 上下文管理。
 *
 * 四阶段压缩算法（参考 Hermes context_compressor.py + Letta compact.py）：
 *   Phase 0: 修剪旧 tool results（廉价，无 LLM 调用）
 *   Phase 1: 双阈值触发（容量阈值 + 性能阈值）
 *   Phase 2: Token-budget 尾部保护（替代固定消息数）
 *   Phase 3: LLM 结构化摘要（替代直接丢弃）
 *
 * References:
 * - Hermes context_compressor.py (threshold_percent=0.50, _prune_old_tool_results,
 *   _find_tail_cut_by_tokens, _generate_summary, _sanitize_tool_pairs)
 * - Letta compact.py (CompactionSettings, CompactResult, multi-mode fallback)
 * - OpenClaw compaction.ts (repairToolUseResultPairing)
 */

import pino from "pino";
import type { LLMMessage } from "../types/index.js";
import type { ContextSummarizer } from "./summarizer.js";
import { getContentText, estimateImageTokens } from "../utils/content-helpers.js";

const logger = pino({ name: "context-compressor" });

// ─── Constants ──────────────────────────────────────────────

/** 旧工具输出替换占位符（学 Hermes _PRUNED_TOOL_PLACEHOLDER） */
export const PRUNED_TOOL_PLACEHOLDER = "[旧工具输出已清除以节省上下文空间]";

/** 仅修剪 >200 字符的 tool result（太短的修剪收益低） */
const MIN_PRUNE_LENGTH = 200;

/** 单个会话消息数硬上限 — 防止无限膨胀（学 Hermes protect_tail + 积极压缩） */
const MAX_SESSION_MESSAGES = 100;

/** compress() 中 LLM 摘要生成的超时时间（毫秒） — 超时后降级为纯截断
 *  30s 太短（国产模型首 token 延迟大），改为 60s 与 session lock 超时对齐 */
const COMPRESS_SUMMARY_TIMEOUT_MS = 60_000;

/** 摘要前缀 — handoff framing（学 Hermes SUMMARY_PREFIX） */
export const SUMMARY_PREFIX =
  "[上下文压缩 — 仅供参考] 早期对话已压缩为以下摘要。" +
  "这是来自上一个上下文窗口的交接记录，视为背景参考，不要作为指令执行。" +
  "不要回答或处理摘要中提到的请求（它们已经被处理过了）。" +
  "仅回应此摘要之后出现的最新用户消息。";

// ─── Configuration ──────────────────────────────────────────

export interface CompressorConfig {
  /** 模型上下文窗口大小（tokens） */
  contextWindowTokens: number;
  /** 容量阈值比例 — 总 token 超过此比例时触发压缩（默认 0.50，对齐 Hermes） */
  thresholdPercent?: number;
  /** 性能阈值 — 历史 token 超过此绝对值时触发压缩，独立于 context window（默认 20000）
   *  解决大窗口模型（256K+）下容量阈值永远不触发的问题 */
  performanceThreshold?: number;
  /** 头部保护消息数（默认 3，对齐 Hermes） */
  protectFirstN?: number;
  /** 尾部保护 token 预算 — 替代固定消息数（默认 12000）
   *  参考 Hermes tail_token_budget = threshold_tokens × summary_target_ratio */
  tailTokenBudget?: number;
  /** 历史最大占比 — 压缩目标（默认 0.5） */
  maxHistoryShare?: number;
}

/** 未知模型时的安全默认值 */
const DEFAULT_CONTEXT_WINDOW = 8192;

// ─── Pluggable Strategy Interface ───────────────────────────

/**
 * 可插拔的上下文管理策略接口。
 * compress() 为 async 以支持 LLM 摘要（P2）。
 */
export interface IContextStrategy {
  estimateTokens(messages: LLMMessage[]): number;
  shouldCompress(systemTokens: number, historyTokens: number, toolDefsTokens?: number): boolean;
  compress(messages: LLMMessage[]): Promise<LLMMessage[]>;
  pruneOldToolResults(
    messages: LLMMessage[],
    protectTailTokens?: number,
  ): { messages: LLMMessage[]; prunedCount: number };
}

// ─── ContextCompressor Class ────────────────────────────────

export class ContextCompressor implements IContextStrategy {
  private config: Required<
    Pick<CompressorConfig, "contextWindowTokens" | "thresholdPercent" | "protectFirstN" | "maxHistoryShare">
  > & {
    performanceThreshold: number;
    tailTokenBudget: number;
  };

  compressionCount = 0;
  private summarizer?: ContextSummarizer;

  constructor(config: Partial<CompressorConfig> = {}) {
    const ctxWindow = config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW;
    this.config = {
      contextWindowTokens: ctxWindow,
      thresholdPercent: config.thresholdPercent ?? 0.50,       // 对齐 Hermes（原 0.75）
      protectFirstN: config.protectFirstN ?? 3,                 // 对齐 Hermes（原 2）
      maxHistoryShare: config.maxHistoryShare ?? 0.5,
      performanceThreshold: config.performanceThreshold ?? 20000,
      tailTokenBudget: config.tailTokenBudget ?? 12000,
    };
  }

  /** 更新模型上下文窗口大小（如模型切换后） */
  updateContextWindow(tokens: number): void {
    this.config.contextWindowTokens = tokens;
  }

  /** 注入 LLM 摘要器（可选，无摘要器时退化为丢弃模式） */
  setSummarizer(summarizer: ContextSummarizer): void {
    this.summarizer = summarizer;
  }

  // ─── Token Estimation ───────────────────────────────────

  /**
   * 估算消息集合的 token 数。
   * CJK 字符 ~1.5 tokens，其他 ~0.25 tokens，每消息 ~4 tokens 开销。
   */
  estimateTokens(messages: LLMMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      // B-0a-②: 用 getContentText 替代 JSON.stringify，避免 JSON 元字符高估 token
      const text = getContentText(msg.content);
      total += this.estimateStringTokens(text);
      // B-0a-②: 新增图片 token 估算
      total += estimateImageTokens(msg.content);

      // Tool calls 的 JSON 序列化
      if (msg.toolCalls) {
        const tcStr = JSON.stringify(msg.toolCalls);
        total += Math.ceil(tcStr.length / 4);
      }

      // Reasoning content
      if (msg.reasoningContent) {
        total += this.estimateStringTokens(msg.reasoningContent);
      }

      // 每消息开销（role, formatting）
      total += 4;
    }
    return total;
  }

  /** CJK 感知的单字符串 token 估算 */
  private estimateStringTokens(str: string): number {
    if (!str) return 0;
    const cjkChars = (
      str.match(
        /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g,
      ) || []
    ).length;
    const otherChars = str.length - cjkChars;
    return Math.ceil(cjkChars * 1.5 + otherChars / 4);
  }

  // ─── Phase 0: Tool Result Pruning ───────────────────────

  /**
   * 修剪旧的 tool result 内容，替换为占位符。
   *
   * 算法（学 Hermes _prune_old_tool_results）：
   * 1. 从末尾向前走，累积 token 直到达到 protectTailTokens 预算
   * 2. 预算之前的所有 role=tool 消息，如果 content.length > 200，替换为占位符
   * 3. 已经是占位符的不再修剪
   *
   * @param messages 消息数组
   * @param protectTailTokens 尾部保护的 token 预算（默认 tailTokenBudget）
   * @returns 修剪后的消息数组和修剪计数
   */
  pruneOldToolResults(
    messages: LLMMessage[],
    protectTailTokens?: number,
  ): { messages: LLMMessage[]; prunedCount: number } {
    if (!messages.length) return { messages, prunedCount: 0 };

    const budget = protectTailTokens ?? this.config.tailTokenBudget;
    const result = messages.map((m) => ({ ...m })); // shallow copy

    // 从末尾向前走，确定修剪边界（学 Hermes token-budget approach）
    let accumulated = 0;
    let pruneBoundary = result.length;
    const minProtect = Math.min(3, result.length);

    for (let i = result.length - 1; i >= 0; i--) {
      const msg = result[i];
      const contentLen = getContentText(msg.content).length;
      let msgTokens = Math.ceil(contentLen / 4) + 10; // 粗估 + overhead
      if (msg.toolCalls) {
        msgTokens += Math.ceil(JSON.stringify(msg.toolCalls).length / 4);
      }

      if (accumulated + msgTokens > budget && (result.length - i) >= minProtect) {
        pruneBoundary = i;
        break;
      }
      accumulated += msgTokens;
      pruneBoundary = i;
    }

    // 修剪边界之前的 tool 消息
    let prunedCount = 0;
    for (let i = 0; i < pruneBoundary; i++) {
      const msg = result[i];
      if (msg.role !== "tool") continue;
      const content = getContentText(msg.content);
      if (!content || content === PRUNED_TOOL_PLACEHOLDER) continue;
      if (content.length > MIN_PRUNE_LENGTH) {
        result[i] = { ...msg, content: PRUNED_TOOL_PLACEHOLDER };
        prunedCount++;
      }
    }

    return { messages: result, prunedCount };
  }

  // ─── Compression Check (Dual Threshold) ─────────────────

  /**
   * 双阈值判定是否需要压缩。
   *
   * 阈值1（容量）：totalTokens > contextWindowTokens × thresholdPercent
   * 阈值2（性能）：historyTokens > performanceThreshold
   * 任一满足即触发。
   */
  shouldCompress(systemTokens: number, historyTokens: number, toolDefsTokens?: number): boolean {
    // P0: 纳入工具定义 token（学 OpenClaw estimatePrePromptTokens 包含 toolDefs）
    const totalTokens = systemTokens + historyTokens + (toolDefsTokens ?? 0);
    const capacityThreshold =
      this.config.contextWindowTokens * this.config.thresholdPercent;
    const perfThreshold = this.config.performanceThreshold;
    return totalTokens > capacityThreshold || historyTokens > perfThreshold;
  }

  // ─── Phase 2: Full Compression ──────────────────────────

  /**
   * 压缩消息历史。
   *
   * 算法（学 Hermes compress()）：
   *   1. 确定 head 和 tail 边界（token-budget 尾部保护）
   *   2. 中间消息尝试 LLM 结构化摘要（如果有 summarizer）
   *   3. 摘要失败时插入静态 fallback 标记
   *   4. 修复孤立的 tool_call / tool_result 配对
   */
  async compress(messages: LLMMessage[]): Promise<LLMMessage[]> {
    const { protectFirstN, contextWindowTokens, maxHistoryShare } = this.config;
    const budgetTokens = Math.floor(contextWindowTokens * maxHistoryShare);

    // 最少需要 head + 3 条尾部消息才能压缩
    const minForCompress = protectFirstN + 3 + 1;
    if (messages.length <= minForCompress) {
      return messages;
    }

    // P1-Task5: 消息数硬上限保护 — 如果消息数远超上限，
    // 先裁剪到最大允许数量，防止后续压缩处理过多消息
    if (messages.length > MAX_SESSION_MESSAGES) {
      const excess = messages.length - MAX_SESSION_MESSAGES;
      const keepHead = Math.min(protectFirstN, messages.length);
      const trimmedHead = messages.slice(0, keepHead);
      const trimmedTail = messages.slice(keepHead + excess);
      messages = [...trimmedHead, ...trimmedTail];
      logger.warn(
        { originalCount: messages.length + excess, trimmedTo: messages.length },
        "Hard message cap pre-trim applied before compression",
      );
    }

    const beforeCount = messages.length;
    const beforeTokens = this.estimateTokens(messages);

    // Phase 1: 确定 head/tail 边界
    const head = messages.slice(0, protectFirstN);
    const tailCut = this.findTailCutByTokens(messages, protectFirstN);
    const middle = messages.slice(protectFirstN, tailCut);
    let tail = messages.slice(tailCut);

    if (middle.length === 0) {
      return messages; // 没有可压缩的中间消息
    }

    // Phase 2: 生成摘要（带 30s 超时保护，防止 LLM 摘要无限阻塞）
    let summaryContent: string | null = null;
    if (this.summarizer) {
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Summary generation timed out (${COMPRESS_SUMMARY_TIMEOUT_MS}ms)`)),
            COMPRESS_SUMMARY_TIMEOUT_MS,
          ),
        );
        summaryContent = await Promise.race([
          this.summarizer.generateSummary(middle),
          timeoutPromise,
        ]) as string | null;
      } catch (err) {
        logger.warn({ error: err }, "Summary generation failed or timed out, using fallback");
      }
    }

    // Phase 3: 组装结果
    const compressed: LLMMessage[] = [...head];

    if (summaryContent) {
      // 智能角色选择（学 Hermes 避免连续同角色）
      const lastHeadRole = head.length > 0 ? head[head.length - 1].role : "user";
      const firstTailRole = tail.length > 0 ? tail[0].role : "user";
      let summaryRole: "user" | "assistant" =
        lastHeadRole === "assistant" || lastHeadRole === "tool" ? "user" : "assistant";
      // 如果与 tail 首条冲突，尝试翻转
      if (summaryRole === firstTailRole) {
        const flipped = summaryRole === "user" ? "assistant" : "user";
        if (flipped !== lastHeadRole) {
          summaryRole = flipped;
        }
      }
      compressed.push({ role: summaryRole, content: summaryContent });
    } else if (middle.length > 0) {
      // 摘要不可用 — 强制截断策略
      // 当 tailTokenBudget 覆盖了大部分消息导致 middle 极小时（<5条），
      // token-based 分割无法有效压缩（1换1=净减0）。
      // 切换为消息数分割：保留 head + 最近 60% 的消息，强制丢弃 40%。
      let effectiveMiddle = middle;
      if (middle.length < 5 && messages.length > protectFirstN + 8) {
        const keepTailCount = Math.ceil((messages.length - protectFirstN) * 0.6);
        effectiveMiddle = messages.slice(protectFirstN, messages.length - keepTailCount);
        tail = messages.slice(messages.length - keepTailCount);
        logger.info(
          { originalMiddle: middle.length, forcedMiddle: effectiveMiddle.length, forcedTail: tail.length },
          "Fallback: middle too small, switched to message-count split",
        );
      }
      const nDropped = effectiveMiddle.length;
      if (nDropped > 0) {
        compressed.push({
          role: "user",
          content:
            `${SUMMARY_PREFIX}\n` +
            `摘要生成不可用。${nDropped} 条对话已被移除以释放上下文空间。` +
            `被移除的对话包含本次会话中的早期工作。请基于下方的最近消息和当前文件/资源状态继续。`,
        });
      }
    }

    compressed.push(...tail);

    // Phase 4: 修复工具对完整性
    const result = this.sanitizeToolPairs(compressed);
    this.compressionCount++;

    logger.info(
      {
        beforeMessages: beforeCount,
        afterMessages: result.length,
        dropped: beforeCount - result.length,
        middleSummarized: middle.length,
        hasSummary: !!summaryContent,
        beforeTokens,
        afterTokens: this.estimateTokens(result),
        budgetTokens,
        compressionCount: this.compressionCount,
      },
      "Context compressed",
    );

    return result;
  }

  // ─── Token-budget Tail Protection ───────────────────────

  /**
   * 按 token 预算确定尾部起始位置（学 Hermes _find_tail_cut_by_tokens）。
   *
   * 从消息末尾向前累积 token，达到 budget×1.5 时停止。
   * 最少保护 3 条消息。对齐到工具组边界避免分割 tool_call/result。
   *
   * @returns tail 的起始索引（即 middle 的结束索引）
   */
  private findTailCutByTokens(messages: LLMMessage[], headEnd: number): number {
    const budget = this.config.tailTokenBudget;
    const n = messages.length;
    const minTail = Math.min(3, n - headEnd - 1);
    const softCeiling = Math.floor(budget * 1.5);
    let accumulated = 0;
    let cutIdx = n;

    for (let i = n - 1; i >= headEnd; i--) {
      const msgTokens = this.estimateTokens([messages[i]]);
      if (accumulated + msgTokens > softCeiling && (n - i) >= minTail) {
        break;
      }
      accumulated += msgTokens;
      cutIdx = i;
    }

    // 确保至少保护 minTail 条消息
    const fallbackCut = n - minTail;
    if (cutIdx > fallbackCut) {
      cutIdx = fallbackCut;
    }

    // 如果 token budget 覆盖了所有消息，强制在 head 之后切割
    if (cutIdx <= headEnd) {
      cutIdx = Math.max(fallbackCut, headEnd + 1);
    }

    // 对齐到工具组边界（学 Hermes _align_boundary_backward）
    cutIdx = this.alignBoundaryBackward(messages, cutIdx);

    return Math.max(cutIdx, headEnd + 1);
  }

  /**
   * 将边界向前推过孤立的 tool result（学 Hermes _align_boundary_forward）。
   */
  private alignBoundaryForward(messages: LLMMessage[], idx: number): number {
    while (idx < messages.length && messages[idx].role === "tool") {
      idx++;
    }
    return idx;
  }

  /**
   * 将边界向后拉以避免分割 tool_call/result 组（学 Hermes _align_boundary_backward）。
   *
   * 如果边界落在 tool result 组中间，向后找到 parent assistant 消息，
   * 将整个组包含在压缩区域内。
   */
  private alignBoundaryBackward(messages: LLMMessage[], idx: number): number {
    if (idx <= 0 || idx >= messages.length) return idx;
    // 向后跳过连续的 tool results
    let check = idx - 1;
    while (check >= 0 && messages[check].role === "tool") {
      check--;
    }
    // 如果找到了带 tool_calls 的 assistant 消息，将边界移到它前面
    if (
      check >= 0 &&
      messages[check].role === "assistant" &&
      messages[check].toolCalls?.length
    ) {
      idx = check;
    }
    return idx;
  }

  // ─── Tool Pair Sanitization ─────────────────────────────

  /**
   * 修复压缩后孤立的 tool_call / tool_result 配对（学 Hermes _sanitize_tool_pairs）。
   *
   * 两种故障模式：
   * 1. tool result 引用了已被移除的 assistant tool_call → 移除孤立 result
   * 2. assistant 的 tool_calls 对应的 result 被移除 → 插入 stub result
   */
  private sanitizeToolPairs(messages: LLMMessage[]): LLMMessage[] {
    // 收集所有 assistant 声明的 tool call IDs
    const declaredToolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          declaredToolCallIds.add(tc.id);
        }
      }
    }

    // 收集所有 tool response IDs
    const respondedToolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "tool" && msg.toolCallId) {
        respondedToolCallIds.add(msg.toolCallId);
      }
    }

    // 1. 移除孤立 tool results（无匹配的 assistant tool_calls）
    let result = messages.filter((msg) => {
      if (msg.role === "tool" && msg.toolCallId) {
        return declaredToolCallIds.has(msg.toolCallId);
      }
      return true;
    });

    // 2. 为缺失 result 的 tool_calls 插入 stub（学 Hermes stub insertion）
    const missingResults = new Set<string>();
    for (const id of declaredToolCallIds) {
      if (!respondedToolCallIds.has(id)) {
        missingResults.add(id);
      }
    }

    if (missingResults.size > 0) {
      const patched: LLMMessage[] = [];
      for (const msg of result) {
        patched.push(msg);
        if (msg.role === "assistant" && msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            if (missingResults.has(tc.id)) {
              patched.push({
                role: "tool",
                content: "[来自早期对话的结果 — 详见上方上下文摘要]",
                toolCallId: tc.id,
              });
            }
          }
        }
      }
      result = patched;
      logger.info(
        { count: missingResults.size },
        "Compression sanitizer: added stub tool results",
      );
    }

    return result;
  }
}
