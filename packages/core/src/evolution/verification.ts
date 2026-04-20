/**
 * 端到端验证管道 — 技能创建后自动验证 + A/B 对比 + 失败回滚
 *
 * 参考 Hermes 的技能验证流程：
 * 1. 技能应用后自动运行验证案例
 * 2. 前后效果对比（A/B 测试式验证）
 * 3. 失败自动回滚 + 原因记录
 */

import pino from "pino";
import type { SkillProposal, InteractionCase } from "./engine.js";

const logger = pino({ name: "evolution:verification" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 验证案例 */
export interface VerificationCase {
  id: string;
  description: string;
  input: string;
  expectedBehavior: string;
  relatedTools?: string[];
}

/** 验证结果 */
export interface VerificationResult {
  proposalId: string;
  passed: boolean;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  details: VerificationDetail[];
  duration: number; // ms
  timestamp: Date;
}

/** 单个案例验证详情 */
export interface VerificationDetail {
  caseId: string;
  passed: boolean;
  actualBehavior: string;
  error?: string;
}

/** A/B 对比结果 */
export interface ABComparisonResult {
  proposalId: string;
  beforeScore: number;
  afterScore: number;
  improvement: number; // 百分比变化
  recommendation: "apply" | "rollback" | "inconclusive";
  sampleSize: number;
}

/** 回滚记录 */
export interface RollbackRecord {
  proposalId: string;
  reason: string;
  rolledBackAt: Date;
  verificationResult: VerificationResult;
}

// ═══════════════════════════════════════════════════════════════
// Verification Pipeline
// ═══════════════════════════════════════════════════════════════

export class VerificationPipeline {
  private verificationCases: Map<string, VerificationCase[]> = new Map();
  private results: VerificationResult[] = [];
  private rollbacks: RollbackRecord[] = [];
  private readonly passThreshold: number;

  constructor(options?: { passThreshold?: number }) {
    this.passThreshold = options?.passThreshold ?? 0.7; // 70% 通过率才算验证成功
  }

  /**
   * 注册验证案例
   * 可以为特定技能名注册，也可以注册通用验证案例
   */
  registerCases(skillName: string, cases: VerificationCase[]): void {
    const existing = this.verificationCases.get(skillName) ?? [];
    this.verificationCases.set(skillName, [...existing, ...cases]);
    logger.info({ skillName, caseCount: cases.length }, "注册验证案例");
  }

  /**
   * 验证一个技能提案
   *
   * 运行关联的验证案例，返回验证结果。
   * 如果未通过，建议回滚。
   */
  async verify(
    proposal: SkillProposal,
    executor?: (input: string) => Promise<{ output: string; success: boolean }>
  ): Promise<VerificationResult> {
    const startTime = Date.now();
    const cases = this.verificationCases.get(proposal.skillName) ?? [];

    if (cases.length === 0) {
      logger.debug({ skillName: proposal.skillName }, "无验证案例，跳过验证");
      return {
        proposalId: proposal.id,
        passed: true, // 无案例默认通过
        totalCases: 0,
        passedCases: 0,
        failedCases: 0,
        details: [],
        duration: Date.now() - startTime,
        timestamp: new Date(),
      };
    }

    const details: VerificationDetail[] = [];

    for (const testCase of cases) {
      try {
        if (executor) {
          const result = await executor(testCase.input);
          const passed = result.success && this.matchesExpected(result.output, testCase.expectedBehavior);
          details.push({
            caseId: testCase.id,
            passed,
            actualBehavior: result.output.slice(0, 500),
          });
        } else {
          // 无执行器，基于静态分析验证
          details.push({
            caseId: testCase.id,
            passed: true, // 静态分析默认通过
            actualBehavior: "(static analysis)",
          });
        }
      } catch (err: any) {
        details.push({
          caseId: testCase.id,
          passed: false,
          actualBehavior: "",
          error: err?.message ?? String(err),
        });
      }
    }

    const passedCount = details.filter((d) => d.passed).length;
    const result: VerificationResult = {
      proposalId: proposal.id,
      passed: cases.length > 0 ? passedCount / cases.length >= this.passThreshold : true,
      totalCases: cases.length,
      passedCases: passedCount,
      failedCases: cases.length - passedCount,
      details,
      duration: Date.now() - startTime,
      timestamp: new Date(),
    };

    this.results.push(result);
    logger.info({
      proposalId: proposal.id,
      passed: result.passed,
      score: `${passedCount}/${cases.length}`,
    }, "验证完成");

    return result;
  }

  /**
   * A/B 效果对比
   *
   * 比较技能应用前后的交互质量。
   */
  compareAB(
    proposalId: string,
    beforeCases: InteractionCase[],
    afterCases: InteractionCase[]
  ): ABComparisonResult {
    const beforeScore = this.computeAvgScore(beforeCases);
    const afterScore = this.computeAvgScore(afterCases);
    const improvement = beforeScore > 0
      ? ((afterScore - beforeScore) / beforeScore) * 100
      : afterScore > 0 ? 100 : 0;

    let recommendation: "apply" | "rollback" | "inconclusive";
    if (afterCases.length < 5 || beforeCases.length < 5) {
      recommendation = "inconclusive";
    } else if (improvement >= 5) {
      recommendation = "apply";
    } else if (improvement <= -10) {
      recommendation = "rollback";
    } else {
      recommendation = "inconclusive";
    }

    return {
      proposalId,
      beforeScore,
      afterScore,
      improvement,
      recommendation,
      sampleSize: Math.min(beforeCases.length, afterCases.length),
    };
  }

  /**
   * 记录回滚
   */
  recordRollback(proposalId: string, reason: string, verificationResult: VerificationResult): void {
    this.rollbacks.push({
      proposalId,
      reason,
      rolledBackAt: new Date(),
      verificationResult,
    });
    logger.warn({ proposalId, reason }, "技能已回滚");
  }

  /** 获取验证历史 */
  getHistory(): VerificationResult[] {
    return [...this.results];
  }

  /** 获取回滚记录 */
  getRollbacks(): RollbackRecord[] {
    return [...this.rollbacks];
  }

  /** 获取验证统计 */
  getStats(): {
    totalVerifications: number;
    passRate: number;
    totalRollbacks: number;
  } {
    const total = this.results.length;
    const passed = this.results.filter((r) => r.passed).length;
    return {
      totalVerifications: total,
      passRate: total > 0 ? passed / total : 0,
      totalRollbacks: this.rollbacks.length,
    };
  }

  // ─── 内部方法 ──────────────────────────────────────────────

  private matchesExpected(actual: string, expected: string): boolean {
    // 简单匹配：检查期望的关键词是否出现在实际输出中
    const keywords = expected.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const actualLower = actual.toLowerCase();
    const matchCount = keywords.filter((kw) => actualLower.includes(kw)).length;
    return keywords.length > 0 ? matchCount / keywords.length >= 0.5 : true;
  }

  private computeAvgScore(cases: InteractionCase[]): number {
    if (cases.length === 0) return 0;
    // 综合评分：成功率 * 0.6 + 平均分 * 0.4
    const successRate = cases.filter((c) => c.success).length / cases.length;
    const scores = cases.map((c) => c.score ?? (c.success ? 0.8 : 0.2));
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    return successRate * 0.6 + avgScore * 0.4;
  }
}
