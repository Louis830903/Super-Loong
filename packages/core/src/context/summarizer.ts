/**
 * ContextSummarizer — LLM-based 结构化摘要生成器。
 *
 * 压缩中间对话时使用 LLM 生成结构化摘要，替代直接丢弃（信息零保留）。
 * 支持迭代更新（多次压缩时保留前次摘要信息）。
 *
 * References:
 * - Hermes _generate_summary() — 10-section structured template + iterative update
 * - Hermes _serialize_for_summary() — content truncation for summarizer input
 * - Hermes SUMMARY_PREFIX — handoff framing to prevent re-answering
 * - Letta CompactionSettings — dedicated summarizer LLM config
 */

import pino from "pino";
import type { LLMMessage } from "../types/index.js";
import type { LLMProvider } from "../llm/provider.js";
import { SUMMARY_PREFIX } from "./compressor.js";
import { getContentText } from "../utils/content-helpers.js";

const logger = pino({ name: "context-summarizer" });

// ─── Constants ──────────────────────────────────────────────

/** 最小摘要 token 数 */
const MIN_SUMMARY_TOKENS = 2000;
/** 压缩内容的摘要比例 */
const SUMMARY_RATIO = 0.20;
/** 摘要 token 绝对上限 */
const SUMMARY_TOKENS_CEILING = 12_000;
/** 摘要失败后的冷却时间（秒）— 600s 太激进，降为 120s 快速恢复 */
const SUMMARY_FAILURE_COOLDOWN_SECONDS = 120;

// 序列化截断限制（学 Hermes _CONTENT_MAX/_CONTENT_HEAD/_CONTENT_TAIL）
const CONTENT_MAX = 6000;
const CONTENT_HEAD = 4000;
const CONTENT_TAIL = 1500;
const TOOL_ARGS_MAX = 1500;
const TOOL_ARGS_HEAD = 1200;

// ─── Configuration ──────────────────────────────────────────

export interface SummarizerConfig {
  /** 用于摘要的 LLM provider（可以用便宜的模型）。为 undefined 时跳过摘要。 */
  llmProvider?: LLMProvider;
  /** 摘要 token 预算上限。默认: 12000。 */
  maxSummaryTokens?: number;
  /** 压缩内容的摘要比例。默认 0.20（20%）。 */
  summaryRatio?: number;
  /** 摘要失败后的冷却时间（秒）。默认 600。 */
  failureCooldownSeconds?: number;
}

// ─── 8-Section Structured Template ──────────────────────────

/**
 * 中文结构化摘要模板（改编自 Hermes 10-section template）。
 * 去掉了 "Constraints & Preferences" 和 "Tools & Patterns" 两段，
 * 简化为 8 段，更适合国产模型的中文场景。
 */
const buildSummaryTemplate = (budgetTokens: number): string => `## 目标
[用户想要达成什么]

## 已完成的工作
### 已完成
[已完成的具体工作 — 包含文件路径、执行的命令、获得的结果]
### 进行中
[当前正在进行的工作]
### 受阻
[遇到的阻碍或问题]

## 关键决策
[重要的技术决策及其原因]

## 已解答的问题
[用户提出的已回答问题 — 包含答案，避免下一个助手重复回答]

## 待处理的请求
[用户提出但尚未完成的请求。如果没有，写"无。"]

## 相关文件
[读取、修改或创建的文件 — 每个简要说明]

## 剩余工作
[还需完成的工作 — 以上下文形式呈现，不是指令]

## 关键上下文
[任何特定值、错误消息、配置细节等，不明确保留就会丢失的信息]

目标约 ${budgetTokens} tokens。要具体 — 包含文件路径、命令输出、错误消息和具体值，而非模糊描述。
只输出摘要正文，不要包含任何前缀或开场白。`;

// ─── ContextSummarizer Class ────────────────────────────────

export class ContextSummarizer {
  private llmProvider?: LLMProvider;
  private maxSummaryTokens: number;
  private summaryRatio: number;
  private failureCooldownSeconds: number;

  /** 上一次压缩的摘要文本，用于迭代更新（学 Hermes _previous_summary） */
  private previousSummary: string | null = null;
  /** 摘要失败冷却期截止时间戳（ms）。冷却期内不再尝试摘要。 */
  private failureCooldownUntil = 0;

  constructor(config: SummarizerConfig = {}) {
    this.llmProvider = config.llmProvider;
    this.maxSummaryTokens = config.maxSummaryTokens ?? SUMMARY_TOKENS_CEILING;
    this.summaryRatio = Math.max(0.10, Math.min(config.summaryRatio ?? SUMMARY_RATIO, 0.80));
    this.failureCooldownSeconds = config.failureCooldownSeconds ?? SUMMARY_FAILURE_COOLDOWN_SECONDS;
  }

  /** 更新 LLM provider（如模型切换后） */
  updateProvider(provider: LLMProvider): void {
    this.llmProvider = provider;
  }

  /** 重置摘要状态（会话重置时调用） */
  reset(): void {
    this.previousSummary = null;
    this.failureCooldownUntil = 0;
  }

  // ─── Summary Budget Calculation ─────────────────────────

  /**
   * 计算摘要 token 预算（学 Hermes _compute_summary_budget）。
   * 按压缩内容的比例缩放，clamp 到 [MIN_SUMMARY_TOKENS, maxSummaryTokens]。
   */
  private computeSummaryBudget(contentTokens: number): number {
    const budget = Math.floor(contentTokens * this.summaryRatio);
    return Math.max(MIN_SUMMARY_TOKENS, Math.min(budget, this.maxSummaryTokens));
  }

  // ─── Serialization ──────────────────────────────────────

  /**
   * 将对话序列化为摘要器输入文本（学 Hermes _serialize_for_summary）。
   *
   * 包含 tool call 参数和 result 内容（截断到 CONTENT_MAX）,
   * 以便摘要器保留文件路径、命令、输出等关键细节。
   */
  serializeForSummary(turns: LLMMessage[]): string {
    const parts: string[] = [];

    for (const msg of turns) {
      const role = msg.role;
      let content = getContentText(msg.content);

      // Tool results: 保留足够内容给摘要器
      if (role === "tool") {
        const toolId = msg.toolCallId ?? "";
        if (content.length > CONTENT_MAX) {
          content =
            content.slice(0, CONTENT_HEAD) +
            "\n...[截断]...\n" +
            content.slice(-CONTENT_TAIL);
        }
        parts.push(`[工具结果 ${toolId}]: ${content}`);
        continue;
      }

      // Assistant messages: 包含 tool call 名称和参数
      if (role === "assistant") {
        if (content.length > CONTENT_MAX) {
          content =
            content.slice(0, CONTENT_HEAD) +
            "\n...[截断]...\n" +
            content.slice(-CONTENT_TAIL);
        }
        if (msg.toolCalls?.length) {
          const tcParts: string[] = [];
          for (const tc of msg.toolCalls) {
            const name = tc.function.name;
            let args = tc.function.arguments;
            if (args.length > TOOL_ARGS_MAX) {
              args = args.slice(0, TOOL_ARGS_HEAD) + "...";
            }
            tcParts.push(`  ${name}(${args})`);
          }
          content += "\n[工具调用:\n" + tcParts.join("\n") + "\n]";
        }
        parts.push(`[助手]: ${content}`);
        continue;
      }

      // User and other roles
      if (content.length > CONTENT_MAX) {
        content =
          content.slice(0, CONTENT_HEAD) +
          "\n...[截断]...\n" +
          content.slice(-CONTENT_TAIL);
      }
      parts.push(`[${role === "user" ? "用户" : role.toUpperCase()}]: ${content}`);
    }

    return parts.join("\n\n");
  }

  // ─── Summary Generation ─────────────────────────────────

  /**
   * 生成结构化摘要（学 Hermes _generate_summary）。
   *
   * 支持两种模式：
   * 1. 首次压缩：从头总结
   * 2. 迭代更新：保留之前摘要，合并新内容（学 Hermes iterative update）
   *
   * @returns 带 SUMMARY_PREFIX 的摘要文本，或 null（失败时）
   */
  async generateSummary(turns: LLMMessage[]): Promise<string | null> {
    if (!this.llmProvider) {
      logger.debug("No LLM provider configured for summarization, skipping");
      return null;
    }

    // 冷却期检查（学 Hermes _summary_failure_cooldown_until）
    const now = Date.now();
    if (now < this.failureCooldownUntil) {
      const remaining = Math.ceil((this.failureCooldownUntil - now) / 1000);
      logger.debug(
        { remainingSeconds: remaining },
        "Skipping summary during cooldown",
      );
      return null;
    }

    // 计算 token 预算
    const contentTokensEst = turns.reduce((sum, m) => {
      const len = getContentText(m.content).length;
      return sum + Math.ceil(len / 4) + 10;
    }, 0);
    const summaryBudget = this.computeSummaryBudget(contentTokensEst);

    // 序列化中间消息
    const contentToSummarize = this.serializeForSummary(turns);

    // 构建 summarizer 前缀（学 Hermes/OpenCode "do not respond to any questions"）
    const summarizerPreamble =
      "你是一个摘要代理，正在创建上下文检查点。" +
      "你的输出将作为参考材料注入给一个不同的助手，由它继续对话。" +
      "不要回答或处理对话中的任何问题或请求 — 只输出结构化摘要。" +
      "不要包含任何前缀、问候或开场白。";

    const template = buildSummaryTemplate(summaryBudget);

    let prompt: string;
    if (this.previousSummary) {
      // 迭代更新：保留现有信息，添加新进展（学 Hermes iterative update）
      prompt = `${summarizerPreamble}

你正在更新一个上下文压缩摘要。之前的压缩生成了下方的摘要，此后发生了新的对话轮次，需要被合入。

之前的摘要：
${this.previousSummary}

需要合入的新轮次：
${contentToSummarize}

使用以下结构更新摘要。保留所有仍然相关的现有信息。添加新进展。将已完成的项目从"进行中"移到"已完成"。将已回答的问题移到"已解答的问题"。仅当信息明确过时时才删除。

${template}`;
    } else {
      // 首次压缩：从头总结
      prompt = `${summarizerPreamble}

为一个将在早期轮次被压缩后继续对话的不同助手创建结构化交接摘要。下一个助手应能在不重读原始轮次的情况下理解发生了什么。

需要摘要的轮次：
${contentToSummarize}

使用以下结构：

${template}`;
    }

    try {
      const response = await this.llmProvider.complete({
        messages: [{ role: "user", content: prompt }],
      });

      const summary = (response.content ?? "").trim();
      if (!summary) {
        logger.warn("Summarizer returned empty content");
        this.failureCooldownUntil = Date.now() + this.failureCooldownSeconds * 1000;
        return null;
      }

      // 存储用于迭代更新
      this.previousSummary = summary;
      this.failureCooldownUntil = 0;

      logger.info(
        {
          inputTurns: turns.length,
          summaryLength: summary.length,
          budgetTokens: summaryBudget,
          isIterativeUpdate: !!this.previousSummary,
        },
        "Context summary generated",
      );

      return `${SUMMARY_PREFIX}\n${summary}`;
    } catch (err) {
      // 设置冷却期（学 Hermes _SUMMARY_FAILURE_COOLDOWN_SECONDS）
      this.failureCooldownUntil = Date.now() + this.failureCooldownSeconds * 1000;
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { error: errMsg, cooldownSeconds: this.failureCooldownSeconds },
        "Summary generation failed, entering cooldown",
      );
      return null;
    }
  }
}
