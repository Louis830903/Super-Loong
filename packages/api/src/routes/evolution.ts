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
  agentId: z.string().min(1),
  reviewMemory: z.boolean().optional(),
  reviewSkills: z.boolean().optional(),
  conversationContext: z.string().optional(),
});

// Phase A-2: Flush Schema
const FlushSchema = z.object({
  agentId: z.string().min(1),
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

  // ─── Interactions ──────────────────────────────────────────

  app.post("/api/evolution/interactions", async (req, reply) => {
    const parsed = RecordInteractionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues.map((i) => i.message).join("; ") });
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

    return reply.send(result);
  });

  app.get("/api/evolution/interactions", async (_req, reply) => {
    return reply.send(engine.cases.getAllCases());
  });

  app.get("/api/evolution/interactions/failures", async (_req, reply) => {
    return reply.send({
      cases: engine.cases.getFailureCases(),
      byCategory: engine.cases.getFailuresByCategory(),
    });
  });

  // ─── Analysis ──────────────────────────────────────────────

  app.post("/api/evolution/analyze", async (req, reply) => {
    const body = (req.body ?? {}) as { analyzerAgentId?: string };
    const proposals = await engine.analyzeFailures(body.analyzerAgentId);
    return reply.send({ proposals, count: proposals.length });
  });

  app.post("/api/evolution/review", async (req, reply) => {
    const parsed = ReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const body = parsed.data;

    const result = await engine.triggerReview(body.agentId, {
      reviewMemory: body.reviewMemory,
      reviewSkills: body.reviewSkills,
      conversationContext: body.conversationContext,
    });

    return reply.send(result);
  });

  // Phase A-2: 会话 Flush — 上下文丢失前自动保存记忆/技能
  app.post("/api/evolution/flush", async (req, reply) => {
    const parsed = FlushSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const body = parsed.data;
    const result = await engine.flushBeforeReset(body.agentId, {
      conversationMessages: body.messages ?? [],
      currentMemoryState: body.currentMemoryState,
    });
    return reply.send(result);
  });

  // ─── Proposals ─────────────────────────────────────────────

  app.get("/api/evolution/proposals", async (req, reply) => {
    const query = req.query as { status?: string };
    const proposals = engine.getProposals(
      query.status ? { status: query.status as any } : undefined,
    );
    return reply.send({ proposals });
  });

  app.post("/api/evolution/proposals/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = engine.approveProposal(id);
    if (!result) return reply.status(404).send({ error: "Proposal not found" });
    return reply.send(result);
  });

  app.post("/api/evolution/proposals/:id/reject", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = engine.rejectProposal(id);
    if (!result) return reply.status(404).send({ error: "Proposal not found" });
    return reply.send(result);
  });

  app.post("/api/evolution/proposals/:id/apply", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = engine.applyProposal(id);
    if (!result) return reply.status(404).send({ error: "Proposal not found or apply failed" });
    return reply.send(result);
  });

  // ─── Snapshots ─────────────────────────────────────────────

  app.post("/api/evolution/snapshots", async (_req, reply) => {
    const snapshot = engine.takeSnapshot();
    return reply.send(snapshot);
  });

  app.get("/api/evolution/snapshots", async (_req, reply) => {
    return reply.send({
      snapshots: engine.getSnapshots(),
      best: engine.getBestSnapshot(),
    });
  });

  // ─── Config & Stats ────────────────────────────────────────

  app.get("/api/evolution/stats", async (_req, reply) => {
    return reply.send(engine.getStats());
  });

  app.get("/api/evolution/nudge/config", async (_req, reply) => {
    return reply.send(engine.nudge.getConfig());
  });

  app.put("/api/evolution/nudge/config", async (req, reply) => {
    const parsed = NudgeConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    engine.nudge.updateConfig(parsed.data);
    return reply.send(engine.nudge.getConfig());
  });

  app.log.info("Evolution routes registered");
}
