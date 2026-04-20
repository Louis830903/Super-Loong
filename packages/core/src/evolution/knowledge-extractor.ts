/**
 * 知识提取器 — 从会话案例中提取可复用知识
 *
 * 参考 Hermes memory_tool.py 的知识分类逻辑：
 * - 工具使用模式：哪些工具组合常一起使用
 * - 错误处理策略：失败后的恢复方法
 * - 用户偏好：用户反复确认的偏好设置
 * - 领域知识：特定领域的事实性知识
 *
 * 知识去重与合并：相似知识点合并为更完整的版本。
 */

import pino from "pino";
import type { InteractionCase } from "./engine.js";

const logger = pino({ name: "evolution:knowledge-extractor" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 知识类别 */
export type KnowledgeCategory =
  | "tool_pattern"       // 工具使用模式
  | "error_strategy"     // 错误处理策略
  | "user_preference"    // 用户偏好
  | "domain_knowledge"   // 领域知识
  | "workflow"           // 工作流程
  | "best_practice";     // 最佳实践

/** 提取的知识条目 */
export interface KnowledgeEntry {
  id: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  confidence: number; // 0-1，置信度
  sourceCases: string[]; // 来源案例 ID
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  mergeCount: number; // 被合并的次数（越高越可靠）
}

/** 提取结果 */
export interface ExtractionResult {
  newEntries: KnowledgeEntry[];
  mergedEntries: KnowledgeEntry[];
  totalProcessed: number;
}

// ═══════════════════════════════════════════════════════════════
// Knowledge Extractor
// ═══════════════════════════════════════════════════════════════

export class KnowledgeExtractor {
  private knowledgeBase: Map<string, KnowledgeEntry> = new Map();
  private readonly similarityThreshold: number;

  constructor(options?: { similarityThreshold?: number }) {
    this.similarityThreshold = options?.similarityThreshold ?? 0.7;
  }

  /**
   * 从一批交互案例中提取知识
   */
  async extractFromCases(
    cases: InteractionCase[],
    llmCall?: (prompt: string) => Promise<string>
  ): Promise<ExtractionResult> {
    const newEntries: KnowledgeEntry[] = [];
    const mergedEntries: KnowledgeEntry[] = [];
    let totalProcessed = 0;

    // 按类别分析案例
    const toolPatterns = this.extractToolPatterns(cases);
    const errorStrategies = this.extractErrorStrategies(cases);

    // 合并工具模式
    for (const pattern of toolPatterns) {
      const existing = this.findSimilar(pattern);
      if (existing) {
        this.mergeKnowledge(existing, pattern);
        mergedEntries.push(existing);
      } else {
        this.knowledgeBase.set(pattern.id, pattern);
        newEntries.push(pattern);
      }
      totalProcessed++;
    }

    // 合并错误策略
    for (const strategy of errorStrategies) {
      const existing = this.findSimilar(strategy);
      if (existing) {
        this.mergeKnowledge(existing, strategy);
        mergedEntries.push(existing);
      } else {
        this.knowledgeBase.set(strategy.id, strategy);
        newEntries.push(strategy);
      }
      totalProcessed++;
    }

    // LLM 深度提取（如果可用）
    if (llmCall && cases.length >= 3) {
      const llmEntries = await this.llmExtract(cases, llmCall);
      for (const entry of llmEntries) {
        const existing = this.findSimilar(entry);
        if (existing) {
          this.mergeKnowledge(existing, entry);
          mergedEntries.push(existing);
        } else {
          this.knowledgeBase.set(entry.id, entry);
          newEntries.push(entry);
        }
        totalProcessed++;
      }
    }

    logger.info({
      newCount: newEntries.length,
      mergedCount: mergedEntries.length,
      totalProcessed,
    }, "知识提取完成");

    return { newEntries, mergedEntries, totalProcessed };
  }

  /** 获取所有知识条目 */
  getAllKnowledge(): KnowledgeEntry[] {
    return Array.from(this.knowledgeBase.values());
  }

  /** 按类别获取知识 */
  getByCategory(category: KnowledgeCategory): KnowledgeEntry[] {
    return this.getAllKnowledge().filter((e) => e.category === category);
  }

  /** 搜索知识（简单关键词匹配） */
  searchKnowledge(query: string): KnowledgeEntry[] {
    const keywords = query.toLowerCase().split(/\s+/);
    return this.getAllKnowledge().filter((entry) => {
      const text = `${entry.title} ${entry.content} ${entry.tags.join(" ")}`.toLowerCase();
      return keywords.some((kw) => text.includes(kw));
    });
  }

  /** 获取高置信度知识（可用于 nudge 注入） */
  getHighConfidenceKnowledge(minConfidence: number = 0.8): KnowledgeEntry[] {
    return this.getAllKnowledge()
      .filter((e) => e.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence);
  }

  /** 知识库统计 */
  getStats(): Record<string, number> {
    const stats: Record<string, number> = { total: this.knowledgeBase.size };
    for (const entry of this.knowledgeBase.values()) {
      stats[entry.category] = (stats[entry.category] ?? 0) + 1;
    }
    return stats;
  }

  // ─── 内部提取方法 ──────────────────────────────────────────

  /**
   * 提取工具使用模式
   * 分析哪些工具经常一起使用，哪些工具组合效率最高
   */
  private extractToolPatterns(cases: InteractionCase[]): KnowledgeEntry[] {
    const entries: KnowledgeEntry[] = [];
    const toolCombos = new Map<string, { count: number; successCount: number; caseIds: string[] }>();

    for (const c of cases) {
      if (c.toolCalls.length < 2) continue;
      const combo = [...c.toolCalls].sort().join("+");
      const existing = toolCombos.get(combo) ?? { count: 0, successCount: 0, caseIds: [] };
      existing.count++;
      if (c.success) existing.successCount++;
      existing.caseIds.push(c.id);
      toolCombos.set(combo, existing);
    }

    // 过滤出反复出现的组合（至少 2 次）
    for (const [combo, stats] of toolCombos) {
      if (stats.count < 2) continue;
      const successRate = stats.successCount / stats.count;
      entries.push({
        id: `tp_${combo.replace(/\+/g, "_").slice(0, 30)}_${Date.now()}`,
        category: "tool_pattern",
        title: `工具组合: ${combo}`,
        content: `工具 ${combo} 经常一起使用（${stats.count}次），成功率 ${(successRate * 100).toFixed(0)}%`,
        confidence: Math.min(0.5 + successRate * 0.3 + stats.count * 0.05, 1),
        sourceCases: stats.caseIds.slice(0, 5),
        tags: combo.split("+"),
        createdAt: new Date(),
        updatedAt: new Date(),
        mergeCount: 0,
      });
    }

    return entries;
  }

  /**
   * 提取错误处理策略
   * 分析失败案例中的恢复模式
   */
  private extractErrorStrategies(cases: InteractionCase[]): KnowledgeEntry[] {
    const entries: KnowledgeEntry[] = [];
    const failureBuckets = new Map<string, InteractionCase[]>();

    // 按失败类别分组
    for (const c of cases) {
      if (c.success || !c.failureCategory) continue;
      const bucket = failureBuckets.get(c.failureCategory) ?? [];
      bucket.push(c);
      failureBuckets.set(c.failureCategory, bucket);
    }

    // 提取每个类别的共性
    for (const [category, failedCases] of failureBuckets) {
      if (failedCases.length < 2) continue;

      const reasons = failedCases
        .map((c) => c.failureReason)
        .filter(Boolean)
        .slice(0, 5);

      entries.push({
        id: `es_${category}_${Date.now()}`,
        category: "error_strategy",
        title: `失败模式: ${category}`,
        content: `${category} 类型失败出现 ${failedCases.length} 次。常见原因：${reasons.join("; ")}`,
        confidence: Math.min(0.4 + failedCases.length * 0.1, 0.9),
        sourceCases: failedCases.slice(0, 5).map((c) => c.id),
        tags: [category, "error", "failure"],
        createdAt: new Date(),
        updatedAt: new Date(),
        mergeCount: 0,
      });
    }

    return entries;
  }

  /**
   * LLM 深度知识提取
   */
  private async llmExtract(
    cases: InteractionCase[],
    llmCall: (prompt: string) => Promise<string>
  ): Promise<KnowledgeEntry[]> {
    const caseSummary = cases
      .slice(0, 10)
      .map((c, i) => `[${i + 1}] User: ${c.userMessage.slice(0, 200)}\n    Tools: ${c.toolCalls.join(", ")}\n    Success: ${c.success}`)
      .join("\n");

    const prompt = `分析以下交互案例，提取可复用的知识。

${caseSummary}

请返回 JSON 数组，每个条目包含：
{
  "category": "tool_pattern" | "error_strategy" | "user_preference" | "domain_knowledge" | "workflow" | "best_practice",
  "title": "简短标题",
  "content": "详细描述",
  "tags": ["标签1", "标签2"],
  "confidence": 0.0-1.0
}

只返回 JSON 数组，不要额外解释。`;

    try {
      const response = await llmCall(prompt);
      const parsed = JSON.parse(response.match(/\[[\s\S]*\]/)?.[0] ?? "[]");

      return parsed.map((item: any, i: number) => ({
        id: `llm_${Date.now()}_${i}`,
        category: item.category ?? "domain_knowledge",
        title: item.title ?? "",
        content: item.content ?? "",
        confidence: item.confidence ?? 0.5,
        sourceCases: cases.slice(0, 3).map((c) => c.id),
        tags: item.tags ?? [],
        createdAt: new Date(),
        updatedAt: new Date(),
        mergeCount: 0,
      }));
    } catch (err) {
      logger.error({ err }, "LLM 知识提取失败");
      return [];
    }
  }

  // ─── 知识去重与合并 ────────────────────────────────────────

  private findSimilar(entry: KnowledgeEntry): KnowledgeEntry | null {
    for (const existing of this.knowledgeBase.values()) {
      if (existing.category !== entry.category) continue;
      if (this.computeSimilarity(existing, entry) >= this.similarityThreshold) {
        return existing;
      }
    }
    return null;
  }

  private computeSimilarity(a: KnowledgeEntry, b: KnowledgeEntry): number {
    // 简单的标题+标签重叠度计算
    const aWords = new Set(`${a.title} ${a.tags.join(" ")}`.toLowerCase().split(/\s+/));
    const bWords = new Set(`${b.title} ${b.tags.join(" ")}`.toLowerCase().split(/\s+/));
    const intersection = [...aWords].filter((w) => bWords.has(w)).length;
    const union = new Set([...aWords, ...bWords]).size;
    return union > 0 ? intersection / union : 0;
  }

  private mergeKnowledge(existing: KnowledgeEntry, newEntry: KnowledgeEntry): void {
    existing.mergeCount++;
    existing.updatedAt = new Date();
    // 置信度随合并次数增长
    existing.confidence = Math.min(existing.confidence + 0.05, 1);
    // 合并来源案例
    const allCases = new Set([...existing.sourceCases, ...newEntry.sourceCases]);
    existing.sourceCases = [...allCases].slice(0, 10);
    // 合并标签
    existing.tags = [...new Set([...existing.tags, ...newEntry.tags])];
    // 如果新条目内容更长，更新内容
    if (newEntry.content.length > existing.content.length) {
      existing.content = newEntry.content;
    }
  }
}
