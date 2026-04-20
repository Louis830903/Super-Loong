/**
 * Cron Routes — scheduled task management.
 *
 * GET    /api/cron/jobs            — List all cron jobs
 * POST   /api/cron/jobs            — Create a new cron job
 * PUT    /api/cron/jobs/:id        — Update a cron job
 * DELETE /api/cron/jobs/:id        — Delete a cron job
 * POST   /api/cron/jobs/:id/run    — Execute a job immediately
 * GET    /api/cron/jobs/:id/history — Get execution history
 * POST   /api/cron/parse           — Parse natural language to cron
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { parseNaturalLanguageToCron } from "@super-agent/core";

export async function cronRoutes(app: FastifyInstance, ctx: AppContext) {
  if (!ctx.cronScheduler) {
    app.log.warn("Cron Scheduler not available, cron routes disabled");
    return;
  }

  const scheduler = ctx.cronScheduler;

  /** List all cron jobs */
  app.get("/api/cron/jobs", async () => {
    return { jobs: scheduler.listJobs() };
  });

  /** Create a new cron job */
  app.post<{
    Body: {
      name: string;
      expression?: string;
      naturalLanguage?: string;
      agentId: string;
      message: string;
      deliveryChannel?: string;
      deliveryChatId?: string;
      timezone?: string;
      maxRetries?: number;
    };
  }>("/api/cron/jobs", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.name || !body.agentId || !body.message) {
      return reply.status(400).send({ error: "name, agentId, and message are required" });
    }

    // Parse natural language if no expression given
    let expression = body.expression;
    if (!expression && body.naturalLanguage) {
      expression = parseNaturalLanguageToCron(body.naturalLanguage);
    }
    if (!expression) {
      return reply.status(400).send({ error: "expression or naturalLanguage is required" });
    }

    const job = scheduler.addJob({
      name: body.name,
      expression,
      naturalLanguage: body.naturalLanguage,
      agentId: body.agentId,
      message: body.message,
      deliveryChannel: body.deliveryChannel,
      deliveryChatId: body.deliveryChatId,
      enabled: true,
      timezone: body.timezone ?? "Asia/Shanghai",
      maxRetries: body.maxRetries ?? 1,
    });

    return reply.status(201).send(job);
  });

  /** Update a cron job (E-3: 支持完整字段更新，不仅是 enabled) */
  app.put<{
    Params: { id: string };
    Body: Partial<{
      name: string;
      expression: string;
      enabled: boolean;
      message: string;
      timezone: string;
      naturalLanguage: string;
      deliveryChannel: string;
      deliveryChatId: string;
      maxRetries: number;
    }>;
  }>("/api/cron/jobs/:id", async (request, reply) => {
    const job = scheduler.getJob(request.params.id);
    if (!job) return reply.status(404).send({ error: "Job not found" });

    const body = request.body ?? {};

    // enabled 单独处理（启用/禁用操作会重新调度）
    if (body.enabled === true) scheduler.enableJob(job.id);
    if (body.enabled === false) scheduler.disableJob(job.id);

    // 构建其余字段的更新对象
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.expression !== undefined) updates.expression = body.expression;
    if (body.message !== undefined) updates.message = body.message;
    if (body.timezone !== undefined) updates.timezone = body.timezone;
    if (body.naturalLanguage !== undefined) updates.naturalLanguage = body.naturalLanguage;
    if (body.deliveryChannel !== undefined) updates.deliveryChannel = body.deliveryChannel;
    if (body.deliveryChatId !== undefined) updates.deliveryChatId = body.deliveryChatId;
    if (body.maxRetries !== undefined) updates.maxRetries = body.maxRetries;

    if (Object.keys(updates).length > 0) {
      scheduler.updateJob(job.id, updates);
    }

    return { job: scheduler.getJob(job.id) };
  });

  /** Delete a cron job */
  app.delete<{ Params: { id: string } }>("/api/cron/jobs/:id", async (request, reply) => {
    const removed = scheduler.removeJob(request.params.id);
    if (!removed) return reply.status(404).send({ error: "Job not found" });
    return { status: "deleted" };
  });

  /** Execute a job immediately */
  app.post<{ Params: { id: string } }>("/api/cron/jobs/:id/run", async (request, reply) => {
    try {
      const response = await scheduler.executeNow(request.params.id);
      return { status: "executed", response };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  /** Get execution history */
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string };
  }>("/api/cron/jobs/:id/history", async (request) => {
    const limit = parseInt(request.query.limit ?? "20", 10);
    return { history: scheduler.getHistory(request.params.id, limit) };
  });

  /** Parse natural language to cron expression */
  app.post<{ Body: { text: string } }>("/api/cron/parse", async (request, reply) => {
    const { text } = request.body ?? {};
    if (!text) return reply.status(400).send({ error: "text is required" });
    const expression = parseNaturalLanguageToCron(text);
    return { expression, text };
  });

  app.log.info("Cron routes registered");
}
