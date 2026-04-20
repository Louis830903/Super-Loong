/**
 * Collaboration REST API routes.
 *
 * Crew (Task Orchestration):
 *   POST   /api/collab/crew          — Run a crew
 *   GET    /api/collab/crew/history   — List crew execution history
 *
 * GroupChat (Conversation Negotiation):
 *   POST   /api/collab/groupchat          — Start a group chat
 *   GET    /api/collab/groupchat/history   — List group chat history
 *
 * General:
 *   GET    /api/collab/stats         — Collaboration system stats
 */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

// ─── Zod Schemas ──────────────────────────────────────────────

const CrewTaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  expectedOutput: z.string(),
  agentId: z.string(),
  context: z.array(z.string()).optional(),
  async: z.boolean().optional(),
});

const RunCrewSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  process: z.enum(["sequential", "hierarchical"]).default("sequential"),
  tasks: z.array(CrewTaskSchema).min(1),
  managerAgentId: z.string().optional(),
  maxRetries: z.number().int().min(0).optional(),
  inputs: z.record(z.string()).optional(),
  taskTimeoutMs: z.number().int().min(5000).max(600000).optional(), // 5s-10min
});

const RunGroupChatSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  participantIds: z.array(z.string()).min(1),
  speakerSelection: z.enum(["round_robin", "random", "manual", "auto"]).default("round_robin"),
  maxTurns: z.number().int().min(1).default(10),
  terminationKeyword: z.string().optional(),
  systemMessage: z.string().optional(),
  moderatorAgentId: z.string().optional(),
  initialMessage: z.string().min(1),
  turnTimeoutMs: z.number().int().min(5000).max(300000).optional(), // 5s-5min
  contextWindowSize: z.number().int().min(5).max(100).optional(), // C-3: 上下文窗口
});

export async function collaborationRoutes(app: FastifyInstance, ctx: AppContext) {
  // ─── Crew: Task Orchestration ──────────────────────────────

  /** Run a new crew */
  app.post("/api/collab/crew", async (req, reply) => {
    const parsed = RunCrewSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const body = parsed.data;

    const result = await ctx.collaborationOrchestrator.runCrew({
      name: body.name,
      description: body.description,
      process: body.process,
      tasks: body.tasks,
      managerAgentId: body.managerAgentId,
      maxRetries: body.maxRetries,
      inputs: body.inputs,
      taskTimeoutMs: body.taskTimeoutMs,
    });

    return reply.send(result);
  });

  /** Get crew execution history */
  app.get("/api/collab/crew/history", async (_req, reply) => {
    const history = ctx.collaborationOrchestrator.getHistory()
      .filter((r: any) => "process" in r);
    return reply.send(history);
  });

  // ─── GroupChat: Conversation Negotiation ───────────────────

  /** Start a new group chat */
  app.post("/api/collab/groupchat", async (req, reply) => {
    const parsed = RunGroupChatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const body = parsed.data;

    const result = await ctx.collaborationOrchestrator.runGroupChat(
      {
        name: body.name,
        description: body.description,
        participantIds: body.participantIds,
        speakerSelection: body.speakerSelection,
        maxTurns: body.maxTurns,
        terminationKeyword: body.terminationKeyword,
        systemMessage: body.systemMessage,
        moderatorAgentId: body.moderatorAgentId,
        turnTimeoutMs: body.turnTimeoutMs,
        contextWindowSize: body.contextWindowSize,
      },
      body.initialMessage,
    );

    return reply.send(result);
  });

  /** Get group chat history */
  app.get("/api/collab/groupchat/history", async (_req, reply) => {
    const history = ctx.collaborationOrchestrator.getHistory()
      .filter((r: any) => !("process" in r));
    return reply.send(history);
  });

  // ─── General ───────────────────────────────────────────────

  /** Unified collaboration history with pagination (C-4) */
  app.get("/api/collab/history", async (req, reply) => {
    const page = Math.max(1, Number((req.query as any).page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number((req.query as any).pageSize) || 20));
    const type = (req.query as any).type as string | undefined;
    const validType = type === "crew" || type === "groupchat" ? type : undefined;

    const { results, total } = ctx.collaborationOrchestrator.getHistoryPaginated(page, pageSize, validType);
    return reply.send({ results, total, page, pageSize });
  });

  /** Collaboration stats */
  app.get("/api/collab/stats", async (_req, reply) => {
    return reply.send(ctx.collaborationOrchestrator.getStats());
  });

  app.log.info("Collaboration routes registered");
}
