/**
 * Insights 统计引擎 — 多维统计 + 趋势分析 + 瓶颈识别
 *
 * 参考 Hermes insights.py 791 行实现：
 * - 工具调用频次/成功率
 * - 会话时长/轮次统计
 * - 技能使用率
 * - 周/月维度趋势分析
 * - 自动瓶颈识别与优化建议
 */

import pino from "pino";
import type { InteractionCase, EvolutionStats } from "./engine.js";

const logger = pino({ name: "evolution:insights" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 工具统计 */
export interface ToolInsight {
  name: string;
  callCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgResponseTime?: number;
  lastUsedAt?: Date;
}

/** 会话统计 */
export interface SessionInsight {
  totalSessions: number;
  avgTurnsPerSession: number;
  avgDurationMs: number;
  completionRate: number; // 用户未中途放弃的比例
}

/** 趋势数据点 */
export interface TrendPoint {
  period: string; // 如 "2026-W16", "2026-04"
  successRate: number;
  totalInteractions: number;
  avgScore: number;
  topTools: string[];
}

/** 瓶颈识别结果 */
export interface Bottleneck {
  type: "low_success_tool" | "frequent_failure" | "slow_response" | "skill_gap";
  severity: "high" | "medium" | "low";
  description: string;
  suggestion: string;
  relatedData: Record<string, unknown>;
}

/** 完整 Insights 报告 */
export interface InsightsReport {
  generatedAt: Date;
  period: { from: Date; to: Date };
  overview: {
    totalInteractions: number;
    successRate: number;
    avgScore: number;
    uniqueTools: number;
  };
  toolInsights: ToolInsight[];
  sessionInsight: SessionInsight;
  trends: TrendPoint[];
  bottlenecks: Bottleneck[];
}

// ═══════════════════════════════════════════════════════════════
// Insights Engine
// ═══════════════════════════════════════════════════════════════

export class InsightsEngine {
  private cases: InteractionCase[] = [];
  private readonly maxCases: number;

  constructor(options?: { maxCases?: number }) {
    this.maxCases = options?.maxCases ?? 10000;
  }

  /** 添加交互案例 */
  addCase(interactionCase: InteractionCase): void {
    this.cases.push(interactionCase);
    // 限制存储量
    if (this.cases.length > this.maxCases) {
      this.cases = this.cases.slice(-this.maxCases);
    }
  }

  /** 批量添加案例 */
  addCases(interactionCases: InteractionCase[]): void {
    for (const c of interactionCases) this.addCase(c);
  }

  /** 生成完整 Insights 报告 */
  generateReport(options?: {
    fromDate?: Date;
    toDate?: Date;
  }): InsightsReport {
    const from = options?.fromDate ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 默认 30 天
    const to = options?.toDate ?? new Date();

    const filtered = this.cases.filter(
      (c) => c.timestamp >= from && c.timestamp <= to
    );

    const toolInsights = this.computeToolInsights(filtered);
    const sessionInsight = this.computeSessionInsights(filtered);
    const trends = this.computeTrends(filtered);
    const bottlenecks = this.identifyBottlenecks(toolInsights, sessionInsight, filtered);

    const successCount = filtered.filter((c) => c.success).length;
    const scores = filtered.map((c) => c.score ?? 0).filter((s) => s > 0);
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

    const uniqueTools = new Set(filtered.flatMap((c) => c.toolCalls));

    return {
      generatedAt: new Date(),
      period: { from, to },
      overview: {
        totalInteractions: filtered.length,
        successRate: filtered.length > 0 ? successCount / filtered.length : 0,
        avgScore,
        uniqueTools: uniqueTools.size,
      },
      toolInsights,
      sessionInsight,
      trends,
      bottlenecks,
    };
  }

  /** 获取给 Nudge 使用的简要统计（注入到 prompt） */
  getNudgeSummary(): string {
    const recent = this.cases.slice(-50);
    if (recent.length === 0) return "";

    const successRate = recent.filter((c) => c.success).length / recent.length;
    const toolCounts = new Map<string, number>();
    for (const c of recent) {
      for (const tool of c.toolCalls) {
        toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
      }
    }

    const topTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name}(${count})`)
      .join(", ");

    const failureCategories = new Map<string, number>();
    for (const c of recent) {
      if (!c.success && c.failureCategory) {
        failureCategories.set(c.failureCategory, (failureCategories.get(c.failureCategory) ?? 0) + 1);
      }
    }

    const topFailures = [...failureCategories.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cat, count]) => `${cat}(${count})`)
      .join(", ");

    return [
      `[Insights] 最近${recent.length}次交互: 成功率${(successRate * 100).toFixed(0)}%`,
      topTools ? `常用工具: ${topTools}` : "",
      topFailures ? `主要失败: ${topFailures}` : "",
    ].filter(Boolean).join(" | ");
  }

  // ─── 内部计算 ──────────────────────────────────────────────

  private computeToolInsights(cases: InteractionCase[]): ToolInsight[] {
    const toolStats = new Map<string, { calls: number; successes: number; failures: number; lastUsed: Date }>();

    for (const c of cases) {
      for (const tool of c.toolCalls) {
        const stats = toolStats.get(tool) ?? { calls: 0, successes: 0, failures: 0, lastUsed: c.timestamp };
        stats.calls++;
        if (c.success) stats.successes++;
        else stats.failures++;
        if (c.timestamp > stats.lastUsed) stats.lastUsed = c.timestamp;
        toolStats.set(tool, stats);
      }
    }

    return [...toolStats.entries()]
      .map(([name, stats]) => ({
        name,
        callCount: stats.calls,
        successCount: stats.successes,
        failureCount: stats.failures,
        successRate: stats.calls > 0 ? stats.successes / stats.calls : 0,
        lastUsedAt: stats.lastUsed,
      }))
      .sort((a, b) => b.callCount - a.callCount);
  }

  private computeSessionInsights(cases: InteractionCase[]): SessionInsight {
    const sessions = new Map<string, InteractionCase[]>();
    for (const c of cases) {
      const list = sessions.get(c.sessionId) ?? [];
      list.push(c);
      sessions.set(c.sessionId, list);
    }

    const sessionList = [...sessions.values()];
    const avgTurns = sessionList.length > 0
      ? sessionList.reduce((sum, s) => sum + s.length, 0) / sessionList.length
      : 0;

    // 完成率：最后一条消息成功的会话比例
    const completedSessions = sessionList.filter(
      (s) => s.length > 0 && s[s.length - 1].success
    ).length;

    return {
      totalSessions: sessions.size,
      avgTurnsPerSession: avgTurns,
      avgDurationMs: 0, // 需要时间戳差值计算
      completionRate: sessionList.length > 0 ? completedSessions / sessionList.length : 0,
    };
  }

  private computeTrends(cases: InteractionCase[]): TrendPoint[] {
    // 按周分组
    const weekBuckets = new Map<string, InteractionCase[]>();
    for (const c of cases) {
      const week = this.getWeekString(c.timestamp);
      const bucket = weekBuckets.get(week) ?? [];
      bucket.push(c);
      weekBuckets.set(week, bucket);
    }

    return [...weekBuckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, weekCases]) => {
        const successRate = weekCases.filter((c) => c.success).length / weekCases.length;
        const scores = weekCases.map((c) => c.score ?? 0).filter((s) => s > 0);
        const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

        const toolCounts = new Map<string, number>();
        for (const c of weekCases) {
          for (const t of c.toolCalls) toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);
        }
        const topTools = [...toolCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([name]) => name);

        return {
          period,
          successRate,
          totalInteractions: weekCases.length,
          avgScore,
          topTools,
        };
      });
  }

  private identifyBottlenecks(
    toolInsights: ToolInsight[],
    sessionInsight: SessionInsight,
    cases: InteractionCase[]
  ): Bottleneck[] {
    const bottlenecks: Bottleneck[] = [];

    // 低成功率工具
    for (const tool of toolInsights) {
      if (tool.callCount >= 5 && tool.successRate < 0.5) {
        bottlenecks.push({
          type: "low_success_tool",
          severity: tool.successRate < 0.3 ? "high" : "medium",
          description: `工具 ${tool.name} 成功率仅 ${(tool.successRate * 100).toFixed(0)}%（${tool.callCount}次调用）`,
          suggestion: `检查 ${tool.name} 的参数描述是否准确，或考虑添加错误处理指导`,
          relatedData: { tool: tool.name, successRate: tool.successRate, calls: tool.callCount },
        });
      }
    }

    // 频繁失败类别
    const failureCounts = new Map<string, number>();
    for (const c of cases) {
      if (!c.success && c.failureCategory) {
        failureCounts.set(c.failureCategory, (failureCounts.get(c.failureCategory) ?? 0) + 1);
      }
    }
    for (const [category, count] of failureCounts) {
      if (count >= 5) {
        bottlenecks.push({
          type: "frequent_failure",
          severity: count >= 10 ? "high" : "medium",
          description: `${category} 类型失败出现 ${count} 次`,
          suggestion: `针对 ${category} 失败模式创建专门的处理技能`,
          relatedData: { category, count },
        });
      }
    }

    // 低完成率
    if (sessionInsight.totalSessions >= 10 && sessionInsight.completionRate < 0.5) {
      bottlenecks.push({
        type: "skill_gap",
        severity: "high",
        description: `会话完成率仅 ${(sessionInsight.completionRate * 100).toFixed(0)}%`,
        suggestion: "分析未完成会话的共性，识别缺失的技能或知识",
        relatedData: { completionRate: sessionInsight.completionRate },
      });
    }

    return bottlenecks.sort((a, b) => {
      const severityOrder = { high: 0, medium: 1, low: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
  }

  private getWeekString(date: Date): string {
    const d = new Date(date);
    const oneJan = new Date(d.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((d.getTime() - oneJan.getTime()) / 86400000 + oneJan.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
  }
}
