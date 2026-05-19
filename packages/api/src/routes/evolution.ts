/**
 * Evolution REST API routes.
 *
 * Interactions:
 *   POST   /api/evolution/interactions         — Record an interaction case
 *   GET    /api/evolution/interactions          — List interaction cases
 *   GET    /api/evolution/interactions/failures — List failure cases
 *
 * Analysis:
 *   POST   /api/evolution/analyze              — Trigger failure analysis
 *   POST   /api/evolution/review               — Trigger nudge review
 *
 * Proposals:
 *   GET    /api/evolution/proposals             — List skill proposals
 *   POST   /api/evolution/proposals/:id/approve — Approve a proposal
 *   POST   /api/evolution/proposals/:id/reject  — Reject a proposal
 *   POST   /api/evolution/proposals/:id/apply   — Mark as applied
 *
 * Snapshots:
 *   POST   /api/evolution/snapshots            — Take a snapshot
 *   GET    /api/evolution/snapshots             — List snapshots
 *
 * Config & Stats:
 *   GET    /api/evolution/stats                — Get evolution stats
 *   GET    /api/evolution/nudge/config         — Get nudge config
 *   PUT    /api/evolution/nudge/config         — Update nudge config
 */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { sendSuccess, Errors } from "./response-helper.js";

// ─── Zod Schemas ──────────────────────────────────────────────

const RecordInteractionSchema = z.object({
  agentId: z.string().min(1),
  sessionId: z.string().default("default"),
  userMessage: z.string().min(1),
  agentResponse: z.string().min(1),
  toolCalls: z.array(z.string()).optional(),
  success: z.boolean().optional(),
  score: z.number().min(0).max(1).optional(),
  failureReason: z.string().optional(),
  failureCategory: z.string().optional(),
});

const ReviewSchema = z.object({
  agentId: z.string().min(1).optional(), // 可选：未传时自动取第一个 Agent
  reviewMemory: z.boolean().optional(),
  reviewSkills: z.boolean().optional(),
  conversationContext: z.string().optional(),
});

// Task 3.4: 会话搜索 Schema
const SearchSchema = z.object({
  query: z.string().min(1),
  sessionFilter: z.array(z.string()).optional(),
  roleFilter: z.array(z.enum(["user", "assistant"])).optional(),
  limit: z.number().int().positive().optional(),
});

// Task 3.4: 知识提取 Schema
const ExtractSchema = z.object({
  agentId: z.string().min(1).optional(),
  maxCases: z.number().int().positive().optional(),
});

// Task 3.4: 验证管道 Schema
const VerifySchema = z.object({
  proposalId: z.string().min(1),
});

// Phase A-2: Flush Schema
const FlushSchema = z.object({
  agentId: z.string().min(1).optional(), // 可选：未传时自动取第一个 Agent
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).optional(),
  currentMemoryState: z.string().optional(),
});

const NudgeConfigSchema = z.object({
  memoryReviewInterval: z.number().int().positive().optional(),
  skillReviewInterval: z.number().int().positive().optional(),
  autoApplySkills: z.boolean().optional(),
  combinedReview: z.boolean().optional(),
  flushMinTurns: z.number().int().min(0).optional(), // Phase A-2: flush 最小轮数
});

export async function evolutionRoutes(app: FastifyInstance, ctx: AppContext) {
  const engine = ctx.evolutionEngine;

  // 辅助：获取默认 agentId（取第一个可用 Agent）
  const resolveAgentId = (id?: string): string | null => {
    if (id) return id;
    const agents = ctx.agentManager.listAgents();
    return agents.length > 0 ? agents[0].id : null;
  };

  // ─── Interactions ──────────────────────────────────────────

  app.post("/api/evolution/interactions", async (req, reply) => {
    const parsed = RecordInteractionSchema.safeParse(req.body);
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const body = parsed.data;

    const result = engine.recordInteraction({
      agentId: body.agentId,
      sessionId: body.sessionId,
      userMessage: body.userMessage,
      agentResponse: body.agentResponse,
      toolCalls: body.toolCalls,
      success: body.success,
      score: body.score,
      failureReason: body.failureReason,
      failureCategory: body.failureCategory as any,
    });

    return sendSuccess(reply, result);
  });

  app.get("/api/evolution/interactions", async (_req, reply) => {
    return sendSuccess(reply, engine.cases.getAllCases());
  });

  app.get("/api/evolution/interactions/failures", async (_req, reply) => {
    return sendSuccess(reply, {
      cases: engine.cases.getFailureCases(),
      byCategory: engine.cases.getFailuresByCategory(),
    });
  });

  // ─── Analysis ──────────────────────────────────────────────

  app.post("/api/evolution/analyze", async (_req, reply) => {
    const proposals = await engine.analyzeFailures();
    return sendSuccess(reply, { proposals, count: proposals.length });
  });

  app.post("/api/evolution/review", async (req, reply) => {
    const parsed = ReviewSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const body = parsed.data;
    const agentId = resolveAgentId(body.agentId);
    if (!agentId) {
      return Errors.badRequest(reply, "没有可用的 Agent，请先创建一个");
    }

    try {
      const result = await engine.triggerReview(agentId, {
        reviewMemory: body.reviewMemory,
        reviewSkills: body.reviewSkills,
        conversationContext: body.conversationContext,
      });
      return sendSuccess(reply, result);
    } catch (err: any) {
      // API-P1-03：内部栈仅进日志，对外通用文案
      app.log.error({ route: "/api/evolution/review", err }, "Review 执行失败");
      return Errors.internal(reply, "Review 执行失败");
    }
  });

  // Phase A-2: 会话 Flush — 上下文丢失前自动保存记忆/技能
  app.post("/api/evolution/flush", async (req, reply) => {
    const parsed = FlushSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const body = parsed.data;
    const agentId = resolveAgentId(body.agentId);
    if (!agentId) {
      return Errors.badRequest(reply, "没有可用的 Agent，请先创建一个");
    }

    try {
      const result = await engine.flushBeforeReset(agentId, {
        conversationMessages: body.messages ?? [],
        currentMemoryState: body.currentMemoryState,
      });
      return sendSuccess(reply, result);
    } catch (err: any) {
      app.log.error({ route: "/api/evolution/flush", err }, "Flush 执行失败");
      return Errors.internal(reply, "Flush 执行失败");
    }
  });

  // ─── Proposals ─────────────────────────────────────────────

  app.get("/api/evolution/proposals", async (req, reply) => {
    const query = req.query as { status?: string };
    const proposals = engine.getProposals(
      query.status ? { status: query.status as any } : undefined,
    );
    return sendSuccess(reply, { proposals });
  });

  app.post("/api/evolution/proposals/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await engine.approveProposal(id);
    if (!result) return Errors.notFound(reply, "Proposal not found");
    return sendSuccess(reply, result);
  });

  app.post("/api/evolution/proposals/:id/reject", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = engine.rejectProposal(id);
    if (!result) return Errors.notFound(reply, "Proposal not found");
    return sendSuccess(reply, result);
  });

  app.post("/api/evolution/proposals/:id/apply", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await engine.applyProposal(id);
    if (!result) return Errors.notFound(reply, "Proposal not found or apply failed");
    return sendSuccess(reply, result);
  });

  // 代码提案专用审批端点：人工审核通过后执行沙箱验证 + 源码修改
  app.post("/api/evolution/proposals/:id/approve-code", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      // Step 1: 标记人工审核通过
      const approved = engine.approveCodeProposal(id);
      if (!approved) return Errors.notFound(reply, "Proposal not found or not a code proposal");

      // Step 2: 执行沙箱验证 + 自修改引擎写入
      const result = await engine.applyCodeProposal(id);
      if (!result) {
        return Errors.badRequest(reply, "代码提案应用失败（沙箱验证未通过或写入错误）");
      }
      return sendSuccess(reply, result);
    } catch (err: any) {
      app.log.error({ route: "/api/evolution/proposals/:id/approve-code", err }, "代码提案应用异常");
      return Errors.internal(reply, "代码提案应用失败");
    }
  });

  // ─── Snapshots ─────────────────────────────────────────────

  app.post("/api/evolution/snapshots", async (req, reply) => {
    const body = (req.body ?? {}) as { label?: string };
    const snapshot = engine.takeSnapshot(body.label);
    return sendSuccess(reply, snapshot);
  });

  app.get("/api/evolution/snapshots", async (_req, reply) => {
    return sendSuccess(reply, {
      snapshots: engine.getSnapshots(),
      best: engine.getBestSnapshot(),
    });
  });

  app.delete("/api/evolution/snapshots/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = engine.deleteSnapshot(id);
    if (!ok) return Errors.notFound(reply, "Snapshot not found");
    return sendSuccess(reply, { success: true });
  });

  // ─── Config & Stats ────────────────────────────────────────

  app.get("/api/evolution/stats", async (_req, reply) => {
    return sendSuccess(reply, engine.getStats());
  });

  app.get("/api/evolution/nudge/config", async (_req, reply) => {
    return sendSuccess(reply, engine.nudge.getConfig());
  });

  app.put("/api/evolution/nudge/config", async (req, reply) => {
    const parsed = NudgeConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    engine.nudge.updateConfig(parsed.data);
    return sendSuccess(reply, engine.nudge.getConfig());
  });

  // ─── 分析器 LLM 配置（Provider+Model 选择，纯 LLM 调用不走 Agent）────

  app.get("/api/evolution/analyzer/config", async (_req, reply) => {
    return sendSuccess(reply, engine.getAnalyzerLlm());
  });

  app.put("/api/evolution/analyzer/config", async (req, reply) => {
    const body = (req.body ?? {}) as { providerId?: string | null; modelId?: string | null };
    // 校验 Provider 是否存在于 model catalog
    if (body.providerId) {
      const { getProviderById } = await import("@super-agent/core");
      const providerDef = getProviderById(body.providerId);
      if (!providerDef) {
        return Errors.badRequest(reply, `Provider ${body.providerId} 不存在`);
      }
      // 校验 modelId 是否属于该 provider
      if (body.modelId) {
        const modelExists = providerDef.models?.some((m: { id: string }) => m.id === body.modelId);
        if (!modelExists) {
          return Errors.badRequest(reply, `Model ${body.modelId} 不属于 Provider ${body.providerId}`);
        }
      }
    }
    engine.setAnalyzerLlm(body.providerId ?? null, body.modelId ?? null);
    return sendSuccess(reply, engine.getAnalyzerLlm());
  });

  // ─── 已配置的 Provider 列表（含模型目录，供前端分析器下拉选择）────

  app.get("/api/evolution/analyzer/providers", async (_request, reply) => {
    const { getModelCatalog } = await import("@super-agent/core");
    const catalog = getModelCatalog();
    const records = ctx.providerStore.list();

    // 只返回已配置 apiKey 且已启用的 Provider
    const result = catalog
      .filter((p) => {
        const record = records.find((r) => r.id === p.id);
        return record?.apiKey && record?.isEnabled !== false;
      })
      .map((p) => ({
        id: p.id,
        name: p.name,
        models: p.models?.map((m: { id: string; name: string }) => ({ id: m.id, name: m.name })) ?? [],
      }));

    return sendSuccess(reply, { providers: result });
  });

  // ─── 原始代码读取（审查 P0-2: 为前端 before/after diff 提供数据）────

  app.post("/api/evolution/code/read", async (req, reply) => {
    const body = (req.body ?? {}) as { modulePath?: string; targetName?: string };
    if (!body.modulePath) {
      return Errors.badRequest(reply, "modulePath 不能为空");
    }
    try {
      const code = engine.readCodeProposal(body.modulePath, body.targetName);
      return sendSuccess(reply, { code });
    } catch (err: any) {
      app.log.error({ route: "/api/evolution/code/read", err }, "读取原始代码失败");
      return Errors.internal(reply, "读取原始代码失败");
    }
  });

  app.log.info("Evolution routes registered");

  // ─── Task 3.4: Evolution 高级模块端点 ────────────────────────

  // POST /api/evolution/search — 会话全文搜索
  app.post("/api/evolution/search", async (req, reply) => {
    if (!ctx.sessionSearch) {
      return Errors.serviceUninitialized(reply, "SessionSearchEngine 未初始化");
    }
    const parsed = SearchSchema.safeParse(req.body);
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { query, sessionFilter, roleFilter, limit } = parsed.data;
    try {
      const results = await ctx.sessionSearch.search(query, { sessionFilter, roleFilter: roleFilter as any, limit });
      return sendSuccess(reply, { results, count: results.length });
    } catch (err: any) {
      app.log.error({ route: "/api/evolution/search", err }, "搜索失败");
      return Errors.internal(reply, "搜索失败");
    }
  });

  // POST /api/evolution/extract — 知识提取
  app.post("/api/evolution/extract", async (req, reply) => {
    if (!ctx.knowledgeExtractor) {
      return Errors.serviceUninitialized(reply, "KnowledgeExtractor 未初始化");
    }
    const parsed = ExtractSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    try {
      // 从 CaseCollector 获取交互案例作为提取源
      const cases = engine.cases.getAllCases().slice(-(parsed.data.maxCases ?? 100));
      const result = await ctx.knowledgeExtractor.extractFromCases(cases);
      return sendSuccess(reply, result);
    } catch (err: any) {
      app.log.error({ route: "/api/evolution/extract", err }, "知识提取失败");
      return Errors.internal(reply, "知识提取失败");
    }
  });

  // GET /api/evolution/insights — 获取统计洞察报告
  app.get("/api/evolution/insights", async (req, reply) => {
    if (!ctx.insightsEngine) {
      return Errors.serviceUninitialized(reply, "InsightsEngine 未初始化");
    }
    try {
      // 将当前 CaseCollector 中的案例供给 InsightsEngine 生成报告
      const allCases = engine.cases.getAllCases();
      ctx.insightsEngine.addCases(allCases);
      const query = req.query as { fromDate?: string; toDate?: string };
      const report = ctx.insightsEngine.generateReport({
        fromDate: query.fromDate ? new Date(query.fromDate) : undefined,
        toDate: query.toDate ? new Date(query.toDate) : undefined,
      });
      return sendSuccess(reply, report);
    } catch (err: any) {
      app.log.error({ route: "/api/evolution/insights", err }, "Insights 生成失败");
      return Errors.internal(reply, "Insights 生成失败");
    }
  });

  // POST /api/evolution/verify — 运行验证管道
  app.post("/api/evolution/verify", async (req, reply) => {
    if (!ctx.verificationPipeline) {
      return Errors.serviceUninitialized(reply, "VerificationPipeline 未初始化");
    }
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    try {
      const proposals = engine.getProposals();
      const proposal = proposals.find((p) => p.id === parsed.data.proposalId);
      if (!proposal) {
        return Errors.notFound(reply, "Proposal not found");
      }
      const result = await ctx.verificationPipeline.verify(proposal);
      return sendSuccess(reply, result);
    } catch (err: any) {
      app.log.error({ route: "/api/evolution/verify", err }, "验证执行失败");
      return Errors.internal(reply, "验证执行失败");
    }
  });

  // GET /api/evolution/verify/results — 获取验证历史
  app.get("/api/evolution/verify/results", async (_req, reply) => {
    if (!ctx.verificationPipeline) {
      return Errors.serviceUninitialized(reply, "VerificationPipeline 未初始化");
    }
    return sendSuccess(reply, {
      history: ctx.verificationPipeline.getHistory(),
      stats: ctx.verificationPipeline.getStats(),
      rollbacks: ctx.verificationPipeline.getRollbacks(),
    });
  });

  app.log.info("Evolution advanced module routes registered (search, extract, insights, verify)");
}
