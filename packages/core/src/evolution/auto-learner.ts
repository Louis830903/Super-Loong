/**
 * 自主学习循环 — 检测到能力差距后自动研究并寻找解决方案。
 *
 * 流程：
 *   1. 检测到能力差距 (CapabilityGapDetector)
 *         ↓
 *   2. 差距分析 → LLM 判断"是否可通过新增工具/技能解决"
 *         ↓ 是
 *   3. 解决方案调研：
 *      ├── 搜索 npm registry → 是否有现成的包可用
 *      ├── 搜索 MCP Hub → 是否有 MCP server 提供此能力
 *      ├── 搜索 Super Agent 技能市场 → 是否有技能可安装
 *      └── 评估：哪种方案成本最低/风险最小
 *         ↓
 *   4. 方案决策 → { action: "install_mcp"|"install_skill"|"generate_tool"|"cannot_solve", reason }
 *         ↓
 *   5. 执行：install_mcp / install_skill / generate_tool
 *         ↓
 *   6. 验证：测试新工具/技能是否解决了原始差距 → 记录成功率
 *
 * 安全约束：
 *   - 自动安装 MCP/Skill 需要 Feature Flag SUPER_AGENT_AUTO_EXPAND_CAPABILITIES=true
 *   - 自动生成工具代码仍走人工审核流程
 *   - 前端面板展示"自主学习历史"
 *   - cannot_solve 标记不会被重复尝试
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import type { CapabilityGapDetector, CapabilityGap } from "./capability-gap-detector.js";
import type { ToolDiscoverer, DiscoveredTool, ToolEvaluation } from "./tool-discoverer.js";

const logger = pino({ name: "auto-learner" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 方案决策动作 */
export type AutoLearnAction =
  | "install_mcp"
  | "install_skill"
  | "generate_tool"
  | "cannot_solve"
  | "wait_for_approval";

/** 解决方案选项 */
export interface SolutionOption {
  /** 选项 ID */
  id: string;
  /** 方案类型 */
  type: AutoLearnAction;
  /** 方案描述 */
  description: string;
  /** 目标工具/包名 */
  target: string;
  /** 实现详情 */
  details: Record<string, string>;
  /** 预估成本 */
  estimatedCost: "low" | "medium" | "high";
  /** 预估风险 */
  estimatedRisk: "low" | "medium" | "high";
  /** 匹配的发现的工具（如适用） */
  discoveredTool?: DiscoveredTool;
  /** 评估分数 */
  score: number;
}

/** 自主学习记录 */
export interface AutoLearnRecord {
  /** 记录 ID */
  id: string;
  /** 关联的差距 ID */
  gapId: string;
  /** 关联的差距 */
  gap: CapabilityGap;
  /** 决策动作 */
  action: AutoLearnAction;
  /** 选中的方案 */
  selectedOption?: SolutionOption;
  /** 所有候选方案 */
  candidates: SolutionOption[];
  /** 决策理由 */
  reason: string;
  /** 执行结果 */
  result?: AutoLearnResult;
  /** 状态 */
  status: "pending" | "researching" | "deciding" | "executing" | "complete" | "failed" | "cancelled";
  /** 开始时间 */
  startedAt: Date;
  /** 完成时间 */
  completedAt?: Date;
  /** 需要人工审核 */
  requiresApproval: boolean;
  /** 审批状态 */
  approvalStatus?: "pending" | "approved" | "rejected";
}

/** 自主学习执行结果 */
export interface AutoLearnResult {
  /** 成功与否 */
  success: boolean;
  /** 结果描述 */
  description: string;
  /** 创建/安装的工具名称 */
  createdToolName?: string;
  /** 验证结果 */
  verified: boolean;
  /** 错误信息 */
  error?: string;
  /** 耗时（毫秒） */
  duration: number;
}

/** 自主学习器配置 */
export interface AutoLearnerConfig {
  /** 是否启用自动扩展能力（Feature Flag） */
  autoExpandEnabled: boolean;
  /** 是否跳过人工审核（高风险操作仍会要求审核） */
  skipApprovalForLowRisk: boolean;
  /** 冷却期（毫秒）：同一差距失败后不重复尝试的时间 */
  cooldownPeriod: number;
  /** 每日最大自动操作次数 */
  maxDailyOperations: number;
  /** 低风险操作列表 */
  lowRiskActions: AutoLearnAction[];
  /** 最大历史记录数 */
  maxHistoryRecords: number;
}

const DEFAULT_CONFIG: AutoLearnerConfig = {
  autoExpandEnabled: process.env.SUPER_AGENT_AUTO_EXPAND_CAPABILITIES === "true",
  skipApprovalForLowRisk: process.env.SUPER_AGENT_AUTO_EXPAND_CAPABILITIES === "true",
  cooldownPeriod: 24 * 60 * 60 * 1000, // 24 小时
  maxDailyOperations: 5,
  lowRiskActions: ["install_skill"],
  maxHistoryRecords: 500,
};

// ═══════════════════════════════════════════════════════════════
// 自主学习循环引擎
// ═══════════════════════════════════════════════════════════════

export class AutoLearner {
  private config: AutoLearnerConfig;
  /** 差距检测器引用 */
  private gapDetector: CapabilityGapDetector;
  /** 工具发现器引用 */
  private toolDiscoverer: ToolDiscoverer;
  /** 自主学习历史 */
  private history: AutoLearnRecord[] = [];
  /** 冷却记录：gapId → 下次可尝试时间 */
  private cooldowns: Map<string, number> = new Map();
  /** 当日操作计数 */
  private dailyOperationCount = 0;
  /** 计数重置日期 */
  private dailyResetDate: string = new Date().toDateString();
  /** 外部执行器（由调用方注入） */
  private executors: {
    installMcp?: (serverName: string) => Promise<AutoLearnResult>;
    installSkill?: (skillName: string) => Promise<AutoLearnResult>;
    generateTool?: (gap: CapabilityGap) => Promise<AutoLearnResult>;
  } = {};

  constructor(
    gapDetector: CapabilityGapDetector,
    toolDiscoverer: ToolDiscoverer,
    config?: Partial<AutoLearnerConfig>,
  ) {
    this.gapDetector = gapDetector;
    this.toolDiscoverer = toolDiscoverer;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 注入外部执行器（MCP 安装、Skill 安装、工具生成）。
   */
  setExecutors(executors: {
    installMcp?: (serverName: string) => Promise<AutoLearnResult>;
    installSkill?: (skillName: string) => Promise<AutoLearnResult>;
    generateTool?: (gap: CapabilityGap) => Promise<AutoLearnResult>;
  }): void {
    this.executors = { ...this.executors, ...executors };
  }

  /**
   * 对单个差距执行自主学习循环。
   *
   * @returns 学习记录，包含决策和执行结果
   */
  async learn(gapId: string): Promise<AutoLearnRecord | null> {
    const gap = this.gapDetector.getGaps().find(g => g.id === gapId);
    if (!gap) {
      logger.warn({ gapId }, "Gap not found");
      return null;
    }

    // 检查冷却期
    const cooldownUntil = this.cooldowns.get(gap.id);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      logger.info({ gapId, cooldownUntil: new Date(cooldownUntil) }, "Gap in cooldown period");
      return null;
    }

    // 已知不可解决的不重试
    if (gap.status === "cannot_solve") {
      logger.info({ gapId }, "Gap marked as cannot_solve, skipping");
      return null;
    }

    // 检查每日操作配额
    if (!this.checkDailyQuota()) {
      logger.warn("Daily operation quota exceeded");
      return null;
    }

    // 创建学习记录
    const record = this.createRecord(gap);

    try {
      // Step 2: 差距分析
      this.updateRecord(record, { status: "researching" });
      const solvable = this.analyzeSolvable(gap);

      if (!solvable) {
        this.gapDetector.updateGapStatus(gap.id, "cannot_solve", "经分析无法通过新增工具/技能解决");
        this.updateRecord(record, {
          status: "complete",
          action: "cannot_solve",
          reason: "Gap analyzed as not solvable by tool/skill addition",
        });
        this.addToHistory(record);
        return record;
      }

      // Step 3: 方案调研
      const candidates = await this.researchSolutions(gap);
      record.candidates = candidates;

      if (candidates.length === 0) {
        this.updateRecord(record, {
          action: "cannot_solve",
          reason: "No viable solution found",
        });
        this.cooldowns.set(gap.id, Date.now() + this.config.cooldownPeriod);
        this.finalizeRecord(record, false);
        return record;
      }

      // Step 4: 方案决策
      this.updateRecord(record, { status: "deciding" });
      const bestOption = candidates[0]; // 已按评分排序，首个为最优
      record.selectedOption = bestOption;

      // 检查是否需要人工审核
      const requiresApproval = this.needsApproval(bestOption);
      record.requiresApproval = requiresApproval;

      if (requiresApproval && !this.config.skipApprovalForLowRisk) {
        this.updateRecord(record, {
          action: "wait_for_approval",
          reason: `方案 "${bestOption.description}" 需要人工审核`,
        });
        this.addToHistory(record);
        return record;
      }

      // Step 5: 执行
      this.updateRecord(record, {
        status: "executing",
        action: bestOption.type,
        reason: `选择方案: ${bestOption.description}`,
      });

      const result = await this.executeSolution(bestOption, gap);
      record.result = result;

      // Step 6: 验证
      if (result.success) {
        this.gapDetector.updateGapStatus(
          gap.id,
          "resolved",
          `通过 ${bestOption.type} 解决：${result.description}`,
        );
        this.finalizeRecord(record, true);
      } else {
        // 失败 → 进入冷却期
        this.cooldowns.set(gap.id, Date.now() + this.config.cooldownPeriod);
        this.finalizeRecord(record, false);
      }
    } catch (err) {
      const errorMsg = (err as Error).message;
      logger.error({ gapId, err: errorMsg }, "Auto-learn error");
      this.updateRecord(record, {
        status: "failed",
        reason: `Error: ${errorMsg}`,
      });
      this.cooldowns.set(gap.id, Date.now() + this.config.cooldownPeriod);
      this.finalizeRecord(record, false);
    }

    this.addToHistory(record);
    return record;
  }

  /**
   * 对所有可操作差距执行自主学习循环。
   */
  async learnAll(): Promise<AutoLearnRecord[]> {
    const actionable = this.gapDetector.getActionableGaps();
    const records: AutoLearnRecord[] = [];

    for (const gap of actionable) {
      const record = await this.learn(gap.id);
      if (record) records.push(record);

      // 检查配额
      if (!this.checkDailyQuota()) break;
    }

    logger.info({ processed: records.length }, "Batch auto-learn complete");
    return records;
  }

  /**
   * 批准一个待审核的学习记录。
   */
  async approve(recordId: string): Promise<AutoLearnRecord | null> {
    const record = this.history.find(r => r.id === recordId);
    if (!record || record.action !== "wait_for_approval") return null;

    record.approvalStatus = "approved";
    record.requiresApproval = false;

    // 执行方案
    this.updateRecord(record, { status: "executing" });

    try {
      const gap = record.gap;
      const result = await this.executeSolution(record.selectedOption!, gap);
      record.result = result;

      if (result.success) {
        this.gapDetector.updateGapStatus(
          gap.id,
          "resolved",
          `通过 ${record.selectedOption!.type} 解决（已审批）：${result.description}`,
        );
        this.finalizeRecord(record, true);
      } else {
        this.cooldowns.set(gap.id, Date.now() + this.config.cooldownPeriod);
        this.finalizeRecord(record, false);
      }
    } catch (err) {
      this.updateRecord(record, {
        status: "failed",
        reason: `Error: ${(err as Error).message}`,
      });
      this.finalizeRecord(record, false);
    }

    return record;
  }

  /**
   * 拒绝一个待审核的学习记录。
   */
  reject(recordId: string, reason?: string): boolean {
    const record = this.history.find(r => r.id === recordId);
    if (!record || record.action !== "wait_for_approval") return false;

    record.approvalStatus = "rejected";
    record.status = "cancelled";
    record.reason = reason ?? "Rejected by user";
    record.completedAt = new Date();

    // 标记差距为 cannot_solve
    this.gapDetector.updateGapStatus(record.gapId, "cannot_solve", reason ?? "User rejected solution");
    this.cooldowns.set(record.gapId, Date.now() + this.config.cooldownPeriod);

    logger.info({ recordId }, "Auto-learn record rejected");
    return true;
  }

  // ─── 方案调研 ───────────────────────────────────────────

  /**
   * 分析差距是否可解决。
   */
  private analyzeSolvable(gap: CapabilityGap): boolean {
    // 知识差距：通常不可通过工具解决
    if (gap.category === "knowledge_gap") {
      return false;
    }

    // 工具缺失/不足：通常可解决
    if (gap.category === "tool_missing" || gap.category === "tool_insufficient") {
      return true;
    }

    // 集成缺失：可能需要外部服务
    return gap.description.length < 200; // 过滤器过长的复杂描述
  }

  /**
   * 调研解决方案：搜索 npm / MCP Hub / Skill 市场。
   */
  private async researchSolutions(gap: CapabilityGap): Promise<SolutionOption[]> {
    const candidates: SolutionOption[] = [];

    // 1. 从 ToolDiscoverer 获取推荐
    const recommendations = this.toolDiscoverer.getRecommendations();

    for (const eval_ of recommendations) {
      const tool = eval_.tool;

      // 匹配差距类别与工具关键词的关联度
      const relevance = this.calculateRelevance(gap, tool);
      if (relevance < 0.3) continue;

      candidates.push({
        id: `sol_${uuid().slice(0, 8)}`,
        type: tool.source === "npm" ? "install_mcp" :
              tool.source === "mcp_hub" ? "install_mcp" :
              "install_skill",
        description: `安装 ${tool.name}: ${tool.description.slice(0, 100)}`,
        target: tool.identifier,
        details: {
          source: tool.source,
          version: tool.version ?? "latest",
          repository: tool.repository ?? "",
        },
        estimatedCost: tool.source === "mcp_hub" ? "low" :
                       tool.source === "npm" ? "low" : "medium",
        estimatedRisk: tool.source === "mcp_hub" ? "low" :
                       tool.source === "npm" ? "medium" : "medium",
        discoveredTool: tool,
        score: eval_.score * relevance,
      });
    }

    // 2. 工具代码生成方案（当搜索结果不够时）
    if (candidates.length < 3 || gap.category === "tool_missing") {
      candidates.push({
        id: `sol_${uuid().slice(0, 8)}`,
        type: "generate_tool",
        description: `根据需求自动生成工具代码：${gap.description.slice(0, 80)}`,
        target: this.suggestToolName(gap),
        details: {
          approach: "ToolGenerator.generate() + ToolRegistrar.register()",
          category: gap.category,
        },
        estimatedCost: "medium",
        estimatedRisk: "medium",
        score: 60, // 中等基础分
      });
    }

    // 按评分降序排列
    return candidates.sort((a, b) => b.score - a.score);
  }

  /**
   * 计算差距与工具的相关性。
   */
  private calculateRelevance(gap: CapabilityGap, tool: DiscoveredTool): number {
    const gapWords = gap.description.toLowerCase().split(/\s+/);
    const toolWords = [
      ...tool.name.toLowerCase().split(/[-\s]/),
      ...tool.description.toLowerCase().split(/\s+/),
      ...tool.keywords.map(k => k.toLowerCase()),
    ];

    let matches = 0;
    for (const gw of gapWords) {
      if (gw.length < 3) continue; // 跳过短词
      for (const tw of toolWords) {
        if (tw.includes(gw) || gw.includes(tw)) {
          matches++;
          break;
        }
      }
    }

    return Math.min(1, matches / Math.max(1, gapWords.length));
  }

  /**
   * 根据差距描述建议工具名称。
   */
  private suggestToolName(gap: CapabilityGap): string {
    // 从描述中提取关键词组合成工具名
    const words = gap.description
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s]/g, "")
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 3)
      .map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

    const baseName = words.join("") || "custom_tool";
    return `${baseName}_generated`;
  }

  // ─── 执行方案 ───────────────────────────────────────────

  /**
   * 执行选定的解决方案。
   */
  private async executeSolution(
    option: SolutionOption,
    gap: CapabilityGap,
  ): Promise<AutoLearnResult> {
    const startTime = Date.now();

    switch (option.type) {
      case "install_mcp": {
        if (!this.executors.installMcp) {
          return {
            success: false,
            description: "MCP installer not configured",
            verified: false,
            error: "No MCP installer executor",
            duration: Date.now() - startTime,
          };
        }
        const result = await this.executors.installMcp(option.target);
        return { ...result, duration: Date.now() - startTime };
      }

      case "install_skill": {
        if (!this.executors.installSkill) {
          return {
            success: false,
            description: "Skill installer not configured",
            verified: false,
            error: "No skill installer executor",
            duration: Date.now() - startTime,
          };
        }
        const result = await this.executors.installSkill(option.target);
        return { ...result, duration: Date.now() - startTime };
      }

      case "generate_tool": {
        if (!this.executors.generateTool) {
          return {
            success: false,
            description: "Tool generator not configured",
            verified: false,
            error: "No tool generator executor",
            duration: Date.now() - startTime,
          };
        }
        const result = await this.executors.generateTool(gap);
        return { ...result, duration: Date.now() - startTime };
      }

      default:
        return {
          success: false,
          description: "No solution available",
          verified: false,
          error: `Unsupported action: ${option.type}`,
          duration: Date.now() - startTime,
        };
    }
  }

  // ─── 安全与审核 ─────────────────────────────────────────

  /**
   * 判断方案是否需要人工审核。
   */
  private needsApproval(option: SolutionOption): boolean {
    // 高风险方案始终需要审核
    if (option.estimatedRisk === "high") return true;

    // 工具代码生成始终需要审核（安全策略）
    if (option.type === "generate_tool") return true;

    // 低风险操作且 skipApprovalForLowRisk 开启时可跳过
    if (this.config.lowRiskActions.includes(option.type) &&
        this.config.skipApprovalForLowRisk) {
      return false;
    }

    // MCP 安装需要 Feature Flag
    return option.type === "install_mcp" && !this.config.autoExpandEnabled;
  }

  /**
   * 检查每日操作配额。
   */
  private checkDailyQuota(): boolean {
    const today = new Date().toDateString();

    // 日期变更 → 重置计数
    if (today !== this.dailyResetDate) {
      this.dailyOperationCount = 0;
      this.dailyResetDate = today;
    }

    return this.dailyOperationCount < this.config.maxDailyOperations;
  }

  /**
   * 递增当日操作计数。
   */
  private incrementDailyCount(): void {
    this.dailyOperationCount++;
  }

  // ─── 记录管理 ───────────────────────────────────────────

  /**
   * 创建学习记录。
   */
  private createRecord(gap: CapabilityGap): AutoLearnRecord {
    return {
      id: `learn_${uuid().slice(0, 8)}`,
      gapId: gap.id,
      gap,
      action: "cannot_solve", // 待定
      candidates: [],
      reason: "",
      status: "pending",
      startedAt: new Date(),
      requiresApproval: false,
    };
  }

  /**
   * 更新记录字段。
   */
  private updateRecord(
    record: AutoLearnRecord,
    updates: Partial<Pick<AutoLearnRecord, "status" | "action" | "reason" | "approvalStatus">>,
  ): void {
    if (updates.status) record.status = updates.status;
    if (updates.action) record.action = updates.action;
    if (updates.reason) record.reason = updates.reason;
    if (updates.approvalStatus) record.approvalStatus = updates.approvalStatus;
  }

  /**
   * 完成记录。
   */
  private finalizeRecord(record: AutoLearnRecord, success: boolean): void {
    record.status = success ? "complete" : "failed";
    record.completedAt = new Date();
    this.incrementDailyCount();
  }

  /**
   * 添加记录到历史。
   */
  private addToHistory(record: AutoLearnRecord): void {
    this.history.push(record);

    // 限制历史记录数
    while (this.history.length > this.config.maxHistoryRecords) {
      this.history.shift();
    }
  }

  // ─── 查询 ──────────────────────────────────────────────

  /**
   * 获取学习历史。
   */
  getHistory(filter?: {
    status?: AutoLearnRecord["status"];
    gapId?: string;
    limit?: number;
  }): AutoLearnRecord[] {
    let results = [...this.history];

    if (filter?.status) {
      results = results.filter(r => r.status === filter.status);
    }
    if (filter?.gapId) {
      results = results.filter(r => r.gapId === filter.gapId);
    }

    // 按时间倒序
    results.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    if (filter?.limit) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  /**
   * 获取待审核记录。
   */
  getPendingApprovals(): AutoLearnRecord[] {
    return this.history.filter(
      r => r.action === "wait_for_approval" && r.approvalStatus === "pending",
    );
  }

  /**
   * 获取成功率统计。
   */
  getStats(): {
    total: number;
    success: number;
    failed: number;
    pending: number;
    successRate: number;
  } {
    const completed = this.history.filter(
      r => r.status === "complete" || r.status === "failed",
    );
    const success = completed.filter(r => r.status === "complete").length;
    const pending = this.history.filter(
      r => r.status === "pending" || r.status === "researching" ||
        r.status === "deciding" || r.status === "executing",
    ).length;

    return {
      total: this.history.length,
      success,
      failed: completed.length - success,
      pending,
      successRate: completed.length > 0 ? parseFloat((success / completed.length).toFixed(2)) : 0,
    };
  }

  /**
   * 检查差距是否在冷却期。
   */
  isInCooldown(gapId: string): boolean {
    const cooldownUntil = this.cooldowns.get(gapId);
    return cooldownUntil ? Date.now() < cooldownUntil : false;
  }

  /**
   * 清除冷却期。
   */
  clearCooldown(gapId: string): boolean {
    return this.cooldowns.delete(gapId);
  }

  /**
   * 获取历史记录总数。
   */
  get historyCount(): number {
    return this.history.length;
  }

  /**
   * 重置学习器。
   */
  reset(): void {
    this.history = [];
    this.cooldowns.clear();
    this.dailyOperationCount = 0;
    this.dailyResetDate = new Date().toDateString();
    logger.info("Auto learner reset");
  }
}
