/**
 * Self-Evolution Engine.
 *
 * Implements two complementary evolution mechanisms:
 *
 * 1. **Nudge System** (Hermes-style):
 *    - Periodic review of conversations to extract reusable skills
 *    - Memory nudge: after N turns, review for user preferences/patterns
 *    - Skill nudge: after N tool iterations, review for reusable techniques
 *    - Background review runs post-response, non-blocking
 *
 * 2. **Skill Evolution** (MemSkill-style):
 *    - Collect failure cases from agent interactions
 *    - Analyze failure patterns (storage/retrieval/quality failures)
 *    - LLM-driven two-stage improvement: Analysis → Refinement
 *    - Track evolution snapshots with rollback to best state
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import { EventEmitter } from "eventemitter3";
import type { AgentManager } from "../agent/manager.js";
import { getContentText } from "../utils/content-helpers.js";
import { RiskEngine } from "./risk-engine.js";
import type { RiskDecision } from "./risk-engine.js";
import { safeJsonParseAny } from "../utils/json-guard.js";
import { EvolutionBudget } from "./evolution-budget.js";
import { LLMProvider } from "../llm/provider.js";
import type { LLMProviderConfig } from "../types/index.js";
import { CascadeDetector } from "./cascade-detector.js";
import { EvolutionCoordinator } from "./evolution-coordinator.js";
import { registerOperator } from "./operators/base.js";
import { RevisionOperator } from "./operators/revision.js";
import { RecombinationOperator } from "./operators/recombination.js";
import { RefinementOperator } from "./operators/refinement.js";
import { SelfModificationEngine } from "./self-modification-engine.js";
import { SandboxExecutor } from "./sandbox-executor.js";
import { EvolutionLock } from "./evolution-lock.js";
import { WorkflowEngine } from "./workflow-engine.js";
// Phase 6 (Task 6.4): 策略缓存与提示词自适应
import { ProgressiveAutomation } from "./progressive-automation.js";
import { SessionContinuityManager } from "./session-continuity.js";
// P1-1 瘦身: 策略学习器提取到独立模块
import { StrategyLearner } from "./strategy-learner.js";
import type { StrategyCacheEntry, ToolPatternStats, PromptFeedbackEntry } from "./strategy-learner.js";
// P1-2: 编码委托器
import { CodingDelegator } from "./coding-delegator.js";
// P1-1: 能力缺口检测器
import { CapabilityGapDetector } from "./capability-gap-detector.js";
import type { CapabilityGap } from "./capability-gap-detector.js";
// P1-2: 工具骨架生成器 + 提案持久化
import { ToolGenerator } from "./tool-generator.js";
import type { ToolRequirement } from "./tool-generator.js";
import { saveToolProposal, loadToolProposals, getToolProposal, updateToolProposalStatus } from "../persistence/sqlite.js";
// P1-3: 孤岛模块激活管理器
import { ActivationManager } from "./activation-manager.js";
// P2-T17: prompt 注入扫描（flushBeforeReset 记忆状态安全门控）
import { scanMemoryContent, sanitizeMemoryContent } from "../prompt/injection-guard.js";
// P4-T1a: review prompts 提取到独立文件
import {
  MEMORY_REVIEW_PROMPT,
  SKILL_REVIEW_PROMPT,
  COMBINED_REVIEW_PROMPT,
  ANALYSIS_PROMPT,
} from "./review-prompts.js";
// P4-T1b: 提案验证逻辑提取到独立模块
import {
  validateProposal as validateProposalImpl,
  scoreProposal as scoreProposalImpl,
} from "./proposal-validator.js";
// P4-T1c: 提案解析逻辑提取到独立模块
import {
  extractFirstJsonObject,
  parseProposals as parseProposalsImpl,
} from "./proposal-parser.js";
// P4-T1d: 提案应用逻辑提取到独立模块
import {
  applyProposal as applyProposalImpl,
  applyCodeProposal as applyCodeProposalImpl,
  type ApplierContext,
} from "./proposal-applier.js";

const logger = pino({ name: "evolution" });

// v3 Task 9 上帝文件拆分：NudgeTracker + CaseCollector 迁出到 evolution-tracking.ts
// InteractionCase / NudgeConfig 留在本文件（EvolutionEngine 内部消费），tracking 模块通过 import type 引用
import { NudgeTracker, CaseCollector } from "./evolution-tracking.js";
export { NudgeTracker, CaseCollector };

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** A recorded interaction case for evolution analysis */
export interface InteractionCase {
  id: string;
  agentId: string;
  sessionId: string;
  userMessage: string;
  agentResponse: string;
  toolCalls: string[];
  /** Whether the interaction was successful (user didn't complain, retry, or abandon) */
  success: boolean;
  /** Optional quality score from 0 to 1 */
  score?: number;
  /** Failure reason if unsuccessful */
  failureReason?: string;
  /** Category of failure: skill_gap, wrong_tool, bad_response, timeout */
  failureCategory?: "skill_gap" | "wrong_tool" | "bad_response" | "timeout" | "other";
  timestamp: Date;
  metadata?: Record<string, unknown>;
  /** Task 4.5: 关联的工作流 ID（用于工作流级进化分析） */
  workflowId?: string;
}

/** A proposed skill improvement from LLM analysis */
export interface SkillProposal {
  id: string;
  action: "create" | "update" | "patch" | "no_change"; // Phase B-3: 新增 "patch"
  skillName: string;
  description: string;
  content: string;
  reasoning: string;
  basedOnCases: string[];
  status: "pending" | "approved" | "applied" | "rejected";
  createdAt: Date;
  /** Phase B-3: patch 操作的增量修改（学 Hermes _patch_skill） */
  patchOperations?: Array<{ oldString: string; newString: string }>;
  /** Spec v3 Task 8: 质量评分 (0-100) */
  qualityScore?: number;
  /** Spec v3 Task 8: 验证结果 */
  validationResult?: {
    valid: boolean;
    errors: string[];
    scanVerdict?: string;
  };
  /** Task 1.1: 风险评分引擎结果 */
  riskScore?: number;
  /** Task 1.1: 风险决策级别 */
  riskDecision?: RiskDecision;
  /** Task 1.2: 三层技能库类型 */
  skillType?: "general" | "task_specific" | "common_mistake";
  /** Task 3.1: 自修改目标代码（提案不再是 .md，而是实际代码片段） */
  targetCode?: {
    /** 目标模块路径 */
    modulePath: string;
    /** 目标函数/类/方法名 */
    targetName: string;
    /** 新代码内容 */
    newCode: string;
    /** 操作类型 */
    operation: "modify" | "add" | "delete";
    /** P2-T16: delete 操作的审计快照（被删除函数的原始源码），用于审计和恢复，不覆盖 newCode */
    auditSnapshot?: string;
  };
  /** Task 3.5: 是否需要人工审核 */
  requiresHumanReview?: boolean;
  /** 审核理由 */
  reviewReason?: string;
}

/** Configuration for nudge intervals */
export interface NudgeConfig {
  memoryReviewInterval: number;   // Review memory every N turns (0 = disabled)
  skillReviewInterval: number;    // Review skills every N tool iterations (0 = disabled)
  autoApplySkills: boolean;       // Auto-apply approved skill proposals
  combinedReview: boolean;        // Review memory and skills together
  flushMinTurns: number;          // Phase A-2: 触发 flush 的最小轮数阈值（0=禁用）
}

/** Snapshot of the evolution state at a point in time */
export interface EvolutionSnapshot {
  id: string;
  label?: string;
  stageIndex: number;
  avgScore: number;
  totalCases: number;
  failureCases: number;
  skillProposals: SkillProposal[];
  timestamp: Date;
}

/** Stats for the evolution engine */
export interface EvolutionStats {
  totalInteractions: number;
  failedInteractions: number;
  successRate: number;
  totalProposals: number;
  appliedProposals: number;
  pendingProposals: number;
  totalSnapshots: number;
  bestScore: number;
  nudges: { memory: number; skill: number };
}

// ═══════════════════════════════════════════════════════════════
// T2.4 Reflection ↔ Evolution 联动
// ═══════════════════════════════════════════════════════════════

/**
 * 在线反思的 5 种分类 → InteractionCase.failureCategory 的 5 种枚举映射。
 *
 * 映射原则（按 Spec v1.3 L388-394）：
 *   - param_error    → wrong_tool   （参数用错也归入工具调用问题，借用现有枚举）
 *   - wrong_tool     → wrong_tool
 *   - external_error → timeout       （外部依赖故障与超时同类）
 *   - logic_error    → skill_gap     （调用顺序/前置步骤缺失 → 技能缺口）
 *   - ambiguous      → bad_response  （意图不清，需回复用户）
 */
export function mapReflectionCategoryToFailureCategory(
  category: "param_error" | "wrong_tool" | "external_error" | "logic_error" | "ambiguous",
): NonNullable<InteractionCase["failureCategory"]> {
  switch (category) {
    case "param_error":
      return "wrong_tool";
    case "wrong_tool":
      return "wrong_tool";
    case "external_error":
      return "timeout";
    case "logic_error":
      return "skill_gap";
    case "ambiguous":
      return "bad_response";
    default:
      return "other";
  }
}

// ═══════════════════════════════════════════════════════════════
// NudgeTracker + CaseCollector 已迁出到 ./evolution-tracking.ts
// 见文件顶部 import { NudgeTracker, CaseCollector } from "./evolution-tracking.js"
// re-export 已通过 export { NudgeTracker, CaseCollector } 保持外部 API 兼容
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Evolution Engine (Unified)
// ═══════════════════════════════════════════════════════════════

export class EvolutionEngine extends EventEmitter {
  private agentManager: AgentManager;
  private skillsDir: string;
  readonly nudge: NudgeTracker;
  readonly cases: CaseCollector;
  private proposals: Map<string, SkillProposal> = new Map();
  private snapshots: EvolutionSnapshot[] = [];
  private bestSnapshotIdx: number = -1;
  private riskEngine: RiskEngine;
  private budget: EvolutionBudget;
  private cascadeDetector: CascadeDetector;
  /** Task 2.1: 进化协调器——编排算子执行、错误匹配、热修复 */
  readonly coordinator: EvolutionCoordinator;
  /** Task 3.1: 自修改引擎 */
  readonly selfModification: SelfModificationEngine;
  /** Task 3.2: 沙箱执行器 */
  readonly sandbox: SandboxExecutor;
  /** Task 3.4: 进化锁 */
  readonly evoLock: EvolutionLock;
  /** Task 4.5: 工作流引擎（用于工作流级进化分析） */
  readonly workflowEngine: WorkflowEngine;
  /** Phase 6 (Task 6.4): 渐进自动化管理器 */
  readonly progressiveAutomation: ProgressiveAutomation;
  /** Phase 6 (Task 6.3): 会话连续性管理器 */
  readonly sessionContinuity: SessionContinuityManager;

  // P1-1 瘦身: 策略学习器（替代原 strategyCache / toolPatternStats / promptFeedbackLog）
  readonly strategyLearner: StrategyLearner;
  // P1-2: 编码委托器（外部 AI 编程工具委托与验证）
  readonly codingDelegator: CodingDelegator;

  // C-4: 内存增长上限，超出时 LRU 淘汰
  private static readonly MAX_PROPOSALS = 1000;
  private static readonly MAX_SNAPSHOTS = 100;
  // C-1: 自动失败分析阈值与冷却期
  private static readonly AUTO_ANALYZE_THRESHOLD = 10;
  private static readonly AUTO_ANALYZE_COOLDOWN_MS = 3600_000; // 1 小时
  private _lastAutoAnalyzeTime = 0;
  // C-3: 快照自动触发计数器
  private _proposalsAppliedSinceSnapshot = 0;
  private static readonly AUTO_SNAPSHOT_INTERVAL = 5;
  // [审查 P0-1]: analyzerAgentId → analyzerProviderId + analyzerModelId（纯 LLM 调用，不走 Agent）
  private _analyzerProviderId: string | null = null;
  private _analyzerModelId: string | null = null;
  /** ProviderStore 引用（可选，用于解析分析器 LLM 的 apiKey/baseUrl） */
  private providerStore?: { get(id: string): { apiKey?: string; baseUrl?: string; isEnabled?: boolean } | null | undefined };
  /** P1-1: 能力缺口检测器（对话中自动发现"缺什么工具/能力"） */
  private gapDetector: CapabilityGapDetector;
  /** P1-2: 工具骨架生成器（缺口 → 工具提案） */
  private toolGenerator: ToolGenerator;
  /** P1-3: 孤岛模块激活管理器（按 STAGE 分阶段激活自进化模块） */
  readonly activationManager: ActivationManager;
  /** P1-2/P1-3: ToolGenerator 是否已激活（STAGE>=2 时置 true） */
  private _toolGenActivated = false;

  constructor(
    agentManager: AgentManager,
    nudgeConfig?: Partial<NudgeConfig>,
    skillsDir = "./skills",
    providerStore?: { get(id: string): { apiKey?: string; baseUrl?: string; isEnabled?: boolean } | null | undefined },
  ) {
    super();
    this.agentManager = agentManager;
    this.skillsDir = skillsDir;
    this.nudge = new NudgeTracker(nudgeConfig);
    this.cases = new CaseCollector();
    this.riskEngine = new RiskEngine();
    this.budget = new EvolutionBudget();
    this.cascadeDetector = new CascadeDetector();
    this.coordinator = new EvolutionCoordinator();

    // Task 2.2: 注册三算子
    registerOperator("revision", RevisionOperator);
    registerOperator("recombination", RecombinationOperator);
    registerOperator("refinement", RefinementOperator);
    this.selfModification = new SelfModificationEngine();
    this.sandbox = new SandboxExecutor();
    this.evoLock = new EvolutionLock();
    this.workflowEngine = new WorkflowEngine();
    this.progressiveAutomation = new ProgressiveAutomation();
    this.sessionContinuity = new SessionContinuityManager();
    // P1-1 瘦身: 策略学习器注入 CaseCollector
    this.strategyLearner = new StrategyLearner(this.cases);
    // P1-2: 编码委托器（供外部调用委托 AI 编程任务）
    this.codingDelegator = new CodingDelegator();
    this.providerStore = providerStore;
    // P1-1: 初始化能力缺口检测器（persist=true → 缺口跨重启持久化到 capability_gaps 表）
    this.gapDetector = new CapabilityGapDetector({ persist: true });
    // P1-2: 工具骨架生成器
    this.toolGenerator = new ToolGenerator();
    // P1-3: 激活管理器 + 注入真实开关钩子（激活 ToolGenerator → 打开 P1-2 工具提案生成）
    this.activationManager = new ActivationManager();
    this.activationManager.setHooks({
      ToolGenerator: {
        activate: () => { this._toolGenActivated = true; },
        deactivate: () => { this._toolGenActivated = false; },
      },
    });
  }

  /** P1-1: 查询已检测到的能力缺口（供路由展示） */
  getCapabilityGaps(filter?: { status?: string; minPriority?: number }): CapabilityGap[] {
    return this.gapDetector.getGaps(filter as any);
  }

  // ─── P1-2: 工具骨架生成提案（Flag/STAGE 门控 + 人工审核） ──────────

  /** 工具提案生成频次阈值（缺口出现 N 次才提议生成工具） */
  private static readonly TOOLGEN_FREQUENCY_THRESHOLD = 3;

  /**
   * P1-2: 缺口达阈值时尝试生成工具提案（安全门控 + 异步容错）。
   * 门控：SUPER_AGENT_EVOLUTION_TOOLGEN=true 或 ToolGenerator 已激活(STAGE>=2)。
   */
  private maybeProposeToolForGap(gap: CapabilityGap): void {
    const enabled = process.env.SUPER_AGENT_EVOLUTION_TOOLGEN === "true" || this._toolGenActivated;
    if (!enabled) return;
    if (!gap.solvable) return;
    if (gap.frequency < EvolutionEngine.TOOLGEN_FREQUENCY_THRESHOLD) return;
    if (gap.suggestedFix && gap.suggestedFix !== "generate_tool") return;
    // 异步生成，不阻塞主流程
    this.generateToolProposal(gap).catch((err) =>
      logger.debug({ err, gapId: gap.id }, "P1-2: tool proposal generation failed (non-fatal)"),
    );
  }

  /**
   * P1-2: 为缺口生成工具骨架提案（generateSkeleton → LLM 填充 → 存 pending_review）。
   * 绝不自动注册/热加载——只生成候选代码，等人工审核。
   */
  async generateToolProposal(gap: CapabilityGap): Promise<string | null> {
    const toolName = this.deriveToolName(gap);
    const req: ToolRequirement = {
      description: gap.description.slice(0, 300),
      category: this.mapGapCategory(gap.category),
      toolName,
    };

    // 1. 生成骨架
    const skeleton = this.toolGenerator.generateSkeleton(req);

    // 2. LLM 填充 execute 函数体（无 LLM 时保留骨架 TODO）
    let generated = skeleton;
    const llmConfig = this.resolveAnalyzerLlmConfig();
    if (llmConfig) {
      try {
        const llm = new LLMProvider(llmConfig);
        const prompt = `你是 TypeScript 工具开发者。请为以下需求编写 execute 函数体（只输出函数体代码，不要 markdown 围栏，不要重复函数签名）：\n\n工具名：${toolName}\n需求：${gap.description}\n\n要求：\n- 使用 async/await\n- 返回 { content: [{ type: "text", text: "..." }] } 形式的 ToolResult\n- 禁用 eval、不删除文件、不执行 shell\n- 参数从 params 读取`;
        const resp = await llm.complete({ messages: [{ role: "user", content: prompt }] });
        const body = this.extractExecuteBody(resp.content ?? "");
        if (body.trim()) {
          generated = this.toolGenerator.fillExecuteBody(skeleton, body);
        }
      } catch (err) {
        logger.debug({ err }, "P1-2: LLM fill execute body failed, keeping skeleton");
      }
    }

    // 3. 存 tool_proposals (pending_review)
    const id = `toolprop_${uuid().slice(0, 8)}`;
    const now = new Date().toISOString();
    saveToolProposal({
      id,
      tool_name: toolName,
      category: req.category,
      description: gap.description.slice(0, 500),
      gap_id: gap.id,
      source_code: generated.sourceCode,
      file_path: generated.registration.filePath,
      feature_flag: generated.registration.featureFlag,
      dependencies: JSON.stringify(generated.dependencies ?? []),
      validation_json: JSON.stringify(generated.validation ?? {}),
      status: "pending_review",
      created_at: now,
      updated_at: now,
    });

    // 4. 落地候选文件（不注册不加载，仅供审阅/重启后加载）
    await this.writeProposalFile(generated.registration.filePath, generated.sourceCode);

    this.emit("toolProposal:generated", { id, toolName, gapId: gap.id });
    logger.info({ id, toolName, gapId: gap.id }, "P1-2: tool proposal generated (pending_review)");
    return id;
  }

  /** P1-2: 列出工具提案（供路由/前端展示）。 */
  getToolProposals(status?: string): Array<Record<string, unknown>> {
    try {
      return loadToolProposals(status);
    } catch (err) {
      logger.debug({ err }, "P1-2: loadToolProposals failed");
      return [];
    }
  }

  /**
   * P1-2: 批准工具提案——必须先通过静态校验（含安全扫描）才 approved。
   * 批准后仅标记状态 + 提示重启；绝不在运行时热注册未审计代码。
   */
  async approveToolProposal(id: string): Promise<{ ok: boolean; message: string }> {
    const row = getToolProposal(id);
    if (!row) return { ok: false, message: "提案不存在" };
    if (row.status !== "pending_review") {
      return { ok: false, message: `提案状态为 ${row.status}，无法批准` };
    }
    // 静态校验：导出契约 + 必要 import + execute 签名 + 危险模式扫描
    const validation = this.toolGenerator.validate(String(row.source_code));
    if (!validation.valid) {
      updateToolProposalStatus(id, "pending_review", `校验未通过: ${validation.errors.join("; ")}`);
      return { ok: false, message: `代码校验未通过：${validation.errors.join("; ")}` };
    }
    updateToolProposalStatus(id, "approved", "已通过静态校验，重启后由动态加载器纳入工具池");
    this.emit("toolProposal:approved", { id });
    logger.info({ id }, "P1-2: tool proposal approved");
    return { ok: true, message: "提案已批准（通过静态校验）。重启服务后由动态加载器纳入工具池。" };
  }

  /** P1-2: 拒绝工具提案。 */
  rejectToolProposal(id: string, reason?: string): { ok: boolean; message: string } {
    const row = getToolProposal(id);
    if (!row) return { ok: false, message: "提案不存在" };
    updateToolProposalStatus(id, "rejected", reason ?? "人工拒绝");
    this.emit("toolProposal:rejected", { id });
    return { ok: true, message: "提案已拒绝" };
  }

  // ─── P1-3: 分阶段激活孤岛模块 ─────────────────

  /**
   * P1-3: 按 STAGE 激活自进化模块（0=关/1=检测/2=+生成/3=+自主）。
   * 启动时由 context.ts 根据 SUPER_AGENT_EVOLUTION_STAGE 调用。
   */
  async activateEvolutionStage(stage: number): Promise<{ activated: string[]; skipped: string[] }> {
    const result = await this.activationManager.activateStage(stage);
    logger.info({ stage, activated: result.activated }, "P1-3: evolution modules activated by stage");
    return result;
  }

  /** P1-3: 获取激活状态（供路由/前端展示）。 */
  getActivationStatus() {
    return this.activationManager.getStatus();
  }

  // ─── P1-2 私有辅助 ──────────────────────────

  /** 从缺口派生一个合法的工具名（snake_case）。 */
  private deriveToolName(gap: CapabilityGap): string {
    const base = gap.id.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    return `auto_${base}`;
  }

  /** GapCategory → ToolRequirement.category 的启发式映射。 */
  private mapGapCategory(cat: CapabilityGap["category"]): ToolRequirement["category"] {
    switch (cat) {
      case "integration_missing": return "web";
      case "knowledge_gap": return "data";
      default: return "system";
    }
  }

  /** 从 LLM 回复中提取 execute 函数体（剥离 markdown 代码围栏）。 */
  private extractExecuteBody(content: string): string {
    const fence = content.match(/```(?:ts|typescript|js)?\n([\s\S]*?)```/);
    return (fence ? fence[1] : content).trim();
  }

  /** 落地候选工具文件到 evolution-generated 目录（不注册不加载，容错）。 */
  private async writeProposalFile(filePath: string, code: string): Promise<void> {
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const rel = filePath.replace(/^\.\//, "");
      const abs = path.join(process.cwd(), rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, code, "utf-8");
    } catch (err) {
      logger.debug({ err, filePath }, "P1-2: writeProposalFile skipped (non-fatal)");
    }
  }

  /**
   * P4-T1d: 为 proposal-applier 模块提供的上下文适配器
   */
  private get _applierContext(): ApplierContext {
    return {
      proposals: this.proposals,
      skillsDir: this.skillsDir,
      budget: this.budget,
      evoLock: this.evoLock,
      sandbox: this.sandbox,
      selfModification: this.selfModification,
      validateProposal: (p) => this.validateProposal(p),
      emit: (event, data) => this.emit(event, data),
      takeSnapshot: () => this.takeSnapshot(),
      incrementAppliedCount: () => {
        this._proposalsAppliedSinceSnapshot++;
        return this._proposalsAppliedSinceSnapshot;
      },
      AUTO_SNAPSHOT_INTERVAL: EvolutionEngine.AUTO_SNAPSHOT_INTERVAL,
    };
  }

  // ─── Interaction Recording ──────────────────────────────────

  /** Record an interaction case for evolution tracking */
  recordInteraction(data: {
    agentId: string;
    sessionId: string;
    userMessage: string;
    agentResponse: string;
    toolCalls?: string[];
    success?: boolean;
    score?: number;
    failureReason?: string;
    failureCategory?: InteractionCase["failureCategory"];
    /** T2.4：来源/反思详情等额外信息（metadata.source="reflection" 用于去重） */
    metadata?: Record<string, unknown>;
    /** Task 4.5: 关联的工作流 ID */
    workflowId?: string;
  }): InteractionCase {
    const interactionCase: InteractionCase = {
      id: `case_${uuid().slice(0, 8)}`,
      agentId: data.agentId,
      sessionId: data.sessionId,
      userMessage: data.userMessage,
      agentResponse: data.agentResponse,
      toolCalls: data.toolCalls ?? [],
      success: data.success ?? true,
      score: data.score,
      failureReason: data.failureReason,
      failureCategory: data.failureCategory,
      timestamp: new Date(),
      ...(data.metadata ? { metadata: data.metadata } : {}),
      ...(data.workflowId ? { workflowId: data.workflowId } : {}),
    };

    this.cases.addCase(interactionCase);

    // Check nudge triggers
    const { shouldReviewMemory } = this.nudge.recordTurn();
    const { shouldReviewSkills } = data.toolCalls?.length
      ? this.nudge.recordToolIteration()
      : { shouldReviewSkills: false };

    if (shouldReviewMemory || shouldReviewSkills) {
      this.emit("nudge:triggered", {
        memory: shouldReviewMemory,
        skills: shouldReviewSkills,
        agentId: data.agentId,
      });
      logger.info({ agentId: data.agentId, memory: shouldReviewMemory, skills: shouldReviewSkills },
        "Nudge triggered");
    }

    if (!interactionCase.success) {
      this.emit("case:failure", interactionCase);

      // Task 1.5: 级联故障检测
      const cascadeResult = this.cascadeDetector.check(this.cases.getFailureCases());
      if (cascadeResult.detected) {
        this.emit("cascade:detected", {
          signature: cascadeResult.signature,
          confidence: cascadeResult.confidence,
          involvedCases: cascadeResult.involvedCaseIds,
          recommendation: cascadeResult.recommendation,
          agentId: data.agentId,
        });
        logger.warn({
          agentId: data.agentId,
          signature: cascadeResult.signature?.id,
          confidence: cascadeResult.confidence,
        }, "Cascade failure detected during interaction recording");
      }

      // C-1: 自动失败分析（积累到阈值时触发，1小时冷却期）
      const failures = this.cases.getFailureCases();
      const now = Date.now();
      if (failures.length >= EvolutionEngine.AUTO_ANALYZE_THRESHOLD
          && now - this._lastAutoAnalyzeTime > EvolutionEngine.AUTO_ANALYZE_COOLDOWN_MS) {
        this._lastAutoAnalyzeTime = now;
        // 异步执行，不阻塞主流程
        this.analyzeFailures().catch(err =>
          logger.debug({ err }, "Auto failure analysis failed (non-fatal)")
        );
      }
    }

    // P1-1: 能力缺口检测（异步容错，不阻塞主流程）
    try {
      const newGaps = this.gapDetector.detect({
        agentId: data.agentId,
        sessionId: data.sessionId,
        agentResponse: data.agentResponse,
        // P1-1: data.toolCalls 是工具名数组，映射为检测器需要的对象格式
        // （整体 success 用 data.success 标志，单工具级成败详情此处不可得）
        toolCalls: (data.toolCalls ?? []).map((name) => ({
          name,
          success: data.success ?? true,
          ...(data.failureReason ? { error: data.failureReason } : {}),
        })),
      });
      if (newGaps.length > 0) {
        for (const gap of newGaps) {
          this.emit("gap:detected", gap);
          // P1-2: 缺口达阈值 → 尝试生成工具提案（Flag/STAGE 门控，异步容错）
          this.maybeProposeToolForGap(gap);
        }
        logger.info({ agentId: data.agentId, count: newGaps.length }, "P1-1: capability gaps detected");
      }
    } catch (err) {
      logger.debug({ err }, "P1-1: gap detection failed (non-fatal)");
    }

    return interactionCase;
  }

  // ─── Skill Evolution (MemSkill-style) ──────────────────────

  /**
   * Trigger evolution analysis using the EvolutionCoordinator.
   * Phase 6 (P0-1 修复): 优先走 Coordinator 算子体系，
   * 无可用算子时降级走老 LLM 直接分析路径。
   */
  async analyzeFailures(analyzerAgentId?: string): Promise<SkillProposal[]> {
    // T2.4 v1.3 防双触发：过滤掉已被在线 reflection 处理过的 case，
    //            避免「在线反思 + 离线 Nudge」对同一失败重复生成技能提案。
    const failures = this.cases.getFailureCases().filter(
      (c) => (c.metadata as Record<string, unknown> | undefined)?.source !== "reflection",
    );
    if (failures.length === 0) {
      logger.info("No failure cases to analyze");
      return [];
    }

    // P0-1 修复: 预算检查（与 triggerReview 对齐）
    const budgetCheck = this.budget.canStartCycle();
    if (budgetCheck.blocked) {
      logger.info({ reason: budgetCheck.reason }, "Failure analysis blocked by budget");
      return [];
    }
    this.budget.startCycle();

    const agentId = analyzerAgentId ?? this.getFirstAgentId();
    if (!agentId) {
      logger.warn("No agent available for evolution analysis");
      this.budget.skipCycle();
      return [];
    }

    // P0-1 修复: 优先尝试 Coordinator 算子体系
    try {
      // P2-1: 渐进自动化 — 检查是否需要用户确认
      const needsConfirmation = this.progressiveAutomation.requiresConfirmation(
        `进化分析：${failures.length} 个失败案例`,
        agentId,
      );
      if (needsConfirmation) {
        logger.debug({ agentId, failureCount: failures.length },
          "Evolution analysis requires confirmation (automation level too low)");
      }

      const allCases = this.cases.getAllCases();
      const cycleOutput = await this.coordinator.runCycle({
        failureCases: failures,
        allCases,
        agentManager: this.agentManager,
        agentId,
      });

      // P2-1: 记录自动化操作结果
      this.progressiveAutomation.recordAction({
        agentId,
        type: "evolution:analyze",
        description: `进化分析：${failures.length} 个失败案例 → ${cycleOutput.proposals.length} 个提案`,
        success: cycleOutput.proposals.length > 0 || cycleOutput.hotfixApplied,
      });

      // 如果算子生成了提案，直接使用
      if (cycleOutput.proposals.length > 0) {
        for (const p of cycleOutput.proposals) {
          this.proposals.set(p.id, p);
        }
        this.pruneProposals();

        this.emit("evolution:analyzed", {
          proposals: cycleOutput.proposals,
          failureCount: failures.length,
          errorMatch: cycleOutput.errorMatch,
          hotfixApplied: cycleOutput.hotfixApplied,
          skippedOperators: cycleOutput.skippedOperators,
          source: "coordinator",
        });

        logger.info({
          proposals: cycleOutput.proposals.length,
          failures: failures.length,
          hotfixApplied: cycleOutput.hotfixApplied,
          skippedOperators: cycleOutput.skippedOperators,
        }, "Evolution analysis complete via Coordinator");

        this.budget.endCycle();
        return cycleOutput.proposals;
      }

      // 算子无提案，但触发了热修复——也算成功
      if (cycleOutput.hotfixApplied) {
        this.emit("evolution:analyzed", {
          proposals: [],
          failureCount: failures.length,
          errorMatch: cycleOutput.errorMatch,
          hotfixApplied: true,
          source: "coordinator",
        });
        this.budget.endCycle();
        return [];
      }

      // Coordinator 无可用算子 → 降级到老 LLM 路径
      logger.info({ skippedOperators: cycleOutput.skippedOperators },
        "Coordinator returned no proposals, fallback to direct LLM analysis");
    } catch (coordErr: any) {
      // Coordinator 执行失败，降级到老路径
      logger.warn({ err: coordErr.message }, "Coordinator cycle failed, fallback to direct LLM analysis");
    }

    // ── 降级兜底：纯 LLM 直接分析路径（不走 Agent，避免 system prompt/工具污染）──
    try {
      const llmConfig = this.resolveAnalyzerLlmConfig();
      if (!llmConfig) {
        logger.warn("No LLM config available for evolution analysis");
        this.budget.skipCycle();
        return [];
      }

      // 记录一次 LLM 调用
      const llmCheck = this.budget.recordLlmCall();
      if (llmCheck.blocked) {
        logger.info({ reason: llmCheck.reason }, "LLM call blocked by budget");
        this.budget.skipCycle();
        return [];
      }

      // Build analysis prompt
      const casesText = failures.slice(0, 20).map((c, i) => {
        return `### Case ${i + 1} [${c.id}]\n- Agent: ${c.agentId}\n- User: ${c.userMessage.slice(0, 200)}\n- Response: ${c.agentResponse.slice(0, 200)}\n- Tools used: ${c.toolCalls.join(", ") || "none"}\n- Failure: ${c.failureReason ?? "unknown"}\n- Category: ${c.failureCategory ?? "other"}`;
      }).join("\n\n");

      const prompt = ANALYSIS_PROMPT
        .replace("{{count}}", String(failures.length))
        .replace("{{cases}}", casesText);

      // 纯 LLM 调用：不经过 Agent 的 system prompt、工具、对话历史
      const llm = new LLMProvider(llmConfig);
      const llmResponse = await llm.complete({ messages: [{ role: "user", content: prompt }] });
      const response = llmResponse.content ?? "";

      // Parse proposals from LLM response
      const proposals = this.parseProposals(response, failures);
      for (const p of proposals) {
        this.proposals.set(p.id, p);
      }
      this.pruneProposals(); // C-4: 淘汰超限提案

      this.emit("evolution:analyzed", { proposals, failureCount: failures.length, source: "legacy" });
      logger.info({ proposals: proposals.length, failures: failures.length }, "Evolution analysis complete (legacy path)");
      this.budget.endCycle();
      return proposals;
    } catch (err: any) {
      logger.error({ err: err.message }, "Evolution analysis failed");
      this.budget.skipCycle();
      return [];
    }
  }

  /**
   * Trigger a background review (Hermes-style nudge).
   * Phase B-1: 使用隔离的 Review Agent 执行（学 Hermes _spawn_background_review），
   * 避免 review prompt 污染主 agent 的对话历史。
   * P0-1 修复: 优先走 Coordinator 算子体系，无算子时降级到老 review agent.chat() 路径。
   */
  async triggerReview(agentId: string, options: {
    reviewMemory?: boolean;
    reviewSkills?: boolean;
    conversationContext?: string;
  }): Promise<{ memoryActions: number; skillProposals: SkillProposal[] }> {
    // Task 1.4: 预算检查——是否允许开始新进化周期
    const budgetCheck = this.budget.canStartCycle();
    if (budgetCheck.blocked) {
      logger.info({ reason: budgetCheck.reason }, "Evolution cycle blocked by budget");
      return { memoryActions: 0, skillProposals: [] };
    }
    this.budget.startCycle();

    // 记录一次 LLM 调用（review agent chat）
    const llmCheck = this.budget.recordLlmCall();
    if (llmCheck.blocked) {
      logger.info({ reason: llmCheck.reason }, "LLM call blocked by budget");
      this.budget.skipCycle();
      return { memoryActions: 0, skillProposals: [] };
    }

    // P0-1 修复: 优先尝试 Coordinator 算子体系
    let coordinatorProposals: SkillProposal[] = [];
    try {
      const failures = this.cases.getFailureCases().filter(
        (c) => (c.metadata as Record<string, unknown> | undefined)?.source !== "reflection",
      );
      if (failures.length > 0 && options.reviewSkills) {
        // P2-1: 渐进自动化 — 检查是否需要用户确认
        const needsReviewConfirmation = this.progressiveAutomation.requiresConfirmation(
          `Review 审查：${failures.length} 个失败案例`,
          agentId,
        );
        if (needsReviewConfirmation) {
          logger.debug({ agentId, failureCount: failures.length },
            "Review requires confirmation (automation level too low)");
        }

        const allCases = this.cases.getAllCases();
        const cycleOutput = await this.coordinator.runCycle({
          failureCases: failures,
          allCases,
          agentManager: this.agentManager,
          agentId,
        });

        // P2-1: 记录自动化操作结果
        this.progressiveAutomation.recordAction({
          agentId,
          type: "evolution:review",
          description: `Review 审查：${failures.length} 个失败案例 → ${cycleOutput.proposals.length} 个提案`,
          success: cycleOutput.proposals.length > 0,
        });

        if (cycleOutput.proposals.length > 0) {
          for (const p of cycleOutput.proposals) {
            this.proposals.set(p.id, p);
          }
          this.pruneProposals();
          coordinatorProposals = cycleOutput.proposals;

          logger.info({
            proposals: coordinatorProposals.length,
            coordinatorProposals: coordinatorProposals.length,
            skippedOperators: cycleOutput.skippedOperators,
          }, "Review complete via Coordinator");

          // 如果 Coordinator 产生了提案，跳过老 LLM review 路径
          this.emit("review:complete", { agentId, memoryActions: 0, proposals: coordinatorProposals });
          this.budget.endCycle();
          return { memoryActions: 0, skillProposals: coordinatorProposals };
        }
      }
    } catch (coordErr: any) {
      // Coordinator 执行失败，降级到老路径
      logger.warn({ err: coordErr.message }, "Coordinator review failed, fallback to legacy review");
    }

    // ── 降级兜底：纯 LLM review（不走 Agent，避免 system prompt/工具/reflection 污染）──
    const llmConfig = this.resolveAnalyzerLlmConfig();
    if (!llmConfig) {
      logger.warn("No LLM config available for review");
      this.budget.skipCycle();
      return { memoryActions: 0, skillProposals: [] };
    }

    let prompt: string;
    if (options.reviewMemory && options.reviewSkills) {
      prompt = COMBINED_REVIEW_PROMPT;
    } else if (options.reviewSkills) {
      prompt = SKILL_REVIEW_PROMPT;
    } else {
      prompt = MEMORY_REVIEW_PROMPT;
    }

    if (options.conversationContext) {
      prompt = `Recent conversation:\n${options.conversationContext}\n\n${prompt}`;
    }

    try {
      // 纯 LLM 调用：不经过 Agent 的 system prompt、工具、对话历史、reflection
      const llm = new LLMProvider(llmConfig);
      const llmResponse = await llm.complete({ messages: [{ role: "user", content: prompt }] });
      const response = llmResponse.content ?? "";

      const proposals: SkillProposal[] = [];
      let memoryActions = 0;

      // Try to parse skill proposals from response
      if (options.reviewSkills) {
        try {
          // P2-T11: brace counting 替代贪婪正则，精确提取第一个完整 JSON 对象
          const jsonStr = extractFirstJsonObject(response);
          if (jsonStr) {
            const parsed = safeJsonParseAny(jsonStr, "engine-review-skills");
            if (parsed && typeof parsed === "object") {
              const data = parsed as Record<string, unknown>;
              if (data.action && data.action !== "no_change") {
                const proposal: SkillProposal = {
                  id: `prop_${uuid().slice(0, 8)}`,
                  action: data.action as SkillProposal["action"],
                  skillName: (data.skillName as string) ?? "unnamed_skill",
                  description: (data.description as string) ?? "",
                  content: (data.content as string) ?? "",
                  reasoning: (data.reasoning as string) ?? "",
                  basedOnCases: [],
                  status: "pending",
                  createdAt: new Date(),
                  // Phase B-3: 解析 patch 操作
                  patchOperations: data.patchOperations as SkillProposal["patchOperations"],
                  // Task 1.2: 三层技能库类型
                  skillType: data.skillType as SkillProposal["skillType"],
                };
                proposals.push(proposal);
                this.proposals.set(proposal.id, proposal);
              }
            }
          }
        } catch {
          // Response wasn't JSON, that's ok — might be "Nothing to save."
          logger.debug("LLM response was not valid JSON during review, treating as non-actionable");
        }
        this.pruneProposals(); // C-4: 淘汰超限提案
      }

      if (options.reviewMemory && !response.toLowerCase().includes("nothing to save")) {
        memoryActions = 1; // Assume at least one memory action was taken
      }

      this.emit("review:complete", { agentId, memoryActions, proposals });
      // Task 1.4: 正常结束周期
      this.budget.endCycle();
      return { memoryActions, skillProposals: proposals };
    } catch (err: any) {
      logger.error({ err: err.message }, "Review LLM call failed");
      this.budget.skipCycle();
      return { memoryActions: 0, skillProposals: [] };
    }
  }

  // ─── Session Flush (Phase A-2, 学 Hermes gateway/run.py:767-800) ────

  /**
   * 会话结束前记忆 Flush。
   * 在上下文即将丢失前给 agent 一次保存记忆/技能的机会。
   * 参考 Hermes gateway/run.py:767-800 的 pre-reset flush 模式。
   */
  async flushBeforeReset(agentId: string, options: {
    conversationMessages: Array<{ role: string; content: string }>;
    currentMemoryState?: string; // 当前记忆快照（防覆盖）
  }): Promise<{ memoryActions: number; skillProposals: SkillProposal[] }> {
    const totalTurns = this.nudge.getStats().totalTurns;
    const minTurns = this.nudge.getConfig().flushMinTurns;

    // 最小轮数检查（学 Hermes flush_min_turns）
    if (minTurns > 0 && totalTurns < minTurns) {
      logger.debug({ totalTurns, minTurns }, "Flush skipped: not enough turns");
      return { memoryActions: 0, skillProposals: [] };
    }

    // 构建 flush prompt（学 Hermes gateway flush_prompt）
    let flushPrompt = `[System: This session is about to be reset. The conversation context will be cleared after this turn.

Review the conversation above and:
1. Save any important facts, preferences, or decisions to memory that would be useful in future sessions.
2. If you discovered a reusable workflow or solved a non-trivial problem, consider saving it as a skill.
3. If nothing is worth saving, that's fine \u2014 just skip.

`;

    // 注入当前记忆状态（防覆盖，学 Hermes run.py:780-789）
    if (options.currentMemoryState) {
      // P2-T17: 对 currentMemoryState 进行 prompt 注入扫描
      // currentMemoryState 可能来自 LLM 输出，含恶意注入内容
      const scanResult = scanMemoryContent(options.currentMemoryState);
      if (!scanResult.safe) {
        logger.warn({
          findings: scanResult.findings,
          threatCount: scanResult.threats.length,
        }, "Current memory state contains injection threats, sanitizing before flush");
        // 降级：使用 sanitized version（移除 XML fence-breaking tags）
        options.currentMemoryState = sanitizeMemoryContent(options.currentMemoryState);
      }

      flushPrompt += `IMPORTANT \u2014 here is the current live state of memory. Do NOT overwrite or remove entries unless the conversation above reveals something that genuinely supersedes them. Only add new information.
${options.currentMemoryState}

`;
    }

    flushPrompt += `Do NOT respond to the user. Just use memory and skill tools if needed, then stop.]`;

    // 以最近对话为上下文触发 review
    const context = options.conversationMessages
      .slice(-20)
      .map(m => `${m.role}: ${getContentText(m.content).slice(0, 300)}`)
      .join("\n");

    try {
      const result = await this.triggerReview(agentId, {
        reviewMemory: true,
        reviewSkills: true,
        conversationContext: `${context}\n\n${flushPrompt}`,
      });

      this.emit("flush:complete", { agentId, ...result });
      // C-3: flush 完成后也创建快照（记录会话周期的进化状态）
      this.takeSnapshot();
      logger.info({ agentId, memoryActions: result.memoryActions, proposals: result.skillProposals.length },
        "Session flush completed");
      return result;
    } catch (err: any) {
      logger.warn({ agentId, err: err.message }, "Session flush failed (non-fatal)");
      return { memoryActions: 0, skillProposals: [] };
    }
  }

  // ─── Proposal Management ──────────────────────────────────

  /** Get all proposals */
  getProposals(filter?: { status?: SkillProposal["status"] }): SkillProposal[] {
    const all = Array.from(this.proposals.values());
    if (filter?.status) return all.filter((p) => p.status === filter.status);
    return all;
  }

  /**
   * Approve a proposal (auto-applies if autoApplySkills is enabled).
   *
   * 如果提案包含 targetCode（源码级修改），自动路由到
   * applyCodeProposal() 走完整的沙箱验证 + 人工审核闸门链路。
   */
  async approveProposal(proposalId: string): Promise<SkillProposal | null> {
    const p = this.proposals.get(proposalId);
    if (!p) return null;
    p.status = "approved";
    this.emit("proposal:approved", p);

    // Auto-apply if enabled
    if (this.nudge.getConfig().autoApplySkills) {
      // 源码级提案走代码修改链路（沙箱 + 人工审核）
      if (p.targetCode) {
        return this.applyCodeProposal(proposalId);
      }
      return this.applyProposal(proposalId);
    }
    return p;
  }

  /** Reject a proposal */
  rejectProposal(proposalId: string): SkillProposal | null {
    const p = this.proposals.get(proposalId);
    if (!p) return null;
    p.status = "rejected";
    this.emit("proposal:rejected", p);
    return p;
  }

  /**
   * Apply a proposal — writes the skill content as a .md file to skillsDir
   * and marks the proposal as "applied".
   * Phase B-3: 支持 patch 模式增量修改（学 Hermes _patch_skill）。
   * Spec v3 Task 8: 应用前验证（安全扫描 + 完整性检查）。
   *
   * 如果提案包含 targetCode，委托到 applyCodeProposal() 走
   * 沙箱验证 + 自修改引擎 + 人工审核闸门链路。
   */
  async applyProposal(proposalId: string): Promise<SkillProposal | null> {
    return applyProposalImpl(proposalId, this._applierContext);
  }

  /** Mark a proposal as applied (alias for applyProposal — actually deploys) */
  async markApplied(proposalId: string): Promise<SkillProposal | null> {
    return this.applyProposal(proposalId);
  }

  /**
   * Task 3.1: 应用代码级提案（对标 Gödel action_adjust_logic）
   *
   * 不是写入 .md 技能文件，而是直接修改 TypeScript 源码。
   * 需要 targetCode 字段、沙箱验证、进化锁保护。
   *
   * 安全流程（审查修正版）：
   *   scanContent（语法安全扫描）→ adjustLogic（写入+快照）→
   *   verifyCompile（单文件 tsc 编译验证）→ 失败自动 rollback
   */
  async applyCodeProposal(proposalId: string): Promise<SkillProposal | null> {
    return applyCodeProposalImpl(proposalId, this._applierContext);
  }

  /**
   * Task 3.1: 让 LLM 在生成提案前先读取目标源码（对标 Gödel action_read_logic）
   */
  readCodeProposal(modulePath: string, targetName?: string): string {
    return this.selfModification.readLogic(modulePath, targetName);
  }

  /**
   * Task 3.5: 人工审核通过代码级提案
   */
  approveCodeProposal(proposalId: string): SkillProposal | null {
    const p = this.proposals.get(proposalId);
    if (!p?.targetCode) return null;
    p.requiresHumanReview = false;
    p.status = "approved";
    this.emit("proposal:code_approved", p);
    logger.info({ proposalId }, "Code proposal approved by human review");
    return p;
  }

  // ─── Skill Effectiveness Tracking (Task 2.4) ───────────────

  /**
   * 追踪提案应用前后的效果对比。
   * key = proposalId，value = 应用前后的成功率。
   */
  private _proposalEffectiveness = new Map<string, { beforeSuccessRate: number; afterSuccessRate: number }>();

  /**
   * 递归验证闭环（借鉴 SkillRL 的 enable_dynamic_update）
   *
   * 比较提案应用前后同类 case 的成功率变化。
   * 成功率下降超过阈值 → 触发技能更新。
   */
  async checkSkillEffectiveness(proposalId: string, updateThreshold: number = 0.4): Promise<{
    degraded: boolean;
    beforeRate: number;
    afterRate: number;
    delta: number;
  }> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== "applied") {
      return { degraded: false, beforeRate: 0, afterRate: 0, delta: 0 };
    }

    // 获取相同技能名的所有相关 case
    const allCases = this.cases.getAllCases();
    const now = Date.now();
    const appliedAt = proposal.createdAt.getTime();

    // 应用前的 case（同类 failureCategory）
    const beforeCases = allCases.filter(
      (c) => c.timestamp.getTime() < appliedAt
    );
    // 应用后的 case
    const afterCases = allCases.filter(
      (c) => c.timestamp.getTime() >= appliedAt
    );

    const beforeRate = beforeCases.length > 0
      ? beforeCases.filter((c) => c.success).length / beforeCases.length
      : 1;
    const afterRate = afterCases.length > 0
      ? afterCases.filter((c) => c.success).length / afterCases.length
      : beforeRate;

    const delta = afterRate - beforeRate;
    const degraded = delta < -updateThreshold;

    // 存储效果数据
    this._proposalEffectiveness.set(proposalId, {
      beforeSuccessRate: beforeRate,
      afterSuccessRate: afterRate,
    });

    if (degraded) {
      logger.warn({
        proposalId,
        beforeRate: beforeRate.toFixed(2),
        afterRate: afterRate.toFixed(2),
        delta: delta.toFixed(2),
      }, "Skill effectiveness degraded — may need rollback or re-evolution");

      this.emit("skill:degraded", {
        proposalId,
        skillName: proposal.skillName,
        beforeRate,
        afterRate,
        delta,
      });
    }

    return { degraded, beforeRate, afterRate, delta };
  }

  /**
   * 获取所有已追踪的提案效果数据
   */
  getProposalEffectiveness(): Map<string, { beforeSuccessRate: number; afterSuccessRate: number }> {
    return new Map(this._proposalEffectiveness);
  }

  // ─── Proposal Validation (Spec v3 Task 8) ─────────────────
  // P4-T1b: 核心逻辑已提取到 proposal-validator.ts，类方法保留为薄包装

  /**
   * 应用前验证 — 检查提案内容的完整性和安全性
   */
  private validateProposal(proposal: SkillProposal): { valid: boolean; errors: string[]; scanVerdict?: string } {
    return validateProposalImpl(proposal, this.riskEngine, (event, data) => this.emit(event, data));
  }

  /**
   * 计算提案质量评分 (Spec v3 Task 8)
   */
  scoreProposal(proposal: SkillProposal): number {
    return scoreProposalImpl(proposal);
  }

  // ─── Snapshots ─────────────────────────────────────────────

  /** Take a snapshot of current evolution state */
  takeSnapshot(label?: string): EvolutionSnapshot {
    const caseStats = this.cases.getStats();
    const snapshot: EvolutionSnapshot = {
      id: `snap_${uuid().slice(0, 8)}`,
      label: label || `Snapshot #${this.snapshots.length + 1}`,
      stageIndex: this.snapshots.length,
      avgScore: caseStats.successRate,
      totalCases: caseStats.total,
      failureCases: caseStats.failures,
      skillProposals: this.getProposals(),
      timestamp: new Date(),
    };

    this.snapshots.push(snapshot);
    this.pruneSnapshots(); // C-4: 淘汰超限快照

    // Track best
    if (this.bestSnapshotIdx < 0 || snapshot.avgScore > this.snapshots[this.bestSnapshotIdx].avgScore) {
      this.bestSnapshotIdx = this.snapshots.length - 1;
      logger.info({ snapshotId: snapshot.id, score: snapshot.avgScore }, "New best evolution snapshot");
    }

    this.emit("snapshot:created", snapshot);
    // P4-T1 审查修正: 快照后重置计数器，防止每个后续提案都触发快照
    this._proposalsAppliedSinceSnapshot = 0;
    return snapshot;
  }

  /** Get evolution snapshots */
  getSnapshots(): EvolutionSnapshot[] {
    return [...this.snapshots];
  }

  /** Get the best snapshot */
  getBestSnapshot(): EvolutionSnapshot | null {
    return this.bestSnapshotIdx >= 0 ? this.snapshots[this.bestSnapshotIdx] : null;
  }

  /** Delete a snapshot by id */
  deleteSnapshot(snapshotId: string): boolean {
    const idx = this.snapshots.findIndex(s => s.id === snapshotId);
    if (idx < 0) return false;
    this.snapshots.splice(idx, 1);
    // 重新计算 bestSnapshotIdx
    if (this.snapshots.length === 0) {
      this.bestSnapshotIdx = -1;
    } else {
      this.bestSnapshotIdx = this.snapshots.reduce((best, s, i) =>
        s.avgScore > this.snapshots[best].avgScore ? i : best, 0);
    }
    this.emit("snapshot:deleted", { id: snapshotId });
    return true;
  }

  // ─── Stats ─────────────────────────────────────────────────

  getStats(): EvolutionStats {
    const caseStats = this.cases.getStats();
    const nudgeStats = this.nudge.getStats();
    const proposals = Array.from(this.proposals.values());

    return {
      totalInteractions: caseStats.total,
      failedInteractions: caseStats.failures,
      successRate: caseStats.successRate,
      totalProposals: proposals.length,
      appliedProposals: proposals.filter((p) => p.status === "applied").length,
      pendingProposals: proposals.filter((p) => p.status === "pending").length,
      totalSnapshots: this.snapshots.length,
      bestScore: this.bestSnapshotIdx >= 0 ? this.snapshots[this.bestSnapshotIdx].avgScore : 0,
      nudges: { memory: nudgeStats.memoryNudges, skill: nudgeStats.skillNudges },
    };
  }

  // ─── Capacity Management (C-4) ─────────────────────────

  /** proposals Map LRU 淘汰：超限时按 createdAt 淘汰最旧的 pending/rejected 提案 */
  private pruneProposals(): void {
    if (this.proposals.size <= EvolutionEngine.MAX_PROPOSALS) return;
    const entries = Array.from(this.proposals.entries())
      .sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime());
    const toRemove = this.proposals.size - EvolutionEngine.MAX_PROPOSALS;
    let removed = 0;
    for (const [id, p] of entries) {
      if (removed >= toRemove) break;
      // 保留 applied 提案，优先淘汰 pending/rejected
      if (p.status !== "applied") {
        this.proposals.delete(id);
        removed++;
      }
    }
    // 仍超限则强制淘汰最旧的
    if (this.proposals.size > EvolutionEngine.MAX_PROPOSALS) {
      for (const [id] of entries) {
        if (this.proposals.size <= EvolutionEngine.MAX_PROPOSALS) break;
        this.proposals.delete(id);
      }
    }
  }

  /** snapshots 数组容量限制：保留最新的 + best，删除最旧的 */
  private pruneSnapshots(): void {
    if (this.snapshots.length <= EvolutionEngine.MAX_SNAPSHOTS) return;
    const excess = this.snapshots.length - EvolutionEngine.MAX_SNAPSHOTS;
    // 保护 best snapshot 索引
    const bestId = this.bestSnapshotIdx >= 0 ? this.snapshots[this.bestSnapshotIdx]?.id : null;
    this.snapshots.splice(0, excess);
    // 重新定位 best
    if (bestId) {
      this.bestSnapshotIdx = this.snapshots.findIndex((s) => s.id === bestId);
    }
  }

  // ─── Workflow Evolution (Task 4.5) ──────────────────────────

  /**
   * 记录工作流执行失败，触发工作流级进化分析。
   *
   * 当工作流中某个步骤失败时调用此方法。
   * 系统会自动分析失败步骤的根因，并生成工作流 patch 提案。
   */
  async recordWorkflowFailure(
    workflowId: string,
    agentId: string,
    sessionId: string,
    failedStepIndex: number,
    error: string,
  ): Promise<void> {
    const workflow = this.workflowEngine.getWorkflow(workflowId);
    if (!workflow) {
      logger.warn({ workflowId }, "Workflow not found for failure recording");
      return;
    }

    // 记录为失败 case（标记 workflowId）
    const failedStep = workflow.steps[failedStepIndex];
    this.recordInteraction({
      agentId,
      sessionId,
      userMessage: `[Workflow] ${workflow.name}`,
      agentResponse: `工作流步骤 ${failedStepIndex + 1}（${failedStep?.tool ?? "unknown"}）执行失败`,
      toolCalls: [failedStep?.tool ?? "unknown"],
      success: false,
      failureReason: error,
      failureCategory: "wrong_tool",
      workflowId,
    });

    logger.info({
      workflowId,
      workflowName: workflow.name,
      failedStepIndex,
      tool: failedStep?.tool,
    }, "Workflow failure recorded for evolution analysis");
  }

  /**
   * 分析工作流失败并生成改进提案。
   *
   * 三算子可对工作流定义执行 patch 操作：
   * - Revision: 替换失败步骤为替代方案
   * - Recombination: 混合不同工作流的成功步骤
   * - Refinement: 增量调整参数/重试次数
   */
  async analyzeWorkflow(
    workflowId: string,
    analyzerAgentId?: string,
  ): Promise<SkillProposal[]> {
    const workflow = this.workflowEngine.getWorkflow(workflowId);
    if (!workflow) return [];

    // 获取所有与此工作流相关的失败 case
    const relatedCases = this.cases.getAllCases().filter(
      c => c.workflowId === workflowId && !c.success,
    );
    if (relatedCases.length === 0) return [];

    // 构建工作流分析 prompt
    const casesText = relatedCases.slice(0, 10).map((c, i) =>
      `### Failure ${i + 1}
- Step: ${c.toolCalls.join(", ")}
- Error: ${c.failureReason ?? "unknown"}
- Time: ${c.timestamp.toISOString()}`
    ).join("\n\n");

    const workflowStepsText = workflow.steps.map((s, i) =>
      `${i + 1}. ${s.tool}: ${s.description}`
    ).join("\n");

    const prompt = `You are analyzing a workflow that has failed. Suggest improvements.

## Workflow
Name: ${workflow.name}
Description: ${workflow.description}
Steps:
${workflowStepsText}

## Failures (${relatedCases.length} cases)
${casesText}

## Instructions
1. Identify which step(s) are most problematic
2. Suggest concrete changes: adjust parameters, increase retries, replace tool, add fallback
3. Propose as a patch to the workflow definition

Respond in JSON:
{
  "analysis": "<root cause summary>",
  "proposals": [{
    "action": "patch",
    "skillName": "${workflow.name}",
    "description": "<what changed>",
    "content": "<updated workflow YAML>",
    "reasoning": "<why this helps>",
    "skillType": "task_specific"
  }]
}`;

    const agentId = analyzerAgentId ?? this.getFirstAgentId();
    if (!agentId) return [];

    const agent = this.agentManager.getAgent(agentId);
    if (!agent) return [];

    // 纯 LLM 直接分析路径（不走 Agent，避免 system prompt/工具污染）
    try {
      const llmConfig = this.resolveAnalyzerLlmConfig();
      if (!llmConfig) {
        logger.warn("No LLM config available for workflow analysis");
        return [];
      }

      const llm = new LLMProvider(llmConfig);
      const llmResponse = await llm.complete({ messages: [{ role: "user", content: prompt }] });
      const response = llmResponse.content ?? "";
      const proposals = this.parseProposals(response, relatedCases);

      // 标记提案与工作流相关
      for (const p of proposals) {
        (p as any)._workflowId = workflowId;
        this.proposals.set(p.id, p);
      }
      this.pruneProposals();

      this.emit("workflow:analyzed", { workflowId, proposals: proposals.length });
      logger.info({ workflowId, proposals: proposals.length }, "Workflow analysis complete");
      return proposals;
    } catch (err: any) {
      logger.error({ workflowId, err: err.message }, "Workflow analysis failed");
      return [];
    }
  }

  // ─── Phase 6 (Task 6.4): 策略缓存与行为进化 ── 委托给 StrategyLearner ──

  /** 从成功案例中学习高频策略并缓存。 */
  learnStrategy(params: {
    name: string;
    description: string;
    toolSequence: string[];
    paramTemplate?: Record<string, unknown>;
    triggerKeywords: string[];
    intentPattern?: string;
  }): void {
    this.strategyLearner.learnStrategy(params);
  }

  /** 查找匹配的高频策略。 */
  findStrategy(intent: string): StrategyCacheEntry | undefined {
    return this.strategyLearner.findStrategy(intent);
  }

  /** 根据历史案例优化工具调用顺序。 */
  optimizeToolOrder(targetIntent: string): Array<{
    recommendedOrder: string[];
    confidence: number;
    basedOnCases: number;
    reasoning: string;
  }> {
    return this.strategyLearner.optimizeToolOrder(targetIntent);
  }

  /** 更新工具调用模式统计。 */
  updateToolPatternStats(
    toolName: string,
    success: boolean,
    duration: number,
    params?: Record<string, unknown>,
    context?: string,
    predecessor?: string,
    successor?: string,
  ): void {
    this.strategyLearner.updateToolPatternStats(toolName, success, duration, params, context, predecessor, successor);
  }

  /** 获取工具的模式统计。 */
  getToolPatternStats(toolName: string): ToolPatternStats | undefined {
    return this.strategyLearner.getToolPatternStats(toolName);
  }

  /**
   * 记录用户对 Agent 回复的提示词反馈。
   * 反馈分析后若负面率高，emit prompt:negative_feedback_trend 事件。
   */
  recordPromptFeedback(params: {
    type: PromptFeedbackEntry["type"];
    agentResponse: string;
    userFeedback: string;
    templateName?: string;
  }): void {
    this.strategyLearner.recordPromptFeedback(params);

    // 负面反馈趋势检测（事件发射保留在 engine 侧）
    const analysis = this.strategyLearner.analyzePromptFeedback();
    if (analysis && analysis.negativeRatio >= 0.4) {
      this.emit("prompt:negative_feedback_trend", {
        negativeRatio: analysis.negativeRatio,
        topIssue: analysis.topIssue,
        totalRecent: analysis.totalRecent,
        suggestion: "考虑调整系统提示词以改善用户体验",
      });
    }
  }

  /** 获取策略缓存统计。 */
  getStrategyCacheStats(): {
    totalStrategies: number;
    mostUsed?: { name: string; useCount: number };
    totalUseCount: number;
  } {
    return this.strategyLearner.getStrategyCacheStats();
  }

  // ─── Helpers ───────────────────────────────────────────────

  // ─── 分析器 LLM 配置（Provider+Model 选择，不走 Agent）───

  /** 设置进化分析器 LLM（Provider ID + Model ID） */
  setAnalyzerLlm(providerId: string | null, modelId: string | null): void {
    this._analyzerProviderId = providerId;
    this._analyzerModelId = modelId;
    this.persistAnalyzerConfig();
  }

  /** 获取当前分析器 LLM 配置 */
  getAnalyzerLlm(): { providerId: string | null; modelId: string | null } {
    return { providerId: this._analyzerProviderId, modelId: this._analyzerModelId };
  }

  /**
   * 解析分析器 LLM 配置。
   * 优先级：用户配置的 provider+model > 首个 Agent 的 LLM 配置。
   */
  private resolveAnalyzerLlmConfig(): LLMProviderConfig | null {
    // 1. 用户配置了 provider+model：从 ProviderStore 获取 apiKey/baseUrl
    if (this._analyzerProviderId && this._analyzerModelId) {
      if (this.providerStore) {
        const record = this.providerStore.get(this._analyzerProviderId);
        if (record?.apiKey && record?.isEnabled !== false) {
          return {
            type: "custom",
            model: this._analyzerModelId,
            apiKey: record.apiKey,
            baseUrl: record.baseUrl,
            providerId: this._analyzerProviderId,
          };
        }
      }
      // ProviderStore 不可用或 apiKey 缺失 → 降级到 Agent 配置
      logger.warn({ providerId: this._analyzerProviderId },
        "Analyzer provider not available in ProviderStore, falling back to Agent LLM config");
    }

    // 2. 降级：使用第一个可用 Agent 的 LLM 配置（纯 LLM 调用，不走 Agent.chat()）
    const agents = this.agentManager.listAgents();
    if (agents.length === 0) return null;
    const firstAgent = this.agentManager.getAgent(agents[0].id);
    if (!firstAgent?.config?.llmProvider) return null;
    return firstAgent.config.llmProvider;
  }

  /** 持久化分析器 LLM 配置到 SQLite（独立 key） */
  private persistAnalyzerConfig(): void {
    import("../persistence/sqlite.js").then(({ saveConfigValue }) => {
      saveConfigValue("evolution.analyzerProviderId", this._analyzerProviderId ?? "");
      saveConfigValue("evolution.analyzerModelId", this._analyzerModelId ?? "");
    }).catch(() => { /* 持久化失败不影响运行时 */ });
  }

  /** 从 SQLite 恢复分析器 LLM 配置（兼容旧版 analyzerAgentId → 自动迁移） */
  async loadAnalyzerConfig(): Promise<void> {
    try {
      const { loadConfigValue } = await import("../persistence/sqlite.js");
      const savedProviderId = loadConfigValue("evolution.analyzerProviderId");
      const savedModelId = loadConfigValue("evolution.analyzerModelId");
      if (savedProviderId && savedProviderId.length > 0 && savedModelId && savedModelId.length > 0) {
        this._analyzerProviderId = savedProviderId;
        this._analyzerModelId = savedModelId;
        logger.info({ providerId: savedProviderId, modelId: savedModelId },
          "Analyzer LLM config restored from SQLite");
        return;
      }

      // 兼容旧版：尝试从 evolution.analyzerAgentId 迁移
      const savedAgentId = loadConfigValue("evolution.analyzerAgentId");
      if (savedAgentId && savedAgentId.length > 0) {
        const agent = this.agentManager.getAgent(savedAgentId);
        if (agent?.config?.llmProvider) {
          this._analyzerProviderId = agent.config.llmProvider.providerId ?? null;
          this._analyzerModelId = agent.config.llmProvider.model ?? null;
          this.persistAnalyzerConfig(); // 写入新 key
          logger.info({ oldAgentId: savedAgentId, providerId: this._analyzerProviderId, modelId: this._analyzerModelId },
            "Migrated analyzer config from AgentId to Provider+Model");
        }
      }
    } catch {
      /* 加载失败不影响引擎初始化 */
      logger.debug("Failed to load analyzer config from persistence, using defaults");
    }
  }

  /**
   * 获取第一个可用 Agent ID（Coordinator 算子执行降级用）。
   */
  private getFirstAgentId(): string | null {
    const agents = this.agentManager.listAgents();
    return agents.length > 0 ? agents[0].id : null;
  }

  // P4-T1c: 核心逻辑已提取到 proposal-parser.ts
  private parseProposals(response: string, cases: InteractionCase[]): SkillProposal[] {
    return parseProposalsImpl(response, cases);
  }
}
