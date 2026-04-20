/**
 * 预防性溢出检测与路由 — 学 OpenClaw preemptive-compaction.ts
 *
 * 在每轮 LLM 调用前进行预检，根据 token 预算决定走哪条路径：
 *   "fits"                     — 无溢出，直接调用 LLM
 *   "truncate_tool_results_only" — 仅截断工具结果即可解决（0 LLM 调用，极快）
 *   "compress"                 — 需要完整 LLM 摘要压缩
 *   "compress_then_truncate"   — 摘要 + 截断（双管齐下）
 *
 * References:
 * - OpenClaw src/agents/pi-embedded-runner/run/preemptive-compaction.ts
 *   shouldPreemptivelyCompactBeforePrompt (L39-98)
 */

import pino from "pino";

const logger = pino({ name: "preemptive-check" });

// ─── Types ──────────────────────────────────────────────────

export type PreemptiveRoute =
  | "fits"
  | "truncate_tool_results_only"
  | "compress"
  | "compress_then_truncate";

export interface PreemptiveCheckInput {
  /** 模型上下文窗口大小（tokens） */
  contextWindowTokens: number;
  /** 为模型输出预留的 token 数（maxOutputTokens 或默认值） */
  reserveTokens: number;
  /** 当前 prompt 的估计总 token 数（system + history + toolDefs） */
  estimatedPromptTokens: number;
  /** 消息历史中工具结果的可削减字符数 */
  toolResultReducibleChars: number;
  /** 消息历史 token 数（不含 system 和 toolDefs） */
  historyTokens: number;
  /** 性能阈值 — 历史 token 超过此值也触发压缩 */
  performanceThreshold: number;
}

export interface PreemptiveCheckResult {
  route: PreemptiveRoute;
  overflowTokens: number;
  promptBudget: number;
  /** 仅用于日志/调试 */
  details: {
    contextWindowTokens: number;
    reserveTokens: number;
    estimatedPromptTokens: number;
    toolResultReducibleChars: number;
    historyTokens: number;
  };
}

// ─── Constants ──────────────────────────────────────────────

/**
 * 最小提示词预算（学 OpenClaw MIN_PROMPT_BUDGET_TOKENS = 8000）
 * 保证即使在大模型上也给模型足够的输入空间。
 */
const MIN_PROMPT_BUDGET_TOKENS = 8000;

/**
 * 截断缓冲字符数 — 工具结果可削减量需超过溢出量的 1.5 倍 + 此缓冲。
 * 学 OpenClaw: truncationBufferChars = overflowChars * 1.5 + 2048
 */
const TRUNCATION_BUFFER_CHARS = 2048;

/**
 * token → 字符换算系数
 */
const CHARS_PER_TOKEN = 4;

// ─── Main Function ──────────────────────────────────────────

/**
 * 预防性溢出检测 — 在 LLM 调用前判断走哪条路径。
 *
 * 学 OpenClaw shouldPreemptivelyCompactBeforePrompt (L54-88):
 * 1. 计算 promptBudget = contextWindow - reserveTokens
 * 2. overflow = max(0, estimatedPrompt - promptBudget)
 * 3. 同时检查性能阈值
 * 4. 评估工具结果可削减量是否足以解决溢出
 */
export function shouldPreemptivelyCompact(input: PreemptiveCheckInput): PreemptiveCheckResult {
  const {
    contextWindowTokens,
    reserveTokens,
    estimatedPromptTokens,
    toolResultReducibleChars,
    historyTokens,
    performanceThreshold,
  } = input;

  // 有效预留 token（不超过 contextWindow - minPromptBudget）
  const effectiveReserve = Math.min(
    reserveTokens,
    contextWindowTokens - MIN_PROMPT_BUDGET_TOKENS,
  );

  // 可用于 prompt 的 token 预算
  const promptBudget = contextWindowTokens - Math.max(0, effectiveReserve);

  // 容量溢出
  const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudget);
  const overflowChars = overflowTokens * CHARS_PER_TOKEN;

  // 性能阈值溢出（历史消息太多导致慢，即使没超窗口也要压缩）
  const perfOverflow = historyTokens > performanceThreshold;

  const details = {
    contextWindowTokens,
    reserveTokens: effectiveReserve,
    estimatedPromptTokens,
    toolResultReducibleChars,
    historyTokens,
  };

  // 路由 1: 无溢出且不超性能阈值
  if (overflowTokens === 0 && !perfOverflow) {
    return { route: "fits", overflowTokens, promptBudget, details };
  }

  // 路由 2: 仅截断工具结果可以解决（且不超性能阈值）
  // 学 OpenClaw: toolResultReducibleChars >= overflowChars * 1.5 + truncationBufferChars
  if (
    !perfOverflow &&
    overflowTokens > 0 &&
    toolResultReducibleChars >= overflowChars * 1.5 + TRUNCATION_BUFFER_CHARS
  ) {
    logger.info(
      { overflowTokens, overflowChars, ...details },
      "Preemptive route: truncate_tool_results_only",
    );
    return { route: "truncate_tool_results_only", overflowTokens, promptBudget, details };
  }

  // 路由 3/4: 需要压缩
  // 如果压缩后工具结果仍可能超大，则 compress_then_truncate
  if (overflowTokens > 0 && toolResultReducibleChars > 0) {
    logger.info(
      { overflowTokens, perfOverflow, ...details },
      "Preemptive route: compress_then_truncate",
    );
    return { route: "compress_then_truncate", overflowTokens, promptBudget, details };
  }

  // 纯压缩路径（性能阈值触发或无可截断工具结果）
  logger.info(
    { overflowTokens, perfOverflow, ...details },
    "Preemptive route: compress",
  );
  return { route: "compress", overflowTokens, promptBudget, details };
}
