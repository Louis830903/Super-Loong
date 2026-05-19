/**
 * Video REST API routes — ShortVideoCrew 视频任务管理端点。
 *
 * 端点：
 *   POST   /api/video/jobs      — 创建视频任务（校验→预估成本→入库→入队）
 *   GET    /api/video/jobs      — 列表视频任务（分页 + 状态过滤）
 *   GET    /api/video/jobs/:id  — 获取单个视频任务详情
 *   DELETE /api/video/jobs/:id  — 取消/删除视频任务
 *
 * WS 进度推送：
 *   通过 emitEvent("video:*", ...) 推送到 EventBus → WS 客户端自动收到。
 *   事件拆分：video:created / video:progress / video:completed / video:failed
 *   客户端 subscribe "video:*" 主题即可。
 *
 * @see Spec v1.4 §4.2, §4.5
 * @see video-crew-presets.ts ShortVideoCrew 编排配置
 * @see video-forge-supervisor.ts 并发守卫（enqueueVideoJob）
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import {
  insertVideoJob,
  updateVideoJob,
  getVideoJob,
  listVideoJobs,
  estimateCost,
  buildShortVideoCrew,
  buildShortVideoAgents,
  validateVideoCrewModel,
  saveMediaBuffer,
  getProviderTemplates,
  applyAllAgentProviders,
  PROVIDER_PRESETS,
} from "@super-agent/core";
import type { VideoJobRow, ShortVideoCrewParams, AgentProviderOverride } from "@super-agent/core";
import { enqueueVideoJob } from "../services/video-forge-supervisor.js";
import { emitEvent } from "../ws/index.js";
import { sendSuccess, Errors } from "./response-helper.js";

// ─── Zod 入参校验 ────────────────────────────────────────

const CreateVideoJobSchema = z.object({
  /** 用户输入的主题（必填） */
  topic: z.string().min(1).max(500),
  /** 图像工作流标识（用于成本预估） */
  image_workflow: z.string().optional(),
  /** 视频工作流标识（用于成本预估） */
  video_workflow: z.string().optional(),
  /** 每个 Agent 的模型覆盖配置 */
  agent_providers: z
    .record(
      z.union([
        z.object({
          providerId: z.string(),
          model: z.string(),
          baseUrl: z.string().optional(),
          apiKey: z.string().optional(),
        }),
        z.null(),
      ]),
    )
    .optional(),
  /** 模型配置模板 ID（从 agent_provider_templates 查询） */
  agent_provider_template_id: z.string().optional(),
  /** 成本上限（CNY），默认 5.0 */
  cost_limit_cny: z.number().min(0).default(5.0),
  /** 用户已确认成本（超预算时需为 true 才放行） */
  cost_confirmed: z.boolean().default(false),
});

const ListVideoJobsSchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** 视频文件存储上限：200MB（30秒视频充裕） */
const VIDEO_MAX_BYTES = 200 * 1024 * 1024;

// ─── 路由注册 ─────────────────────────────────────────────

export async function videoRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // ──────────────────────────────────────────────────────────
  // POST /api/video/jobs — 创建视频任务
  // ──────────────────────────────────────────────────────────
  app.post("/api/video/jobs", async (req, reply) => {
    const parsed = CreateVideoJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const body = parsed.data;

    // 0. 模板 ID 展开：若提供了 template_id 且未直接传 agent_providers，
    //    优先从内存 PROVIDER_PRESETS 查找系统预设（DB 只存标识符），
    //    否则从 DB 查找用户自定义模板
    let resolvedProviders = body.agent_providers;
    if (!resolvedProviders && body.agent_provider_template_id) {
      // 优先查找系统预设（源头在代码中，不依赖 DB 的 providers_json）
      const presetMatch = PROVIDER_PRESETS.find(
        (p) => p.id === body.agent_provider_template_id,
      );
      if (presetMatch) {
        resolvedProviders = presetMatch.providers;
      } else {
        // 用户自定义模板：从 DB 查找
        const allTemplates = getProviderTemplates();
        const tpl = allTemplates.find((t) => t.id === body.agent_provider_template_id);
        if (!tpl) {
          return Errors.badRequest(reply, `模板 ${body.agent_provider_template_id} 不存在`);
        }
        try {
          resolvedProviders = JSON.parse(tpl.providers_json);
        } catch {
          return Errors.internal(reply, "模板配置解析失败");
        }
      }
    }

    // 1. 成本预估（闸门 1）
    const workflow = body.video_workflow || body.image_workflow || "_default";
    const costResult = estimateCost(workflow);

    if (costResult.estimate_cny > body.cost_limit_cny && !body.cost_confirmed) {
      return Errors.costLimitExceeded(
        reply,
        "预估成本超出上限，请确认后重试",
        { cost_estimate: costResult, cost_limit_cny: body.cost_limit_cny, hint: "设置 cost_confirmed: true 以确认执行" },
      );
    }

    // 2. 生成任务 ID 和工作区
    const jobId = `vj-${randomUUID().slice(0, 12)}`;
    const now = Date.now();

    // 3. 写入 video_jobs 表（status: pending）
    const jobRow: VideoJobRow = {
      id: jobId,
      status: "pending",
      input_json: JSON.stringify({
        topic: body.topic,
        image_workflow: body.image_workflow,
        video_workflow: body.video_workflow,
      }),
      cost_estimate_cny: costResult.estimate_cny,
      cost_limit_cny: body.cost_limit_cny,
      agent_providers: resolvedProviders
        ? JSON.stringify(resolvedProviders)
        : null,
      agent_provider_template_id: body.agent_provider_template_id || null,
      created_at: now,
      updated_at: now,
    };
    insertVideoJob(jobRow);

    // 4. WS 推送：任务创建
    emitEvent("video:created", {
      jobId,
      phase: "created",
      status: "pending",
      cost_estimate: costResult,
    });

    // 5. 异步入队执行（不阻塞 HTTP 响应）
    enqueueVideoJob(jobId, async () => {
      try {
        // 构建 CrewConfig
        const crewParams: ShortVideoCrewParams = {
          topic: body.topic,
          agent_providers: resolvedProviders ?? undefined,
        };
        const crewConfig = buildShortVideoCrew(crewParams);
        const agents = buildShortVideoAgents();

        // 使用 applyAllAgentProviders 将模板/用户配置应用到 Agent，
        // 自动从 ProviderStore 补全 apiKey / baseUrl / 能力标记
        if (resolvedProviders) {
          // 过滤掉 null 值（Zod schema 允许为 null 表示"不覆盖"）
          const validProviders: Record<string, AgentProviderOverride> = {};
          for (const [k, v] of Object.entries(resolvedProviders)) {
            if (v) validProviders[k] = v;
          }
          applyAllAgentProviders(agents, validProviders, ctx.providerStore);
        }

        // [CORE-P1-04] 启动前强制校验 Agent 模型有效性：
        // 避免 model="default" 占位符流到 LLM 调用触发 Connection error。
        // throw 后由下方外层 catch 统一写入 video_jobs.status=failed。
        validateVideoCrewModel(agents);

        // 注册 Agent 到 AgentManager
        // FIX: 若 Agent 已存在，必须用 updateAgent 覆盖配置（尤其是 llmProvider），
        // 否则会继续使用上一次 job 的旧 llmProvider（model="default" 无 apiKey → Connection error）。
        for (const agentCfg of agents) {
          if (ctx.agentManager.getAgent(agentCfg.id)) {
            ctx.agentManager.updateAgent(agentCfg.id, agentCfg);
          } else {
            ctx.agentManager.createAgent(agentCfg);
          }
        }

        // WS 推送：任务开始运行
        emitEvent("video:progress", {
          jobId,
          phase: "running",
          status: "running",
          crewId: crewConfig.id,
        });

        // 监听 orchestrator 事件，转发为 video:progress
        const onCollabEvent = (event: Record<string, unknown>) => {
          // 只转发属于此 Crew 的事件
          const eventType = event.type as string;
          if (
            eventType === "task:start" ||
            eventType === "task:complete"
          ) {
            emitEvent("video:progress", {
              jobId,
              phase: eventType,
              taskId: event.taskId,
              taskName: event.taskName,
              status: "running",
            });
          }
        };
        ctx.collaborationOrchestrator.on("collab:event", onCollabEvent);

        // 执行 Crew
        const crewResult = await ctx.collaborationOrchestrator.runCrew(crewConfig);

        // 取消事件监听
        ctx.collaborationOrchestrator.off("collab:event", onCollabEvent);

        // 关键修复：runCrew 失败时不抛异常，而是返回 CrewResult{status:"failed"|"cancelled"}。
        // 必须显式检查 status，否则失败的 crew 会被错误标记为 succeeded。
        if (crewResult.status !== "completed" && crewResult.status !== "partial") {
          // 拋出异常交给下方 catch 块统一处理失败写库
          throw new Error(
            crewResult.error || `Crew 执行未成功 (status=${crewResult.status})`,
          );
        }

        // 成功路径：强校验 + 归档产物到媒体存储
        // [P1-1] 把"没有 final_video_path"和"归档失败"都升级为 failed：
        // 因为 ShortVideoCrew 的最终产物就是一个 mp4，缺了它 = 任务没意义；
        // 之前只记 warn 会导致前端看到 succeeded 却播不了视频。
        let mediaId: string | null = null;
        let finalVideoPath: string | null = null;
        const rawOutputStr = crewResult.finalOutput || "";
        try {
          const parsed = JSON.parse(rawOutputStr);
          finalVideoPath = parsed.final_video_path || null;
        } catch {
          /* finalOutput 可能不是 JSON，保持 finalVideoPath = null */
        }

        // [P1-1] 硬校验 1：必须存在 final_video_path。
        // 覆盖场景：crewResult.status=partial、EditorAgent 输出残缺、finalOutput 非 JSON 等。
        if (!finalVideoPath) {
          throw new Error(
            `视频产物缺失：crewResult 未返回 final_video_path (status=${crewResult.status})`,
          );
        }

        // [P1-1] 硬校验 2：文件必须真实可读且能归档。
        // 覆盖场景：Agent 编造路径、磁盘写入失败、路径字符编码问题等。
        const videoBuffer = await fs.promises.readFile(finalVideoPath);
        const saved = await saveMediaBuffer(
          videoBuffer,
          "video/mp4",
          "outbound",
          VIDEO_MAX_BYTES,
          `video-${jobId}.mp4`,
        );
        mediaId = saved.id;
        app.log.info({ jobId, mediaId, path: saved.path }, "视频产物已归档到媒体存储");

        // 成功：更新 DB
        updateVideoJob(jobId, {
          status: "succeeded",
          output_json: JSON.stringify({
            finalOutput: crewResult.finalOutput,
            taskOutputs: crewResult.taskOutputs,
            workspaceDir: crewResult.workspaceDir,
            mediaId,
          }),
          updated_at: Date.now(),
        });

        // WS 推送：任务完成
        emitEvent("video:completed", {
          jobId,
          phase: "completed",
          status: "succeeded",
          workspaceDir: crewResult.workspaceDir,
        });
      } catch (err: any) {
        // API-P1-03：视频任务失败 —— DB/WS 仅保留通用文案给前端展示，完整栈进服务端日志
        // 说明：error 字段会经 WS 推送并在前端提示，为避免泄露内部实现细节，统一给中性文案
        updateVideoJob(jobId, {
          status: "failed",
          error: "视频任务执行失败，请查看服务端日志定位原因",
          updated_at: Date.now(),
        });

        // WS 推送：任务失败
        emitEvent("video:failed", {
          jobId,
          phase: "failed",
          status: "failed",
          error: "视频任务执行失败",
        });

        app.log.error({ jobId, err }, "视频任务执行失败");
      }
    }).catch((err) => {
      // enqueueVideoJob 本身的错误（极少见）
      app.log.error({ jobId, err: err.message }, "视频任务入队失败");
    });

    // 6. 立即返回任务信息（202 Accepted）
    return sendSuccess(reply, {
      id: jobId,
      status: "pending",
      cost_estimate: costResult,
      message: "视频任务已创建，正在排队执行",
    }, 202);
  });

  // ──────────────────────────────────────────────────────────
  // GET /api/video/jobs — 列表视频任务
  // ──────────────────────────────────────────────────────────
  app.get("/api/video/jobs", async (req, reply) => {
    const parsed = ListVideoJobsSchema.safeParse(req.query);
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { status, limit, offset } = parsed.data;
    const jobs = listVideoJobs({ status, limit, offset });
    return sendSuccess(reply, {
      jobs,
      count: jobs.length,
      limit,
      offset,
    });
  });

  // ──────────────────────────────────────────────────────────
  // GET /api/video/jobs/:id — 获取单个视频任务详情
  // ──────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/video/jobs/:id", async (req, reply) => {
    const { id } = req.params;
    if (!id) return Errors.badRequest(reply, "id is required");

    const job = getVideoJob(id);
    if (!job) {
      return Errors.notFound(reply, "视频任务不存在");
    }
    return sendSuccess(reply, job);
  });

  // ──────────────────────────────────────────────────────────
  // DELETE /api/video/jobs/:id — 取消/删除视频任务
  // ──────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/api/video/jobs/:id", async (req, reply) => {
    const { id } = req.params;
    if (!id) return Errors.badRequest(reply, "id is required");

    const job = getVideoJob(id);
    if (!job) {
      return Errors.notFound(reply, "视频任务不存在");
    }

    // 只有 pending/queued/running 状态可以取消
    if (["pending", "queued", "running"].includes(job.status)) {
      updateVideoJob(id, {
        status: "cancelled",
        error: "用户主动取消",
        updated_at: Date.now(),
      });

      // 如果正在运行，尝试通过 orchestrator 取消
      if (job.status === "running") {
        // 尝试 abort（best-effort，CrewExecutor 可能已完成）
        ctx.collaborationOrchestrator.abort(id);
      }

      // WS 推送：任务取消（归入 video:failed，由 phase="cancelled" 区分）
      emitEvent("video:failed", {
        jobId: id,
        phase: "cancelled",
        status: "cancelled",
      });

      return sendSuccess(reply, { success: true, id, status: "cancelled" });
    }

    // 已完成/已失败/已取消的任务——标记为 deleted（软删除）
    updateVideoJob(id, {
      status: "deleted",
      updated_at: Date.now(),
    });
    return sendSuccess(reply, { success: true, id, status: "deleted" });
  });

  app.log.info("Video routes registered (POST/GET/DELETE /api/video/jobs)");
}
