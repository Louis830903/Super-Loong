/**
 * 能力差距检测器 — 运行时监控 Agent 对话，识别能力缺口。
 *
 * 检测模式：
 *   1. Agent 回复"我无法做这件事，因为..."（LLM 自报能力边界）
 *   2. 用户说"你能帮我...吗"但 Agent 连续 3+ 个工具调用都失败
 *   3. 工具返回"不支持的平台"或"依赖未就绪"
 *   4. Agent 在 computer_use 循环中达到 maxSteps 仍未完成目标
 *
 * 差距分类：
 *   - tool_missing：缺少某个工具
 *   - tool_insufficient：工具有但功能不足
 *   - integration_missing：缺少外部服务集成
 *   - knowledge_gap：缺少领域知识
 *
 * 汇总分析：同一差距出现 3+ 次 → 自动提升优先级
 */

import { v4 as uuid } from "uuid";
import pino from "pino";

const logger = pino({ name: "capability-gap-detector" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 差距类别 */
export type GapCategory =
  | "tool_missing"
  | "tool_insufficient"
  | "integration_missing"
  | "knowledge_gap";

/** 单个能力差距记录 */
export interface CapabilityGap {
  /** 差距 ID */
  id: string;
  /** 差距类别 */
  category: GapCategory;
  /** 差距描述 */
  description: string;
  /** 关联的 Agent ID */
  agentId?: string;
  /** 首次检测时间 */
  detectedAt: Date;
  /** 最后一次检测时间 */
  lastDetectedAt: Date;
  /** 出现频次 */
  frequency: number;
  /** 尝试过的工具列表 */
  attemptedTools: string[];
  /** 关联的会话 ID 列表 */
  sessionIds: string[];
  /** 检测来源 */
  detectedBy: GapDetectionMethod;
  /** 关联的 agent 原始回复（截取前 500 字符） */
  sampleResponse?: string;
  /** LLM 判断：是否可通过新增工具/技能解决 */
  solvable: boolean;
  /** 建议的解决方案类型 */
  suggestedFix?: "generate_tool" | "install_mcp" | "install_skill" | "learn_knowledge" | "cannot_solve";
  /** 优先级（auto-computed）：1-5，5 为最高 */
  priority: number;
  /** 状态 */
  status: "open" | "in_progress" | "resolved" | "cannot_solve";
  /** 解决后的备注 */
  resolutionNote?: string;
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

/** 差距检测方法 */
export type GapDetectionMethod =
  | "self_report"       // Agent 自报边界
  | "tool_failure"      // 连续工具调用失败
  | "unsupported_platform" // 不支持的平台
  | "maxsteps_reached"  // computer_use 达到 maxSteps
  | "manual"            // 手动标记
  | "pattern_match";    // 模式匹配

/** 检测输入：来自 Agent 对话的消息 */
export interface GapDetectionInput {
  /** 关联会话 ID */
  sessionId: string;
  /** 关联 Agent ID */
  agentId?: string;
  /** 用户消息 */
  userMessage?: string;
  /** Agent 回复 */
  agentResponse?: string;
  /** 本 turn 的工具调用列表 */
  toolCalls?: Array<{ name: string; success: boolean; error?: string; output?: string }>;
  /** 是否达到 maxSteps */
  maxStepsReached?: boolean;
  /** computer_use 循环次数 */
  computerUseLoops?: number;
  /** 平台信息 */
  platform?: string;
}

/** 差距汇总报告 */
export interface GapReport {
  /** 总差距数 */
  totalGaps: number;
  /** 按类别分组统计 */
  byCategory: Record<GapCategory, number>;
  /** 高优先级差距（priority >= 4） */
  highPriority: CapabilityGap[];
  /** 需要立即处理的差距 */
  actionable: CapabilityGap[];
  /** 已知无法解决的限制 */
  knownLimitations: CapabilityGap[];
  /** 生成时间 */
  generatedAt: Date;
}

/** 检测器配置 */
export interface GapDetectorConfig {
  /** 同一差距自动提升优先级的频次阈值（默认 3） */
  priorityThreshold: number;
  /** 工具连续失败检测的阈值（默认 3） */
  consecutiveFailureThreshold: number;
  /** computer_use 循环 maxSteps 的警告阈值（默认 5） */
  maxstepsWarningThreshold: number;
  /** 已知限制去重窗口（毫秒，默认 7 天） */
  dedupWindowMs: number;
  /** 自动清理已解决差距的天数（默认 30 天） */
  cleanupResolvedDays: number;
}

const DEFAULT_CONFIG: GapDetectorConfig = {
  priorityThreshold: 3,
  consecutiveFailureThreshold: 3,
  maxstepsWarningThreshold: 5,
  dedupWindowMs: 7 * 24 * 60 * 60 * 1000,
  cleanupResolvedDays: 30,
};

// ═══════════════════════════════════════════════════════════════
// 自报能力边界的模式匹配
// ═══════════════════════════════════════════════════════════════

/** LLM 自报能力边界的正则模式 */
const SELF_REPORT_PATTERNS: Array<{ regex: RegExp; category: GapCategory }> = [
  {
    regex: /(?:我无法|我不能|我不会|我不支持|无法完成|无法执行|做不到|不能做)(?:.{0,20}?)(?:因为|由于|原因是)(.{10,200})/,
    category: "tool_missing",
  },
  {
    regex: /(?:目前|当前)(?:.{0,10}?)(?:不支持|没有|缺少|无法访问|无法连接)(.{5,100})/,
    category: "integration_missing",
  },
  {
    regex: /(?:需要|依赖)(?:.{0,10}?)(?:安装|配置|启用)(.{5,100})/,
    category: "tool_insufficient",
  },
  {
    regex: /(?:不了解|不熟悉|不懂|不擅长|超出.{0,5}知识范围)(.{5,100})/,
    category: "knowledge_gap",
  },
];

/** 工具失败输出中的不支持/依赖未就绪模式 */
const TOOL_FAILURE_PATTERNS: Array<{ regex: RegExp; category: GapCategory }> = [
  {
    regex: /unsupported\s*(?:platform|OS|system|architecture)/i,
    category: "tool_insufficient",
  },
  {
    regex: /(?:not\s*installed|not\s*found|command\s*not\s*found|missing\s*dependency)/i,
    category: "tool_insufficient",
  },
  {
    regex: /(?:permission\s*denied|access\s*denied|not\s*allowed)/i,
    category: "integration_missing",
  },
  {
    regex: /(?:network\s*(?:error|unreachable)|connection\s*(?:refused|timeout|failed))/i,
    category: "integration_missing",
  },
];

// ═══════════════════════════════════════════════════════════════
// 能力差距检测器
// ═══════════════════════════════════════════════════════════════

export class CapabilityGapDetector {
  /** 所有检测到的差距 */
  private gaps: Map<string, CapabilityGap> = new Map();
  /** 配置 */
  private config: GapDetectorConfig;
  /** 最近一次检测的会话 ID（用于去重） */
  private lastDetectionSessionId?: string;
  /** 当前会话中连续工具失败计数 */
  private consecutiveFailures: Map<string, number> = new Map();

  constructor(config?: Partial<GapDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 对一次 Agent 对话交互进行差距检测。
   * 返回本次检测到的新差距或更新后的已有差距。
   */
  detect(input: GapDetectionInput): CapabilityGap[] {
    const detected: CapabilityGap[] = [];

    // 1. 检测 LLM 自报能力边界
    if (input.agentResponse) {
      const selfReported = this.detectSelfReport(input);
      detected.push(...selfReported);
    }

    // 2. 检测连续工具调用失败
    if (input.toolCalls && input.toolCalls.length > 0) {
      const toolFailures = this.detectToolFailures(input);
      detected.push(...toolFailures);
    }

    // 3. 检测 computer_use maxSteps 达到上限
    if (input.maxStepsReached) {
      const maxStepGap = this.detectMaxstepsExceeded(input);
      if (maxStepGap) detected.push(maxStepGap);
    }

    return detected;
  }

  /**
   * 检测 Agent 自报能力边界。
   */
  private detectSelfReport(input: GapDetectionInput): CapabilityGap[] {
    const gaps: CapabilityGap[] = [];
    const response = input.agentResponse!;

    for (const pattern of SELF_REPORT_PATTERNS) {
      const match = response.match(pattern.regex);
      if (match) {
        const description = match[1]?.trim() ?? match[0];
        const gap = this.upsertGap({
          category: pattern.category,
          description: `Agent 自报边界：${description}`,
          agentId: input.agentId,
          sessionId: input.sessionId,
          detectedBy: "self_report",
          sampleResponse: response.slice(0, 500),
          solvable: true, // LLM 自报的通常标记为可解决
        });
        gaps.push(gap);
      }
    }

    return gaps;
  }

  /**
   * 检测工具调用失败模式。
   */
  private detectToolFailures(input: GapDetectionInput): CapabilityGap[] {
    const gaps: CapabilityGap[] = [];
    const toolCalls = input.toolCalls!;
    const sessionKey = input.sessionId;

    // 统计本次连续失败
    let consecutiveFailCount = 0;
    for (const call of toolCalls) {
      if (!call.success) {
        consecutiveFailCount++;

        // 检查失败输出中的模式
        if (call.error || call.output) {
          const errorText = call.error ?? call.output ?? "";
          for (const pattern of TOOL_FAILURE_PATTERNS) {
            if (pattern.regex.test(errorText)) {
              const gap = this.upsertGap({
                category: pattern.category,
                description: `工具 ${call.name} 失败：${errorText.slice(0, 200)}`,
                agentId: input.agentId,
                sessionId: input.sessionId,
                detectedBy: "tool_failure",
                attemptedTools: [call.name],
                solvable: true,
              });
              gaps.push(gap);
            }
          }
        }
      }
    }

    // 连续 3+ 次失败 → 标记为能力差距
    const prevCount = this.consecutiveFailures.get(sessionKey) ?? 0;
    const totalConsecutive = prevCount + consecutiveFailCount;

    if (totalConsecutive >= this.config.consecutiveFailureThreshold) {
      const failedToolNames = toolCalls
        .filter(c => !c.success)
        .map(c => c.name);

      const gap = this.upsertGap({
        category: "tool_missing",
        description: `连续 ${totalConsecutive} 次工具调用失败（${failedToolNames.join(", ")}）`,
        agentId: input.agentId,
        sessionId: input.sessionId,
        detectedBy: "tool_failure",
        attemptedTools: failedToolNames,
        solvable: true,
      });
      gaps.push(gap);

      // 重置计数
      this.consecutiveFailures.set(sessionKey, 0);
    } else {
      this.consecutiveFailures.set(sessionKey, totalConsecutive);
    }

    return gaps;
  }

  /**
   * 检测 computer_use maxSteps 达上限。
   */
  private detectMaxstepsExceeded(input: GapDetectionInput): CapabilityGap | null {
    const loops = input.computerUseLoops ?? 0;

    if (loops >= this.config.maxstepsWarningThreshold) {
      return this.upsertGap({
        category: "tool_insufficient",
        description: `computer_use 循环 ${loops} 次后达到 maxSteps 仍未完成目标`,
        agentId: input.agentId,
        sessionId: input.sessionId,
        detectedBy: "maxsteps_reached",
        solvable: true,
        suggestedFix: "generate_tool",
      });
    }

    return null;
  }

  /**
   * 手动标记一个能力差距。
   */
  markGap(params: {
    category: GapCategory;
    description: string;
    agentId?: string;
    sessionId?: string;
    solvable?: boolean;
    suggestedFix?: CapabilityGap["suggestedFix"];
  }): CapabilityGap {
    return this.upsertGap({
      ...params,
      sessionId: params.sessionId ?? "manual",
      detectedBy: "manual",
      solvable: params.solvable ?? true,
    });
  }

  // ─── 差距管理 ───────────────────────────────────────────

  /**
   * 更新或创建差距记录（去重）。
   * 如果已有相似的差距，增加频率并更新最后检测时间。
   */
  private upsertGap(params: {
    category: GapCategory;
    description: string;
    agentId?: string;
    sessionId: string;
    detectedBy: GapDetectionMethod;
    attemptedTools?: string[];
    sampleResponse?: string;
    solvable: boolean;
    suggestedFix?: CapabilityGap["suggestedFix"];
  }): CapabilityGap {
    // 查找是否已有相似差距（按类别 + 描述前缀匹配去重）
    const existing = this.findSimilar(params.category, params.description);

    if (existing) {
      // 更新已有记录
      existing.lastDetectedAt = new Date();
      existing.frequency++;
      if (params.sessionId && !existing.sessionIds.includes(params.sessionId)) {
        existing.sessionIds.push(params.sessionId);
      }
      if (params.attemptedTools) {
        for (const t of params.attemptedTools) {
          if (!existing.attemptedTools.includes(t)) {
            existing.attemptedTools.push(t);
          }
        }
      }
      if (params.suggestedFix) {
        existing.suggestedFix = params.suggestedFix;
      }
      // 重新计算优先级
      existing.priority = this.computePriority(existing);

      logger.info(
        { gapId: existing.id, frequency: existing.frequency, priority: existing.priority },
        "Updated existing capability gap",
      );
      return existing;
    }

    // 创建新记录
    const now = new Date();
    const gap: CapabilityGap = {
      id: `gap_${uuid().slice(0, 8)}`,
      category: params.category,
      description: params.description,
      agentId: params.agentId,
      detectedAt: now,
      lastDetectedAt: now,
      frequency: 1,
      attemptedTools: params.attemptedTools ?? [],
      sessionIds: [params.sessionId],
      detectedBy: params.detectedBy,
      sampleResponse: params.sampleResponse,
      solvable: params.solvable,
      suggestedFix: params.suggestedFix,
      priority: 1,
      status: "open",
    };
    gap.priority = this.computePriority(gap);

    this.gaps.set(gap.id, gap);
    logger.info({ gapId: gap.id, category: gap.category }, "New capability gap detected");
    return gap;
  }

  /**
   * 查找相似的已有差距（同一类别内描述前缀匹配）。
   */
  private findSimilar(category: GapCategory, description: string): CapabilityGap | undefined {
    const now = Date.now();
    const windowStart = now - this.config.dedupWindowMs;

    for (const gap of this.gaps.values()) {
      if (gap.category !== category) continue;
      if (gap.lastDetectedAt.getTime() < windowStart) continue;

      // 比较描述的前 60 个字符是否相似（简单前缀匹配）
      const shortDesc = description.slice(0, 60);
      const shortExisting = gap.description.slice(0, 60);

      // 使用 Levenshtein-like 比较：如果共享前缀长度 >= 短描述的一半
      const commonLen = this.commonPrefixLength(shortDesc, shortExisting);
      if (commonLen >= Math.min(shortDesc.length, shortExisting.length) * 0.5) {
        return gap;
      }
    }

    return undefined;
  }

  /**
   * 计算两个字符串的公共前缀长度。
   */
  private commonPrefixLength(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }

  /**
   * 根据频次和类别计算优先级（1-5）。
   */
  private computePriority(gap: CapabilityGap): number {
    let priority = 1;

    // 频次加分
    if (gap.frequency >= this.config.priorityThreshold) priority += 2;
    else if (gap.frequency >= 2) priority += 1;

    // 类别加权
    switch (gap.category) {
      case "tool_missing":        priority += 1; break; // 工具缺失 → 高优
      case "integration_missing":  priority += 1; break; // 集成缺失 → 高优
      case "tool_insufficient":    break;                // 默认
      case "knowledge_gap":        break;                // 默认
    }

    return Math.min(5, priority);
  }

  // ─── 查询与报告 ─────────────────────────────────────────

  /**
   * 获取所有差距。
   */
  getGaps(filter?: {
    category?: GapCategory;
    status?: CapabilityGap["status"];
    minPriority?: number;
    minFrequency?: number;
  }): CapabilityGap[] {
    let results = Array.from(this.gaps.values());

    if (filter?.category) {
      results = results.filter(g => g.category === filter.category);
    }
    if (filter?.status) {
      results = results.filter(g => g.status === filter.status);
    }
    if (filter?.minPriority !== undefined) {
      results = results.filter(g => g.priority >= filter.minPriority!);
    }
    if (filter?.minFrequency !== undefined) {
      results = results.filter(g => g.frequency >= filter.minFrequency!);
    }

    // 按优先级降序排列
    return results.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 获取高优先级待处理差距。
   */
  getHighPriorityGaps(): CapabilityGap[] {
    return this.getGaps({ minPriority: 4, status: "open" });
  }

  /**
   * 获取需要立即处理的差距（高优先级且可解决）。
   */
  getActionableGaps(): CapabilityGap[] {
    return this.getGaps({ status: "open", minPriority: 3 })
      .filter(g => g.solvable && g.suggestedFix !== "cannot_solve");
  }

  /**
   * 获取已知无法解决的限制列表。
   */
  getKnownLimitations(): CapabilityGap[] {
    return this.getGaps({ status: "cannot_solve" });
  }

  /**
   * 更新差距状态。
   */
  updateGapStatus(
    gapId: string,
    status: CapabilityGap["status"],
    resolutionNote?: string,
    suggestedFix?: CapabilityGap["suggestedFix"],
  ): boolean {
    const gap = this.gaps.get(gapId);
    if (!gap) return false;

    gap.status = status;
    if (resolutionNote) gap.resolutionNote = resolutionNote;
    if (suggestedFix) gap.suggestedFix = suggestedFix;
    gap.lastDetectedAt = new Date();

    logger.info({ gapId, newStatus: status }, "Gap status updated");
    return true;
  }

  /**
   * 生成差距汇总报告。
   */
  generateReport(): GapReport {
    const allGaps = Array.from(this.gaps.values());
    const byCategory: Record<GapCategory, number> = {
      tool_missing: 0,
      tool_insufficient: 0,
      integration_missing: 0,
      knowledge_gap: 0,
    };

    for (const gap of allGaps) {
      byCategory[gap.category]++;
    }

    return {
      totalGaps: allGaps.length,
      byCategory,
      highPriority: this.getHighPriorityGaps(),
      actionable: this.getActionableGaps(),
      knownLimitations: this.getKnownLimitations(),
      generatedAt: new Date(),
    };
  }

  /**
   * 清理已解决的差距（超过配置天数的）。
   */
  cleanupResolved(): number {
    const cutoff = Date.now() - this.config.cleanupResolvedDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const [id, gap] of this.gaps) {
      if (gap.status === "resolved" && gap.lastDetectedAt.getTime() < cutoff) {
        this.gaps.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      logger.info({ removed }, "Cleaned up resolved gaps");
    }
    return removed;
  }

  /**
   * 获取差距总数。
   */
  get count(): number {
    return this.gaps.size;
  }

  /**
   * 重置检测器（清除所有记录）。
   */
  reset(): void {
    this.gaps.clear();
    this.consecutiveFailures.clear();
    logger.info("Capability gap detector reset");
  }
}
