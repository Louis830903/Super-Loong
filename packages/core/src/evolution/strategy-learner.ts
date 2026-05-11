/**
 * 策略学习者（Phase 6 Task 6.4 提取）
 *
 * 从 engine.ts 中独立出的策略缓存与行为进化模块，负责：
 * - 策略缓存（learnStrategy / findStrategy）
 * - 工具调用模式统计（optimizeToolOrder / updateToolPatternStats）
 * - 提示词反馈自适应（recordPromptFeedback / analyzePromptFeedback）
 *
 * 依赖：接受 CaseCollector 实例（用于 optimizeToolOrder 访问历史案例）。
 */

import pino from "pino";
import { v4 as uuid } from "uuid";
import type { CaseCollector, InteractionCase } from "./engine.js";

const logger = pino({ name: "strategy-learner" });

// ═══════════════════════════════════════════════════════════════
// Types（原先 engine.ts 内部 interface，现导出供外部使用）
// ═══════════════════════════════════════════════════════════════

/** 策略缓存条目 */
export interface StrategyCacheEntry {
  name: string;
  description: string;
  toolSequence: string[];
  paramTemplate: Record<string, unknown>;
  useCount: number;
  successRate: number;
  avgDuration: number;
  lastUsedAt: Date;
  triggerKeywords: string[];
  intentPattern?: string;
}

/** 工具调用模式统计 */
export interface ToolPatternStats {
  toolName: string;
  totalCalls: number;
  successCalls: number;
  avgDuration: number;
  commonParams: Array<{ params: Record<string, unknown>; count: number }>;
  predecessorTools: Map<string, number>;
  successorTools: Map<string, number>;
  bestContexts: Array<{ context: string; successRate: number }>;
}

/** 提示词反馈条目 */
export interface PromptFeedbackEntry {
  id: string;
  type: "too_long" | "too_short" | "irrelevant" | "confusing" | "helpful" | "custom";
  agentResponse: string;
  userFeedback: string;
  timestamp: Date;
  templateName?: string;
}

// ═══════════════════════════════════════════════════════════════
// StrategyLearner
// ═══════════════════════════════════════════════════════════════

export class StrategyLearner {
  /** 策略缓存 */
  readonly strategyCache: Map<string, StrategyCacheEntry> = new Map();
  /** 工具调用模式分析缓存 */
  readonly toolPatternStats: Map<string, ToolPatternStats> = new Map();
  /** 提示词反馈记录 */
  readonly promptFeedbackLog: PromptFeedbackEntry[] = [];

  /** Task 8: Map 容量上限 */
  private static readonly MAX_STRATEGY_CACHE = 500;
  private static readonly MAX_TOOL_PATTERN_STATS = 200;

  private cases: CaseCollector;

  constructor(cases: CaseCollector) {
    this.cases = cases;
  }

  // ─── 策略学习 ──────────────────────────────────────────────

  /**
   * 从成功案例中学习高频策略并缓存。
   */
  learnStrategy(params: {
    name: string;
    description: string;
    toolSequence: string[];
    paramTemplate?: Record<string, unknown>;
    triggerKeywords: string[];
    intentPattern?: string;
  }): void {
    const key = `strat_${params.name}`;
    const existing = this.strategyCache.get(key);

    if (existing) {
      existing.useCount++;
      existing.lastUsedAt = new Date();
    } else {
      this.strategyCache.set(key, {
        name: params.name,
        description: params.description,
        toolSequence: params.toolSequence,
        paramTemplate: params.paramTemplate ?? {},
        useCount: 1,
        successRate: 1,
        avgDuration: 0,
        lastUsedAt: new Date(),
        triggerKeywords: params.triggerKeywords,
        intentPattern: params.intentPattern,
      });
      this.pruneStrategyCache();
    }

    logger.info({ strategyName: params.name, useCount: this.strategyCache.get(key)?.useCount }, "Strategy learned/updated");
  }

  /**
   * 查找匹配的高频策略。
   */
  findStrategy(intent: string): StrategyCacheEntry | undefined {
    const intentLower = intent.toLowerCase();
    let bestMatch: StrategyCacheEntry | undefined;
    let bestScore = 0;

    for (const strat of this.strategyCache.values()) {
      let score = 0;
      for (const keyword of strat.triggerKeywords) {
        if (intentLower.includes(keyword.toLowerCase())) {
          score += keyword.length / intentLower.length;
        }
      }
      score *= Math.min(1, strat.useCount / 10);

      if (score > bestScore && score > 0.2) {
        bestScore = score;
        bestMatch = strat;
      }
    }

    return bestMatch;
  }

  /**
   * 根据历史案例优化工具调用顺序。
   * 分析成功案例中的工具序列模式，推荐更高效的调用顺序。
   *
   * ⚠️ 依赖注入：通过构造函数传入的 CaseCollector 访问历史案例。
   */
  optimizeToolOrder(targetIntent: string): Array<{
    recommendedOrder: string[];
    confidence: number;
    basedOnCases: number;
    reasoning: string;
  }> {
    const relatedCases = this.cases.getAllCases()
      .sort((a: InteractionCase, b: InteractionCase) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, 50)
      .filter((c: InteractionCase) =>
        c.success &&
        c.toolCalls.length >= 2 &&
        c.userMessage.toLowerCase().includes(targetIntent.toLowerCase().slice(0, 10)),
      );

    if (relatedCases.length < 3) return [];

    // 统计工具序列中相邻对的出现频率
    const pairFrequency = new Map<string, number>();
    for (const c of relatedCases) {
      for (let i = 0; i < c.toolCalls.length - 1; i++) {
        const pair = `${c.toolCalls[i]}→${c.toolCalls[i + 1]}`;
        pairFrequency.set(pair, (pairFrequency.get(pair) ?? 0) + 1);
      }
    }

    // 找出高频工具对
    const sortedPairs = Array.from(pairFrequency.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);

    // 构建推荐序列
    const recommendations: Array<{
      recommendedOrder: string[];
      confidence: number;
      basedOnCases: number;
      reasoning: string;
    }> = [];

    if (sortedPairs.length > 0) {
      const order: string[] = [];
      const seen = new Set<string>();

      for (const [pair] of sortedPairs) {
        const [from, to] = pair.split("→");
        if (!seen.has(from)) { order.push(from); seen.add(from); }
        if (!seen.has(to)) { order.push(to); seen.add(to); }
      }

      if (order.length > 0) {
        recommendations.push({
          recommendedOrder: order,
          confidence: parseFloat((sortedPairs[0][1] / relatedCases.length).toFixed(2)),
          basedOnCases: relatedCases.length,
          reasoning: `基于 ${relatedCases.length} 个成功案例，推荐工具调用顺序: ${order.join(" → ")}`,
        });
      }
    }

    return recommendations;
  }

  // ─── 工具模式统计 ──────────────────────────────────────────

  /**
   * 更新工具调用模式统计。
   */
  updateToolPatternStats(
    toolName: string,
    success: boolean,
    duration: number,
    params?: Record<string, unknown>,
    context?: string,
    predecessor?: string,
    successor?: string,
  ): void {
    let stats = this.toolPatternStats.get(toolName);
    if (!stats) {
      stats = {
        toolName,
        totalCalls: 0,
        successCalls: 0,
        avgDuration: 0,
        commonParams: [],
        predecessorTools: new Map(),
        successorTools: new Map(),
        bestContexts: [],
      };
      this.toolPatternStats.set(toolName, stats);
      this.pruneToolPatternStats();
    }

    stats.totalCalls++;
    if (success) stats.successCalls++;

    // 更新平均耗时（指数移动平均）
    stats.avgDuration = stats.avgDuration === 0
      ? duration
      : stats.avgDuration * 0.8 + duration * 0.2;

    // 更新参数频率
    if (params) {
      const paramsKey = JSON.stringify(params);
      const existing = stats.commonParams.find(p => JSON.stringify(p.params) === paramsKey);
      if (existing) {
        existing.count++;
      } else if (stats.commonParams.length < 10) {
        stats.commonParams.push({ params, count: 1 });
      }
    }

    // 更新前置/后继工具
    if (predecessor) {
      stats.predecessorTools.set(predecessor, (stats.predecessorTools.get(predecessor) ?? 0) + 1);
    }
    if (successor) {
      stats.successorTools.set(successor, (stats.successorTools.get(successor) ?? 0) + 1);
    }

    // 更新最佳上下文
    if (context && success) {
      const existing = stats.bestContexts.find(c => c.context === context);
      if (existing) {
        const total = stats.totalCalls;
        existing.successRate = stats.successCalls / total;
      } else if (stats.bestContexts.length < 5) {
        stats.bestContexts.push({ context, successRate: success ? 1 : 0 });
      }
    }
  }

  /**
   * 获取工具的模式统计。
   */
  getToolPatternStats(toolName: string): ToolPatternStats | undefined {
    return this.toolPatternStats.get(toolName);
  }

  // ─── 提示词反馈自适应 ──────────────────────────────────────

  /**
   * 记录用户对 Agent 回复的提示词反馈。
   */
  recordPromptFeedback(params: {
    type: PromptFeedbackEntry["type"];
    agentResponse: string;
    userFeedback: string;
    templateName?: string;
  }): void {
    this.promptFeedbackLog.push({
      id: `fb_${uuid().slice(0, 8)}`,
      type: params.type,
      agentResponse: params.agentResponse.slice(0, 500),
      userFeedback: params.userFeedback,
      timestamp: new Date(),
      templateName: params.templateName,
    });

    // 限制反馈日志大小
    while (this.promptFeedbackLog.length > 100) {
      this.promptFeedbackLog.shift();
    }

    // 分析近期反馈趋势
    this.analyzePromptFeedback();

    logger.info({ feedbackType: params.type, total: this.promptFeedbackLog.length }, "Prompt feedback recorded");
  }

  /**
   * 分析提示词反馈趋势，生成自适应建议。
   */
  analyzePromptFeedback(): {
    negativeRatio: number;
    topIssue: string;
    totalRecent: number;
  } | null {
    const recent = this.promptFeedbackLog.slice(-20);
    if (recent.length < 5) return null;

    const negativeTypes = ["too_long", "too_short", "irrelevant", "confusing"];
    const recentNegative = recent.filter(f => negativeTypes.includes(f.type));
    const negativeRatio = recentNegative.length / recent.length;

    // 负面反馈比例过高
    if (negativeRatio >= 0.4) {
      logger.warn({ negativeRatio, topIssue: this.getTopFeedbackIssue(recentNegative) }, "Negative feedback trend detected");
    }

    return {
      negativeRatio,
      topIssue: this.getTopFeedbackIssue(recentNegative),
      totalRecent: recent.length,
    };
  }

  /**
   * 获取最常见的负面反馈类型。
   */
  getTopFeedbackIssue(feedbacks: PromptFeedbackEntry[]): string {
    const counts = new Map<string, number>();
    for (const fb of feedbacks) {
      counts.set(fb.type, (counts.get(fb.type) ?? 0) + 1);
    }
    const sorted = Array.from(counts.entries()).sort(([, a], [, b]) => b - a);
    return sorted[0]?.[0] ?? "unknown";
  }

  /**
   * 获取策略缓存统计。
   */
  getStrategyCacheStats(): {
    totalStrategies: number;
    mostUsed?: { name: string; useCount: number };
    totalUseCount: number;
  } {
    let mostUsed: { name: string; useCount: number } | undefined;
    let totalUseCount = 0;

    for (const strat of this.strategyCache.values()) {
      totalUseCount += strat.useCount;
      if (!mostUsed || strat.useCount > mostUsed.useCount) {
        mostUsed = { name: strat.name, useCount: strat.useCount };
      }
    }

    return {
      totalStrategies: this.strategyCache.size,
      mostUsed,
      totalUseCount,
    };
  }

  /**
   * Task 8: 截断 strategyCache — 按 useCount 降序 + lastUsedAt 降序，保留最热门的
   */
  private pruneStrategyCache(): void {
    if (this.strategyCache.size <= StrategyLearner.MAX_STRATEGY_CACHE) return;
    const sorted = Array.from(this.strategyCache.entries())
      .sort((a, b) => {
        // 优先按使用次数排序，其次按最近使用时间
        const countDiff = b[1].useCount - a[1].useCount;
        if (countDiff !== 0) return countDiff;
        return b[1].lastUsedAt.getTime() - a[1].lastUsedAt.getTime();
      });
    this.strategyCache.clear();
    for (const [k, v] of sorted.slice(0, StrategyLearner.MAX_STRATEGY_CACHE)) {
      this.strategyCache.set(k, v);
    }
  }

  /**
   * Task 8: 截断 toolPatternStats — 按 totalCalls 降序，保留最活跃的工具统计
   */
  private pruneToolPatternStats(): void {
    if (this.toolPatternStats.size <= StrategyLearner.MAX_TOOL_PATTERN_STATS) return;
    const sorted = Array.from(this.toolPatternStats.entries())
      .sort((a, b) => b[1].totalCalls - a[1].totalCalls);
    this.toolPatternStats.clear();
    for (const [k, v] of sorted.slice(0, StrategyLearner.MAX_TOOL_PATTERN_STATS)) {
      this.toolPatternStats.set(k, v);
    }
  }
}
