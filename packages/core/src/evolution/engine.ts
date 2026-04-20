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
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentManager } from "../agent/manager.js";
import type { AgentRuntime } from "../agent/runtime.js";
import { scanSkill, shouldAllowInstall, type ScanResult } from "../skills/guard.js";
import { parseSkillFile } from "../skills/parser.js";
import { getContentText } from "../utils/content-helpers.js";

const logger = pino({ name: "evolution" });

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
// Nudge Tracker (Hermes-style)
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// Case Collector (MemSkill-style)
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// Review Prompts (Hermes-style)
// ═══════════════════════════════════════════════════════════════

const MEMORY_REVIEW_PROMPT = `Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has the user revealed things about themselves — persona, desires, preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?

If something stands out, save it using the memory tool. If nothing is worth saving, just say "Nothing to save." and stop.`;

const SKILL_REVIEW_PROMPT = `Review the conversation above and consider creating or updating a skill if appropriate.

Focus on: was a non-trivial approach used that required trial and error, or changing course due to findings along the way, or did the user expect a different method or outcome?

If a relevant skill already exists, suggest how to update it. Otherwise, propose a new skill if the approach is reusable.
If nothing is worth saving, just say "Nothing to save." and stop.

Respond in JSON format:
{
  "action": "create" | "update" | "no_change",
  "skillName": "<snake_case_name>",
  "description": "<what the skill does>",
  "content": "<markdown skill content>",
  "reasoning": "<why this skill is valuable>"
}`;

const COMBINED_REVIEW_PROMPT = `Review the conversation above and consider two things:

**Memory**: Has the user revealed personal preferences, working style, or expectations about your behavior? If so, save using the memory tool.

**Skills**: Was a non-trivial approach used that required trial and error, or did the user expect a different method? If so, propose a skill.

Only act if there's something genuinely worth saving. If nothing stands out, say "Nothing to save." and stop.`;

// ═══════════════════════════════════════════════════════════════
// Evolution Analysis Prompts (MemSkill-style)
// ═══════════════════════════════════════════════════════════════

const ANALYSIS_PROMPT = `You are an expert analyst for an AI Agent system. Analyze the failure cases below to identify why the agent failed and how its skills should evolve.

## Failure Categories
- **skill_gap**: The agent lacks a skill/technique needed for this task
- **wrong_tool**: The agent used the wrong tool or approach
- **bad_response**: The agent's response quality was poor
- **timeout**: The agent ran out of iterations
- **other**: Miscellaneous failures

## Failure Cases ({{count}} cases)
{{cases}}

## Analysis Instructions
1. Group failures into patterns by root cause
2. For each pattern, identify if a new skill would help or an existing skill needs improvement
3. Propose concrete, actionable skill changes

Respond in JSON:
{
  "patterns": [
    {
      "name": "<pattern name>",
      "cases": [<case IDs>],
      "rootCause": "<skill_gap|wrong_tool|bad_response|timeout|other>",
      "explanation": "<why this pattern occurs>",
      "proposedFix": "<what skill change would help>"
    }
  ],
  "proposals": [
    {
      "action": "create" | "update",
      "skillName": "<name>",
      "description": "<what the skill does>",
      "content": "<skill content in markdown>",
      "reasoning": "<how this addresses the failures>"
    }
  ],
  "summary": "<1-2 sentence summary>"
}`;

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

  constructor(agentManager: AgentManager, nudgeConfig?: Partial<NudgeConfig>, skillsDir = "./skills") {
    super();
    this.agentManager = agentManager;
    this.skillsDir = skillsDir;
    this.nudge = new NudgeTracker(nudgeConfig);
    this.cases = new CaseCollector();
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

    return interactionCase;
  }

  // ─── Skill Evolution (MemSkill-style) ──────────────────────

  /** Trigger evolution analysis using an LLM agent */
  async analyzeFailures(analyzerAgentId?: string): Promise<SkillProposal[]> {
    const failures = this.cases.getFailureCases();
    if (failures.length === 0) {
      logger.info("No failure cases to analyze");
      return [];
    }

    // Build analysis prompt
    const casesText = failures.slice(0, 20).map((c, i) => {
      return `### Case ${i + 1} [${c.id}]
- Agent: ${c.agentId}
- User: ${c.userMessage.slice(0, 200)}
- Response: ${c.agentResponse.slice(0, 200)}
- Tools used: ${c.toolCalls.join(", ") || "none"}
- Failure: ${c.failureReason ?? "unknown"}
- Category: ${c.failureCategory ?? "other"}`;
    }).join("\n\n");

    const prompt = ANALYSIS_PROMPT
      .replace("{{count}}", String(failures.length))
      .replace("{{cases}}", casesText);

    // Use an existing agent or the first available one for analysis
    const agentId = analyzerAgentId ?? this.getFirstAgentId();
    if (!agentId) {
      logger.warn("No agent available for evolution analysis");
      return [];
    }

    const agent = this.agentManager.getAgent(agentId);
    if (!agent) {
      logger.warn({ agentId }, "Analyzer agent not found");
      return [];
    }

    try {
      const { response } = await agent.chat(prompt, `evolution_analysis_${Date.now()}`);

      // Parse proposals from LLM response
      const proposals = this.parseProposals(response, failures);
      for (const p of proposals) {
        this.proposals.set(p.id, p);
      }
      this.pruneProposals(); // C-4: 淘汰超限提案

      this.emit("evolution:analyzed", { proposals, failureCount: failures.length });
      logger.info({ proposals: proposals.length, failures: failures.length }, "Evolution analysis complete");
      return proposals;
    } catch (err: any) {
      logger.error({ err: err.message }, "Evolution analysis failed");
      return [];
    }
  }

  /**
   * Trigger a background review (Hermes-style nudge).
   * Phase B-1: 使用隔离的 Review Agent 执行（学 Hermes _spawn_background_review），
   * 避免 review prompt 污染主 agent 的对话历史。
   */
  async triggerReview(agentId: string, options: {
    reviewMemory?: boolean;
    reviewSkills?: boolean;
    conversationContext?: string;
  }): Promise<{ memoryActions: number; skillProposals: SkillProposal[] }> {
    // Phase B-1: 创建隔离的 Review Agent（学 Hermes Fork Agent 模式）
    const reviewAgent = this.agentManager.createReviewAgent(agentId);
    const agent = reviewAgent ?? this.agentManager.getAgent(agentId);
    if (!agent) throw new Error(`Agent '${agentId}' not found`);

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

    const sessionId = `review_${agentId}_${Date.now()}`;

    try {
      const { response } = await agent.chat(prompt, sessionId);

      const proposals: SkillProposal[] = [];
      let memoryActions = 0;

      // Try to parse skill proposals from response
      if (options.reviewSkills) {
        try {
          const jsonMatch = response.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.action && parsed.action !== "no_change") {
              const proposal: SkillProposal = {
                id: `prop_${uuid().slice(0, 8)}`,
                action: parsed.action,
                skillName: parsed.skillName ?? "unnamed_skill",
                description: parsed.description ?? "",
                content: parsed.content ?? "",
                reasoning: parsed.reasoning ?? "",
                basedOnCases: [],
                status: "pending",
                createdAt: new Date(),
                // Phase B-3: 解析 patch 操作
                patchOperations: parsed.patchOperations ?? undefined,
              };
              proposals.push(proposal);
              this.proposals.set(proposal.id, proposal);
            }
          }
        } catch {
          // Response wasn't JSON, that's ok — might be "Nothing to save."
        }
        this.pruneProposals(); // C-4: 淘汰超限提案
      }

      if (options.reviewMemory && !response.toLowerCase().includes("nothing to save")) {
        memoryActions = 1; // Assume at least one memory action was taken
      }

      this.emit("review:complete", { agentId, memoryActions, proposals });
      return { memoryActions, skillProposals: proposals };
    } finally {
      // Phase B-1: 清理临时 review agent 资源（学 Hermes review_agent.close()）
      if (reviewAgent) {
        reviewAgent.destroy();
      }
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

  /** Approve a proposal (auto-applies if autoApplySkills is enabled) */
  approveProposal(proposalId: string): SkillProposal | null {
    const p = this.proposals.get(proposalId);
    if (!p) return null;
    p.status = "approved";
    this.emit("proposal:approved", p);

    // Auto-apply if enabled
    if (this.nudge.getConfig().autoApplySkills) {
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
   */
  applyProposal(proposalId: string): SkillProposal | null {
    const p = this.proposals.get(proposalId);
    if (!p) return null;
    if (p.status === "applied") return p; // Already applied

    // Spec v3 Task 8: 应用前验证
    const validation = this.validateProposal(p);
    p.validationResult = validation;
    if (!validation.valid) {
      p.status = "rejected";
      this.emit("proposal:rejected", { ...p, reason: "validation_failed", errors: validation.errors });
      logger.warn({ proposalId, errors: validation.errors }, "Proposal rejected by validation");
      return p;
    }

    // Spec v3 Task 8: 质量评分门槛检查
    if (p.qualityScore !== undefined && p.qualityScore < 40) {
      p.status = "rejected";
      this.emit("proposal:rejected", { ...p, reason: "low_quality", score: p.qualityScore });
      logger.warn({ proposalId, score: p.qualityScore }, "Proposal rejected: quality score too low");
      return p;
    }

    try {
      // Ensure skills directory exists
      if (!existsSync(this.skillsDir)) {
        mkdirSync(this.skillsDir, { recursive: true });
      }

      const safeName = p.skillName.replace(/[^a-zA-Z0-9_-]/g, "_");
      const filePath = join(this.skillsDir, `${safeName}.md`);

      if (p.action === "patch" && p.patchOperations?.length && existsSync(filePath)) {
        // Phase B-3: Patch 模式——增量修改（学 Hermes _patch_skill）
        let content = readFileSync(filePath, "utf-8");
        for (const op of p.patchOperations) {
          if (!content.includes(op.oldString)) {
            logger.warn({ skillName: p.skillName, oldString: op.oldString.slice(0, 50) },
              "Patch target not found in skill file");
            continue;
          }
          content = content.replace(op.oldString, op.newString);
        }
        writeFileSync(filePath, content, "utf-8");
      } else {
        // Create / Update 模式：全量写入（现有逻辑）
        const fileContent = [
          "---",
          `name: ${p.skillName}`,
          `description: ${p.description}`,
          `version: "1.0.0"`,
          `generated_by: evolution_engine`,
          `action: ${p.action}`,
          `created_at: ${p.createdAt.toISOString()}`,
          `applied_at: ${new Date().toISOString()}`,
          "---",
          "",
          p.content,
          "",
        ].join("\n");
        writeFileSync(filePath, fileContent, "utf-8");
      }

      p.status = "applied";
      this.emit("proposal:applied", { ...p, filePath });
      // Phase B-3: 通知缓存清除钩子（供 C-4 使用）
      this.emit("skill:changed", { skillName: p.skillName, action: p.action });
      // C-3: 自动快照（每应用 N 个提案后自动创建快照）
      this._proposalsAppliedSinceSnapshot++;
      if (this._proposalsAppliedSinceSnapshot >= EvolutionEngine.AUTO_SNAPSHOT_INTERVAL) {
        this._proposalsAppliedSinceSnapshot = 0;
        this.takeSnapshot();
      }
      logger.info({ proposalId, skillName: p.skillName, action: p.action, filePath }, "Skill proposal applied");
      return p;
    } catch (err: any) {
      logger.error({ proposalId, error: err.message }, "Failed to apply skill proposal");
      // Don't change status on write failure
      return null;
    }
  }

  /** Mark a proposal as applied (alias for applyProposal — actually deploys) */
  markApplied(proposalId: string): SkillProposal | null {
    return this.applyProposal(proposalId);
  }

  // ─── Proposal Validation (Spec v3 Task 8) ─────────────────

  /**
   * 应用前验证 — 检查提案内容的完整性和安全性
   * 对标 Hermes 安装策略矩阵 + OpenClaw eligibility 评估
   */
  private validateProposal(proposal: SkillProposal): { valid: boolean; errors: string[]; scanVerdict?: string } {
    const errors: string[] = [];

    // 1. 完整性检查: name + description 必须存在
    if (!proposal.skillName || proposal.skillName.trim().length === 0) {
      errors.push("Missing skill name");
    }
    if (!proposal.description || proposal.description.trim().length === 0) {
      errors.push("Missing skill description");
    }
    if (!proposal.content || proposal.content.trim().length === 0) {
      errors.push("Empty skill content");
    }

    // 2. 内容安全扫描: 调用 guard.scanSkill 检查威胁模式
    let scanVerdict: string | undefined;
    try {
      // 为了扫描内容，构造临时的 YAML frontmatter + content
      const tempContent = [
        "---",
        `name: ${proposal.skillName}`,
        `description: ${proposal.description}`,
        `version: "1.0.0"`,
        "---",
        "",
        proposal.content,
      ].join("\n");

      // 尝试解析 frontmatter 确保有效
      const parsed = parseSkillFile(tempContent);
      if (!parsed.frontmatter.name) {
        errors.push("Frontmatter parsing failed: no name");
      }

      // 内容威胁扫描（纯文本模式——不需要实际目录）
      // 我们对 proposal.content 做快速威胁模式匹配
      scanVerdict = this.quickContentScan(proposal.content);
      if (scanVerdict === "dangerous") {
        errors.push(`Security scan: dangerous content detected`);
      }
    } catch (err: any) {
      // 解析失败不阻止应用，但记录警告
      logger.debug({ err: err.message }, "Proposal content parse warning");
    }

    return { valid: errors.length === 0, errors, scanVerdict };
  }

  /**
   * 快速内容威胁扫描（纯文本模式，不需要目录）
   * 检查关键威胁模式: rm -rf、反向 shell、curl|bash 等
   */
  private quickContentScan(content: string): string {
    const criticalPatterns = [
      /\brm\s+-rf\s+\/|\brm\s+-rf\s+~/i,
      /\b(nc|ncat|netcat)\b.*-[elp]|\bbash\s+-i\s+>&\s*\/dev\/tcp/i,
      /curl\s+.*\|\s*(ba)?sh|wget\s+.*\|\s*(ba)?sh/i,
      /ignore\s+(all\s+)?previous\s+(instructions|prompts|rules)/i,
      /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i,
      /\bxmrig\b|\bcpuminer\b|stratum\+tcp:\/\//i,
    ];

    const highPatterns = [
      /\bsudo\b\s+(?!-l\b)/,
      /\.bashrc|\.bash_profile|\.zshrc/i,
      /\beval\b\s*\(/i,
      /base64\s+-d\s*\|/i,
    ];

    for (const line of content.split("\n")) {
      for (const p of criticalPatterns) {
        if (p.test(line)) return "dangerous";
      }
    }

    for (const line of content.split("\n")) {
      for (const p of highPatterns) {
        if (p.test(line)) return "caution";
      }
    }

    return "safe";
  }

  /**
   * 计算提案质量评分 (Spec v3 Task 8)
   * 基于内容完整性、描述质量、安全性等因素
   */
  scoreProposal(proposal: SkillProposal): number {
    let score = 50; // 基准分

    // +20: 有完整的 name + description
    if (proposal.skillName && proposal.skillName.length > 2) score += 10;
    if (proposal.description && proposal.description.length > 10) score += 10;

    // +15: 内容长度合理 (50-5000 字符)
    const len = proposal.content?.length ?? 0;
    if (len >= 50 && len <= 5000) score += 15;
    else if (len > 5000) score += 5; // 太长扣分
    else score -= 10; // 太短扣分

    // +15: 有推理理由
    if (proposal.reasoning && proposal.reasoning.length > 20) score += 15;

    // -30: 安全扫描危险
    const verdict = this.quickContentScan(proposal.content ?? "");
    if (verdict === "dangerous") score -= 30;
    else if (verdict === "caution") score -= 10;

    // +10: 基于实际失败案例
    if (proposal.basedOnCases && proposal.basedOnCases.length > 0) score += 10;

    // 限制在 0-100
    return Math.max(0, Math.min(100, score));
  }

  // ─── Snapshots ─────────────────────────────────────────────

  /** Take a snapshot of current evolution state */
  takeSnapshot(): EvolutionSnapshot {
    const caseStats = this.cases.getStats();
    const snapshot: EvolutionSnapshot = {
      id: `snap_${uuid().slice(0, 8)}`,
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

  // ─── Helpers ───────────────────────────────────────────────

  private getFirstAgentId(): string | null {
    const agents = this.agentManager.listAgents();
    return agents.length > 0 ? agents[0].id : null;
  }

  private parseProposals(response: string, cases: InteractionCase[]): SkillProposal[] {
    const proposals: SkillProposal[] = [];
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return proposals;

      const parsed = JSON.parse(jsonMatch[0]);
      const rawProposals = parsed.proposals ?? [];

      for (const raw of rawProposals) {
        if (!raw.action || raw.action === "no_change") continue;
        proposals.push({
          id: `prop_${uuid().slice(0, 8)}`,
          action: raw.action,
          skillName: raw.skillName ?? "unnamed",
          description: raw.description ?? "",
          content: raw.content ?? "",
          reasoning: raw.reasoning ?? "",
          basedOnCases: cases.slice(0, 5).map((c) => c.id),
          status: "pending",
          createdAt: new Date(),
          // Phase B-3: 解析 patch 操作
          patchOperations: raw.patchOperations ?? undefined,
        });
      }
    } catch {
      logger.warn("Failed to parse evolution analysis response as JSON");
    }
    return proposals;
  }
}
