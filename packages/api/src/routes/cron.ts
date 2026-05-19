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
import { sendSuccess, Errors } from "./response-helper.js";
import { parseNaturalLanguageToCron, validateCronExpression } from "@super-agent/core";

export async function cronRoutes(app: FastifyInstance, ctx: AppContext) {
  if (!ctx.cronScheduler) {
    app.log.warn("Cron Scheduler not available, cron routes disabled");
    return;
  }

  const scheduler = ctx.cronScheduler;

  /** List all cron jobs */
  app.get("/api/cron/jobs", async (_request, reply) => {
    return sendSuccess(reply, { jobs: scheduler.listJobs() });
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
      /** [v3 Task 3-8b] 新增调度类型字段 */
      scheduleType?: "cron" | "once" | "interval";
      runAt?: string;
      intervalMs?: number;
      timeoutSeconds?: number;
    };
  }>("/api/cron/jobs", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.name || !body.agentId || !body.message) {
      return Errors.badRequest(reply, "name, agentId, and message are required");
    }

    // [v3 Task 2-8] 递归防护: 检查是否在 cron 执行上下文中
    if (scheduler.isCronExecutionContext(body.agentId)) {
      return Errors.recursiveProtection(reply, "定时任务执行中禁止创建新的定时任务（递归防护）");
    }

    // Parse natural language if no expression given
    let expression = body.expression;
    if (!expression && body.naturalLanguage) {
      expression = parseNaturalLanguageToCron(body.naturalLanguage);
    }
    if (!expression) {
      return Errors.badRequest(reply, "expression or naturalLanguage is required");
    }

    // [v3 Task 2-5] 校验 cron 表达式合法性
    const validation = validateCronExpression(expression);
    if (!validation.valid) {
      return Errors.badRequest(reply, `Invalid cron expression "${expression}": ${validation.error}`);
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
      // [v3 Task 3-8b] 传递新字段
      scheduleType: body.scheduleType,
      runAt: body.runAt,
      intervalMs: body.intervalMs,
      timeoutSeconds: body.timeoutSeconds,
    });

    return sendSuccess(reply, job);
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
      /** [v3 Task 3-8b] 新增调度类型字段 */
      scheduleType: "cron" | "once" | "interval";
      runAt: string;
      intervalMs: number;
      timeoutSeconds: number;
    }>;
  }>("/api/cron/jobs/:id", async (request, reply) => {
    const job = scheduler.getJob(request.params.id);
    if (!job) return Errors.notFound(reply, "Job not found");

    const body = request.body ?? {};

    // [审核 M-1] 递归防护: PUT 也需要检查（与 POST 一致）
    if (scheduler.isCronExecutionContext(job.agentId)) {
      return Errors.recursiveProtection(reply, "定时任务执行中禁止修改定时任务（递归防护）");
    }

    // [审核 S-3] 校验更新的 cron 表达式合法性
    if (body.expression !== undefined) {
      const validation = validateCronExpression(body.expression);
      if (!validation.valid) {
        return Errors.badRequest(reply, `Invalid cron expression "${body.expression}": ${validation.error}`);
      }
    }

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
    // [v3 Task 3-8b] 新增调度类型字段映射
    if (body.scheduleType !== undefined) updates.scheduleType = body.scheduleType;
    if (body.runAt !== undefined) updates.runAt = body.runAt;
    if (body.intervalMs !== undefined) updates.intervalMs = body.intervalMs;
    if (body.timeoutSeconds !== undefined) updates.timeoutSeconds = body.timeoutSeconds;

    if (Object.keys(updates).length > 0) {
      scheduler.updateJob(job.id, updates);
    }

    return sendSuccess(reply, { job: scheduler.getJob(job.id) });
  });

  /** Delete a cron job */
  app.delete<{ Params: { id: string } }>("/api/cron/jobs/:id", async (request, reply) => {
    const removed = scheduler.removeJob(request.params.id);
    if (!removed) return Errors.notFound(reply, "Job not found");
    return sendSuccess(reply, { status: "deleted" });
  });

  /** Execute a job immediately */
  app.post<{ Params: { id: string } }>("/api/cron/jobs/:id/run", async (request, reply) => {
    try {
      const response = await scheduler.executeNow(request.params.id);
      return sendSuccess(reply, { status: "executed", response });
    } catch (err: any) {
      // API-P1-03：内部栈仅进日志
      app.log.error({ route: "/api/cron/jobs/:id/run", jobId: request.params.id, err }, "Cron job execution failed");
      return Errors.internal(reply, "Cron job execution failed");
    }
  });

  /** Get execution history */
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string };
  }>("/api/cron/jobs/:id/history", async (request, reply) => {
    const limit = parseInt(request.query.limit ?? "20", 10);
    return sendSuccess(reply, { history: scheduler.getHistory(request.params.id, limit) });
  });

  /** Parse natural language to cron expression */
  app.post<{ Body: { text: string } }>("/api/cron/parse", async (request, reply) => {
    const { text } = request.body ?? {};
    if (!text) return Errors.badRequest(reply, "text is required");
    const expression = parseNaturalLanguageToCron(text);
    return sendSuccess(reply, { expression, text });
  });

  app.log.info("Cron routes registered");
}
