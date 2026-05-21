/**
 * v3 Task 6 — Cron 定时任务路由 zod schema
 *
 * @why 定时任务 CRUD + 自然语言解析是前端高频交互，强类型防止参数遗漏。
 *
 * 端点：
 *   GET    /api/cron/jobs              — 列出所有定时任务
 *   POST   /api/cron/jobs              — 创建定时任务
 *   PUT    /api/cron/jobs/{id}         — 更新定时任务
 *   DELETE /api/cron/jobs/{id}         — 删除定时任务
 *   POST   /api/cron/jobs/{id}/run     — 立即执行
 *   GET    /api/cron/jobs/{id}/history — 执行历史
 *   POST   /api/cron/parse            — 自然语言→cron 表达式
 */

import { z } from "zod";
import { registry } from "./registry-singleton.js";
import { apiSuccessEnvelope } from "./envelope.js";

// ─── Cron Job 实体 ──────────────────────────────────────────

/** @why 定时任务完整实体，列表/详情/CRUD 接口共用 */
export const CronJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  expression: z.string().optional(),
  naturalLanguage: z.string().optional(),
  agentId: z.string(),
  message: z.string(),
  deliveryChannel: z.string().optional(),
  deliveryChatId: z.string().optional(),
  timezone: z.string().optional(),
  maxRetries: z.number().optional(),
  scheduleType: z.enum(["cron", "once", "interval"]).optional(),
  runAt: z.string().optional(),
  intervalMs: z.number().optional(),
  timeoutSeconds: z.number().optional(),
  enabled: z.boolean().optional(),
  lastRun: z.string().optional(),
  nextRun: z.string().optional(),
  status: z.string().optional(),
});
registry.register("CronJob", CronJobSchema);

// ─── Create Body ────────────────────────────────────────────

/** @why POST /api/cron/jobs 创建请求体，支持 cron/once/interval 三种调度模式 */
export const CreateCronJobBodySchema = z.object({
  name: z.string(),
  expression: z.string().optional(),
  naturalLanguage: z.string().optional(),
  agentId: z.string(),
  message: z.string(),
  deliveryChannel: z.string().optional(),
  deliveryChatId: z.string().optional(),
  timezone: z.string().optional(),
  maxRetries: z.number().optional(),
  scheduleType: z.enum(["cron", "once", "interval"]).optional(),
  runAt: z.string().optional(),
  intervalMs: z.number().optional(),
  timeoutSeconds: z.number().optional(),
});
registry.register("CreateCronJobBody", CreateCronJobBodySchema);

// ─── Parse Body ─────────────────────────────────────────────

/** @why POST /api/cron/parse 自然语言解析请求体 */
export const ParseCronBodySchema = z.object({
  text: z.string().describe("自然语言描述，如 '每天早上9点'"),
  timezone: z.string().optional(),
});
registry.register("ParseCronBody", ParseCronBodySchema);

// ─── History Entry ──────────────────────────────────────────

const CronHistoryEntry = z.object({
  id: z.string(),
  jobId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  status: z.enum(["success", "failed", "timeout", "running"]),
  error: z.string().optional(),
  retryCount: z.number().optional(),
});

// ─── Response Data ──────────────────────────────────────────

const CronJobListData = z.object({ jobs: z.array(CronJobSchema) });
const CronJobDetailData = z.object({ job: CronJobSchema });
const CronHistoryData = z.object({ history: z.array(CronHistoryEntry) });
const CronParseData = z.object({ expression: z.string(), description: z.string() });

// ─── 注册路径 ───────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/cron/jobs",
  summary: "列出所有定时任务",
  responses: {
    200: { description: "任务列表", content: { "application/json": { schema: apiSuccessEnvelope(CronJobListData) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/cron/jobs",
  summary: "创建定时任务",
  request: { body: { content: { "application/json": { schema: CreateCronJobBodySchema } } } },
  responses: {
    200: { description: "创建成功", content: { "application/json": { schema: apiSuccessEnvelope(CronJobDetailData) } } },
    400: { description: "参数校验失败" },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/cron/jobs/{id}",
  summary: "更新定时任务",
  request: { body: { content: { "application/json": { schema: CreateCronJobBodySchema.partial() } } } },
  responses: {
    200: { description: "更新成功", content: { "application/json": { schema: apiSuccessEnvelope(CronJobDetailData) } } },
    404: { description: "任务不存在" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/cron/jobs/{id}",
  summary: "删除定时任务",
  responses: {
    200: { description: "删除成功", content: { "application/json": { schema: apiSuccessEnvelope(z.object({ success: z.boolean() })) } } },
    404: { description: "任务不存在" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/cron/jobs/{id}/run",
  summary: "立即执行定时任务",
  responses: {
    200: { description: "触发成功", content: { "application/json": { schema: apiSuccessEnvelope(z.object({ triggered: z.boolean() })) } } },
    404: { description: "任务不存在" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/cron/jobs/{id}/history",
  summary: "获取执行历史",
  responses: {
    200: { description: "执行历史", content: { "application/json": { schema: apiSuccessEnvelope(CronHistoryData) } } },
    404: { description: "任务不存在" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/cron/parse",
  summary: "自然语言解析为 cron 表达式",
  request: { body: { content: { "application/json": { schema: ParseCronBodySchema } } } },
  responses: {
    200: { description: "解析结果", content: { "application/json": { schema: apiSuccessEnvelope(CronParseData) } } },
    400: { description: "无法解析" },
  },
});
