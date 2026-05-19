/**
 * Evolution Tracking — NudgeTracker + CaseCollector
 *
 * 两个统计/收集类：
 * - NudgeTracker：Hermes 式 nudge 系统，按轮次/工具迭代触发记忆复习和技能审查
 * - CaseCollector：MemSkill 式失败案例收集器，按容量+时间窗口自动裁剪
 *
 * 类型依赖：InteractionCase / NudgeConfig 由 engine.ts 提供（import type，编译期消除）
 *
 * @why 拆分自原 evolution/engine.ts（v3 Task 9 上帝文件拆分，1631 → ~1436 行）
 */

import type { InteractionCase, NudgeConfig } from "./engine.js";

// ─── NudgeTracker ────────────────────────────────────────────

export class NudgeTracker {
  private config: NudgeConfig;
  private turnsSinceMemoryReview: number = 0;
  private itersSinceSkillReview: number = 0;
  private memoryNudgeCount: number = 0;
  private skillNudgeCount: number = 0;
  private _totalTurns: number = 0;
  private _totalToolIterations: number = 0;
  // 六维提升 Task4: 会话搜索触发计数器（参考 Hermes memory nudge）
  private _turnsSinceSessionSearch: number = 0;
  private _sessionSearchInterval: number = 15; // 每 15 轮触发一次会话搜索建议
  private _insightsSummary: string = ""; // Insights 统计摘要缓存

  constructor(config?: Partial<NudgeConfig>) {
    this.config = {
      memoryReviewInterval: config?.memoryReviewInterval ?? 10,
      skillReviewInterval: config?.skillReviewInterval ?? 10,
      autoApplySkills: config?.autoApplySkills ?? false,
      combinedReview: config?.combinedReview ?? false,
      flushMinTurns: config?.flushMinTurns ?? 6, // 学 Hermes flush_min_turns: 6
    };
  }

  /** Record a user turn, return structured result */
  recordTurn(): { shouldReviewMemory: boolean; shouldSearchSessions: boolean } {
    this._totalTurns++;
    this._turnsSinceSessionSearch++;
    let shouldReviewMemory = false;
    let shouldSearchSessions = false;

    if (this.config.memoryReviewInterval > 0) {
      this.turnsSinceMemoryReview++;
      if (this.turnsSinceMemoryReview >= this.config.memoryReviewInterval) {
        this.turnsSinceMemoryReview = 0;
        this.memoryNudgeCount++;
        shouldReviewMemory = true;
      }
    }

    // 六维提升 Task4: 会话搜索触发
    if (this._sessionSearchInterval > 0 && this._turnsSinceSessionSearch >= this._sessionSearchInterval) {
      this._turnsSinceSessionSearch = 0;
      shouldSearchSessions = true;
    }

    return { shouldReviewMemory, shouldSearchSessions };
  }

  /** Record a tool iteration, return structured result */
  recordToolIteration(): { shouldReviewSkills: boolean } {
    this._totalToolIterations++;
    if (this.config.skillReviewInterval <= 0) return { shouldReviewSkills: false };
    this.itersSinceSkillReview++;
    if (this.itersSinceSkillReview >= this.config.skillReviewInterval) {
      this.itersSinceSkillReview = 0;
      this.skillNudgeCount++;
      return { shouldReviewSkills: true };
    }
    return { shouldReviewSkills: false };
  }

  /** Reset after a skill was manually created/updated */
  resetSkillCounter(): void {
    this.itersSinceSkillReview = 0;
  }

  /** 六维提升 Task4: 设置 Insights 摘要（注入到 nudge prompt） */
  setInsightsSummary(summary: string): void {
    this._insightsSummary = summary;
  }

  /** 六维提升 Task4: 获取 Insights 摘要 */
  getInsightsSummary(): string {
    return this._insightsSummary;
  }

  /** 六维提升 Task4: 设置会话搜索间隔 */
  setSessionSearchInterval(interval: number): void {
    this._sessionSearchInterval = interval;
  }

  getStats(): { totalTurns: number; totalToolIterations: number; memoryNudges: number; skillNudges: number; turnsSinceSessionSearch: number } {
    return {
      totalTurns: this._totalTurns,
      totalToolIterations: this._totalToolIterations,
      memoryNudges: this.memoryNudgeCount,
      skillNudges: this.skillNudgeCount,
      turnsSinceSessionSearch: this._turnsSinceSessionSearch,
    };
  }

  getConfig(): NudgeConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<NudgeConfig>): void {
    Object.assign(this.config, config);
    // Phase B-2: 持久化到 SQLite（动态导入避免循环依赖）
    import("../persistence/sqlite.js").then(({ saveNudgeConfig }) => {
      saveNudgeConfig(this.config as unknown as Record<string, unknown>);
    }).catch(() => { /* 持久化失败不影响内存配置 */ });
  }
}

// ─── CaseCollector ───────────────────────────────────────────

export class CaseCollector {
  private cases: Map<string, InteractionCase> = new Map();
  private maxCases: number;
  private windowMs: number; // Time window for pruning

  constructor(maxCases: number = 200, windowHours: number = 48) {
    this.maxCases = maxCases;
    this.windowMs = windowHours * 60 * 60 * 1000;
  }

  /** Add an interaction case */
  addCase(caseData: InteractionCase): void {
    // Update existing or add new
    const existing = this.cases.get(caseData.id);
    if (existing) {
      Object.assign(existing, caseData);
    } else {
      this.cases.set(caseData.id, caseData);
    }
    this.prune();
  }

  /** Get all failure cases */
  getFailureCases(): InteractionCase[] {
    return Array.from(this.cases.values()).filter((c) => !c.success);
  }

  /** Get all cases */
  getAllCases(): InteractionCase[] {
    return Array.from(this.cases.values());
  }

  /** Get failure cases grouped by category */
  getFailuresByCategory(): Map<string, InteractionCase[]> {
    const groups = new Map<string, InteractionCase[]>();
    for (const c of this.getFailureCases()) {
      const cat = c.failureCategory ?? "other";
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(c);
    }
    return groups;
  }

  /** Get stats */
  getStats(): { total: number; failures: number; successRate: number; avgScore: number } {
    const all = this.cases.size;
    const failures = this.getFailureCases().length;
    const cases = Array.from(this.cases.values());
    const scored = cases.filter((c) => c.score !== undefined);
    const avgScore = scored.length > 0 ? scored.reduce((s, c) => s + (c.score ?? 0), 0) / scored.length : 0;
    return {
      total: all,
      failures,
      successRate: all > 0 ? (all - failures) / all : 1,
      avgScore,
    };
  }

  /** Clear all cases */
  clear(): void {
    this.cases.clear();
  }

  private prune(): void {
    const now = Date.now();
    // Time-based pruning
    for (const [id, c] of this.cases) {
      if (now - c.timestamp.getTime() > this.windowMs) {
        this.cases.delete(id);
      }
    }
    // Capacity pruning — keep most recent
    if (this.cases.size > this.maxCases) {
      const sorted = Array.from(this.cases.entries())
        .sort((a, b) => b[1].timestamp.getTime() - a[1].timestamp.getTime());
      this.cases = new Map(sorted.slice(0, this.maxCases));
    }
  }
}
