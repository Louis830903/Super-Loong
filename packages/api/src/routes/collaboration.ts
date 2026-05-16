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
 * Execution Control (E-3):
 *   GET    /api/collab/running            — List running tasks
 *   POST   /api/collab/cancel/:taskId     — Cancel a running task
 *
 * SSE (G-2):
 *   GET    /api/collab/events             — Real-time collaboration events
 *
 * General:
 *   GET    /api/collab/stats         — Collaboration system stats
 */

import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import type { CrewResult, GroupChatResult, Attachment } from "@super-agent/core";
import { getCollabOutputsRoot, getWorkspacePath, checkPythonDocLibs } from "@super-agent/core";
import { sendSuccess, Errors } from "./response-helper.js";

// ─── 字符数限制常量（前后端共用同一套数值） ──────────────────────
const LIMITS = {
  CREW_NAME: 100,        // Crew 团队名称
  TASK_DESC: 5000,       // 任务描述（需要足够详细描述复杂任务）
  TASK_OUTPUT: 2000,     // 预期输出
  DESCRIPTION: 2000,     // 通用描述字段
  GC_TOPIC: 200,         // GroupChat 讨论主题
  GC_INITIAL_MSG: 5000,  // GroupChat 初始消息
  GC_SYSTEM_MSG: 5000,   // GroupChat 系统消息
  TERM_KEYWORD: 100,     // 终止关键词
} as const;

// ─── Zod Schemas（含字符数上限校验） ─────────────────────────────

const CrewTaskSchema = z.object({
  id: z.string(),
  description: z.string().max(LIMITS.TASK_DESC),
  expectedOutput: z.string().max(LIMITS.TASK_OUTPUT),
  // agentId 为可选：hierarchical + autoAssign 模式下由 Manager 自动分配
  agentId: z.string().optional(),
  // 可选的能力提示（辅助 Manager 精选现有 Agent 或生成新 Agent 规格）
  requiredCapabilities: z.array(z.string()).optional(),
  context: z.array(z.string()).optional(),
  async: z.boolean().optional(),
});

const RunCrewSchema = z
  .object({
    name: z.string().min(1).max(LIMITS.CREW_NAME),
    description: z.string().max(LIMITS.DESCRIPTION).optional(),
    process: z.enum(["sequential", "hierarchical"]).default("sequential"),
    tasks: z.array(CrewTaskSchema).min(1),
    managerAgentId: z.string().optional(),
    maxRetries: z.number().int().min(0).optional(),
    inputs: z.record(z.string()).optional(),
    taskTimeoutMs: z.number().int().min(5000).max(600000).optional(), // 5s-10min
    // 允许 Manager 自动分配 Agent（仅 hierarchical 生效，默认 false 保持向后兼容）
    autoAssign: z.boolean().optional(),
    // 单次 Crew 最多动态创建的 Agent 数（硬上限 30）
    maxDynamicAgents: z.number().int().min(1).max(30).optional(),
  })
  // P1-3：跨字段约束——autoAssign 仅在 hierarchical + 指定 managerAgentId 时有意义
  .refine(
    (data) => !data.autoAssign || data.process === "hierarchical",
    { message: "autoAssign requires process='hierarchical'", path: ["autoAssign"] },
  )
  .refine(
    (data) => !data.autoAssign || (data.managerAgentId && data.managerAgentId.length > 0),
    { message: "autoAssign requires managerAgentId to be set", path: ["managerAgentId"] },
  )
  // maxDynamicAgents 仅在 autoAssign 开启时有意义（其他场景下被忽略）
  .refine(
    (data) => data.maxDynamicAgents === undefined || data.autoAssign === true,
    { message: "maxDynamicAgents only applies when autoAssign=true", path: ["maxDynamicAgents"] },
  );

const RunGroupChatSchema = z.object({
  name: z.string().min(1).max(LIMITS.GC_TOPIC),
  description: z.string().max(LIMITS.DESCRIPTION).optional(),
  participantIds: z.array(z.string()).min(1),
  speakerSelection: z.enum(["round_robin", "random", "manual", "auto", "graph", "handoff"]).default("round_robin"),
  maxTurns: z.number().int().min(1).default(10),
  terminationKeyword: z.string().max(LIMITS.TERM_KEYWORD).optional(),
  systemMessage: z.string().max(LIMITS.GC_SYSTEM_MSG).optional(),
  moderatorAgentId: z.string().optional(),
  initialMessage: z.string().min(1).max(LIMITS.GC_INITIAL_MSG),
  turnTimeoutMs: z.number().int().min(5000).max(300000).optional(), // 5s-5min
  contextWindowSize: z.number().int().min(5).max(100).optional(), // C-3: 上下文窗口
  maxRetryPerTurn: z.number().int().min(0).max(3).optional(), // F-3: 每轮重试
  manualSpeakerOrder: z.array(z.string()).optional(), // H-2: manual 模式发言顺序
  // I-4: graph 模式配置
  graphConfig: z.object({
    transitions: z.record(z.array(z.string())),
    startAgent: z.string(),
  }).optional(),
});

/** IM 渠道投递参数校验 */
const DeliverSchema = z.object({
  /** 协作结果 ID（crewId 或 chatId） */
  resultId: z.string(),
  /** 目标渠道 ID（如 "feishu"） */
  channelId: z.string(),
  /** 目标聊天 ID */
  chatId: z.string(),
  /** 可选的线程 ID */
  threadId: z.string().optional(),
  /** 是否包含附件（默认 true） */
  includeAttachments: z.boolean().default(true),
});

export async function collaborationRoutes(app: FastifyInstance, ctx: AppContext) {
  // ─── Crew: Task Orchestration ──────────────────────────────

  /** Run a new crew */
  app.post("/api/collab/crew", async (req, reply) => {
    const parsed = RunCrewSchema.safeParse(req.body);
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
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
      // Hierarchical 智能 Agent 分配参数（autoAssign=true 时 Manager 为无 agentId 任务自动匹配或动态创建 Agent）
      autoAssign: body.autoAssign,
      maxDynamicAgents: body.maxDynamicAgents,
    });

    return sendSuccess(reply, result);
  });

  /** Get crew execution history */
  app.get("/api/collab/crew/history", async (_req, reply) => {
    // G-1: 使用 Discriminated Union type 字段替代鸭子类型判断
    const history = ctx.collaborationOrchestrator.getHistory()
      .filter((r) => r.type === "crew");
    return sendSuccess(reply, history);
  });

  // ─── GroupChat: Conversation Negotiation ───────────────────

  /** Start a new group chat */
  app.post("/api/collab/groupchat", async (req, reply) => {
    const parsed = RunGroupChatSchema.safeParse(req.body);
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
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
        maxRetryPerTurn: body.maxRetryPerTurn,
        manualSpeakerOrder: body.manualSpeakerOrder, // H-2: manual 发言顺序
        graphConfig: body.graphConfig, // I-4: graph 模式配置
      },
      body.initialMessage,
    );

    return sendSuccess(reply, result);
  });

  /** Get group chat history */
  app.get("/api/collab/groupchat/history", async (_req, reply) => {
    // G-1: 使用 Discriminated Union type 字段替代鸭子类型判断
    const history = ctx.collaborationOrchestrator.getHistory()
      .filter((r) => r.type === "groupchat");
    return sendSuccess(reply, history);
  });

  // ─── General ───────────────────────────────────────────────

  /** E-3: 获取运行中的任务列表 */
  app.get("/api/collab/running", async (_req, reply) => {
    const tasks = ctx.collaborationOrchestrator.getRunningTasks();
    return sendSuccess(reply, tasks);
  });

  /** E-3: 取消运行中的任务 */
  app.post<{ Params: { taskId: string } }>("/api/collab/cancel/:taskId", async (req, reply) => {
    const { taskId } = req.params;
    if (!taskId || typeof taskId !== "string") {
      return Errors.badRequest(reply, "taskId is required");
    }

    const success = ctx.collaborationOrchestrator.abort(taskId);
    if (success) {
      return sendSuccess(reply, { success: true, taskId });
    } else {
      return Errors.notFound(reply, "Not found or already completed");
    }
  });

  // ─── G-2: SSE 实时进度推送 ──────────────────────────────────

  /** P2 连接管理：最大同时连接数限制 */
  const MAX_SSE_CONNECTIONS = 10;
  const sseConnections = new Set<NodeJS.WritableStream>();

  /**
   * G-2: SSE 端点 — 实时推送协作执行事件。
   * 事件类型：crew:start, crew:complete, crew:error, task:start, task:complete,
   *           groupchat:start, groupchat:complete, groupchat:message
   * P2 修正：最大连接数限制 + 连接关闭清理 + 心跳保活
   */
  app.get("/api/collab/events", async (_req, reply) => {
    // P2: 连接数限制
    if (sseConnections.size >= MAX_SSE_CONNECTIONS) {
      return Errors.serviceUnavailable(reply, "Too many SSE connections");
    }

    // 设置 SSE 响应头
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // Nginx 代理时禁用缓冲
    });

    const raw = reply.raw;
    sseConnections.add(raw);

    // 发送初始连接确认
    raw.write(`data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`);

    // 监听 orchestrator 的 collab:event 事件
    const onEvent = (event: Record<string, unknown>) => {
      try {
        raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // 写入失败（连接已关闭），静默处理
      }
    };

    ctx.collaborationOrchestrator.on("collab:event", onEvent);

    // P2: 心跳保活（每 15 秒发送一次注释行，防止代理/浏览器超时断开）
    const heartbeat = setInterval(() => {
      try {
        raw.write(`: heartbeat\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);

    // 连接关闭时清理
    const cleanup = () => {
      ctx.collaborationOrchestrator.off("collab:event", onEvent);
      clearInterval(heartbeat);
      sseConnections.delete(raw);
    };

    _req.raw.on("close", cleanup);
    _req.raw.on("error", cleanup);
  });

  /** Unified collaboration history with pagination (C-4) */
  app.get("/api/collab/history", async (req, reply) => {
    const page = Math.max(1, Number((req.query as any).page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number((req.query as any).pageSize) || 20));
    const type = (req.query as any).type as string | undefined;
    const validType = type === "crew" || type === "groupchat" ? type : undefined;

    const { results, total } = ctx.collaborationOrchestrator.getHistoryPaginated(page, pageSize, validType);
    return sendSuccess(reply, { results, total, page, pageSize });
  });

  /** Collaboration stats */
  app.get("/api/collab/stats", async (_req, reply) => {
    return sendSuccess(reply, ctx.collaborationOrchestrator.getStats());
  });

  // ─── 附件下载端点 ─────────────────────────────────────────────

  /** MIME 类型推断（轻量内联，无需额外依赖） */
  const MIME_MAP: Record<string, string> = {
    ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
    ".json": "application/json", ".txt": "text/plain", ".md": "text/markdown",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
    ".pdf": "application/pdf", ".zip": "application/zip",
    ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".wav": "audio/wav",
    ".csv": "text/csv", ".xml": "application/xml",
  };

  /**
   * S-1 安全修复：白名单限制 + symlink 逃逸检查
   * M-3 修复：文件大小上限
   * R-1 修正：ALLOWED_ROOTS 包含 DATA_DIR，覆盖 Agent 产出目录
   */
  const ALLOWED_ROOTS = [
    path.resolve(process.cwd()),                                                  // 工作目录（含 Agent workspace）
    path.resolve(process.env.TEMP ?? (process.platform === "win32" ? "C:\\Temp" : "/tmp")), // 临时目录
    path.resolve(process.env.COLLAB_FILES_DIR || process.cwd()),                   // 可选的协作文件目录
    path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data")),        // 数据目录（Agent 产出可能存于此）
    getCollabOutputsRoot(),                                                        // ★ 工作空间产出目录（最小权限：只放行 collab-outputs/）
  ].filter((root, i, arr) => root && arr.indexOf(root) === i); // 去重

  /** 单文件最大下载大小：100MB */
  const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024;

  /**
   * 按文件路径下载协作任务产出的附件。
   * 安全校验：白名单目录 + symlink 逃逸检查 + 文件大小限制。
   */
  app.get("/api/collab/attachment", async (req, reply) => {
    const filePath = (req.query as Record<string, string>).path;
    if (!filePath) {
      return Errors.badRequest(reply, "path query parameter is required");
    }

    const resolved = path.resolve(filePath);

    // S-1 修复：白名单校验 — 文件必须在允许的根目录之下
    const isAllowed = ALLOWED_ROOTS.some(root => resolved.startsWith(root + path.sep) || resolved === root);
    if (!isAllowed) {
      app.log.warn({ filePath, resolved }, "Collab attachment: path outside allowed roots");
      return Errors.forbidden(reply, "Path not within allowed directories");
    }

    // S-1 修复：symlink 逃逸检查 — 解析符号链接后再次验证
    let realPath: string;
    try {
      realPath = await fs.promises.realpath(resolved);
    } catch {
      return Errors.notFound(reply, "File not found or not readable");
    }
    const isRealAllowed = ALLOWED_ROOTS.some(root => realPath.startsWith(root + path.sep) || realPath === root);
    if (!isRealAllowed) {
      app.log.warn({ filePath, resolved, realPath }, "Collab attachment: symlink escape detected");
      return Errors.forbidden(reply, "Symlink target not within allowed directories");
    }

    // M-3 修复：文件大小限制
    const stat = await fs.promises.stat(realPath);
    if (!stat.isFile()) {
      return Errors.badRequest(reply, "Path is not a file");
    }
    if (stat.size > MAX_DOWNLOAD_SIZE) {
      return reply.status(413).send({ error: `File too large (${stat.size} bytes, max ${MAX_DOWNLOAD_SIZE})` });
    }

    // P1 安全加固：敏感文件名黑名单，禁止下载 .env / .db / .sqlite 等配置文件
    const SENSITIVE_FILENAME_PATTERNS = [/^\.env$/, /\.db$/i, /\.sqlite$/i, /\.sqlite3$/i,
      /^credentials\./i, /\.pem$/i, /^id_rsa/i, /^id_ed25519/i];
    const filename = path.basename(realPath);
    if (SENSITIVE_FILENAME_PATTERNS.some(p => p.test(filename))) {
      app.log.warn({ filename, realPath }, "Collab attachment: blocked sensitive file");
      return Errors.forbidden(reply, "Access to sensitive files is forbidden");
    }
    const ext = path.extname(realPath).toLowerCase();
    const mime = MIME_MAP[ext] ?? "application/octet-stream";

    // 使用 realPath（已解析 symlink 的真实路径）进行流式传输
    return reply
      .header("Content-Type", mime)
      .header("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`)
      .header("Content-Length", stat.size)
      .send(fs.createReadStream(realPath));
  });

  // ─── IM 渠道投递端点（Phase 2: 修复 B6 — 协作模块与 IM 网关零集成） ───

  /**
   * POST /api/collab/deliver
   * 将已完成的协作结果（文本摘要 + 产出文件）投递到指定 IM 渠道。
   * 通过 HTTP 调用 IM 网关的内部投递端点，低耦合松集成（原则 6）。
   */
  app.post("/api/collab/deliver", async (req, reply) => {
    const parsed = DeliverSchema.safeParse(req.body);
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map(i => i.message).join("; "));
    }
    const { resultId, channelId, chatId, threadId, includeAttachments } = parsed.data;

    // 1. 从内存历史中查找协作结果
    const result = ctx.collaborationOrchestrator.getResultById(resultId);
    if (!result) {
      return Errors.notFound(reply, "Collaboration result not found");
    }

    // 2. 构造投递内容（A-1 修复：使用 Discriminated Union type narrowing 替代 as any）
    const summary = result.type === "crew"
      ? (result as CrewResult).finalOutput
      : (result as GroupChatResult).summary ?? "";
    const allAttachments = includeAttachments
      ? (result.allAttachments ?? [])
      : [];

    const deliverText = `[协作任务完成] ${result.name}\n\n${summary.slice(0, 2000)}`;

    // 3. 通过 HTTP 调用 IM 网关的内部投递端点（松耦合，网关不可用只返回错误）
    const gatewayUrl = process.env.IM_GATEWAY_URL ?? "http://localhost:8765";
    try {
      const resp = await fetch(`${gatewayUrl}/internal/deliver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_id: channelId,
          chat_id: chatId,
          thread_id: threadId ?? "",
          text: deliverText,
          attachments: allAttachments.map((att: Attachment) => ({
            path: att.path ?? "",
            filename: att.filename ?? "",
            mime_type: att.mimeType ?? "",
          })),
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "Unknown error");
        app.log.warn({ status: resp.status, body: errBody }, "IM gateway deliver failed");
        const respPayload: Record<string, unknown> = { error: "IM gateway delivery failed" };
        if (process.env.NODE_ENV !== "production") {
          respPayload.detail = errBody;
        }
        return reply.status(502).send(respPayload);
      }

      const deliverResult = await resp.json() as Record<string, unknown>;
      return sendSuccess(reply, { success: true, ...deliverResult });
    } catch (err: any) {
      // API-P1-03：IM 网关异常栈仅进日志，响应体移除 detail，避免暴露内部信息
      app.log.warn({ err }, "IM gateway unreachable");
      return Errors.serviceUnavailable(reply, "IM gateway unreachable");
    }
  });

  app.log.info("Collaboration routes registered (core)");

  // ─── ZIP 打包下载端点 ─────────────────────────────────

  /** ZIP 单文件最大大小：500MB */
  const MAX_ZIP_SIZE = 500 * 1024 * 1024;
  /** 递归深度限制 */
  const MAX_ZIP_DEPTH = 5;
  /** 排除的目录/文件 */
  const ZIP_EXCLUDES = new Set([".zip", "node_modules", ".git"]);

  /**
   * GET /api/collab/download/:id
   * 按需打包协作工作空间为 ZIP 文件下载。
   * 安全约束：白名单校验 + symlink 检查 + 文件大小限制 + 递归深度限制。
   */
  app.get<{ Params: { id: string } }>("/api/collab/download/:id", async (req, reply) => {
    const { id } = req.params;
    if (!id) return Errors.badRequest(reply, "id is required");

    // 1. 获取协作结果
    const result = ctx.collaborationOrchestrator.getResultById(id);
    // P1-3 修复：CrewResult 和 GroupChatResult 都已定义 workspaceDir，无需 as any
    let workspaceDir = result?.workspaceDir;

    // 2. v2.2 fallback：如果 DB 中无 workspaceDir，尝试文件系统查询
    if (!workspaceDir) {
      workspaceDir = getWorkspacePath(id);
    }

    if (!workspaceDir) {
      return Errors.notFound(reply, "未找到工作空间目录");
    }

    // 3. 白名单二次校验：工作空间必须在 collab-outputs/ 下
    const collabRoot = getCollabOutputsRoot();
    const resolvedWs = path.resolve(workspaceDir);
    if (!resolvedWs.startsWith(collabRoot + path.sep) && resolvedWs !== collabRoot) {
      app.log.warn({ workspaceDir, collabRoot }, "ZIP download: path outside collab-outputs");
      return Errors.forbidden(reply, "Path not within allowed directories");
    }

    // 4. 目录存在性检查
    try {
      const stat = await fs.promises.stat(resolvedWs);
      if (!stat.isDirectory()) {
        return Errors.notFound(reply, "工作空间路径不是目录");
      }
    } catch {
      return Errors.notFound(reply, "工作空间目录不存在");
    }

    // 5. Symlink 检查
    let realWsPath: string;
    try {
      realWsPath = await fs.promises.realpath(resolvedWs);
    } catch {
      return Errors.notFound(reply, "工作空间路径不可读");
    }
    if (!realWsPath.startsWith(collabRoot + path.sep) && realWsPath !== collabRoot) {
      app.log.warn({ resolvedWs, realWsPath }, "ZIP download: symlink escape detected");
      return Errors.forbidden(reply, "Symlink target not within allowed directories");
    }

    // 6. 使用 jszip 递归打包
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    let totalSize = 0;

    /**
     * 递归添加目录内文件到 ZIP。
     * 根据安全约束排除 .zip、node_modules、.git，限制深度和大小。
     */
    async function addDirToZip(dirPath: string, zipFolder: any, depth: number): Promise<void> {
      if (depth > MAX_ZIP_DEPTH) return;

      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        // 排除规则
        if (ZIP_EXCLUDES.has(entry.name) || ZIP_EXCLUDES.has(path.extname(entry.name).toLowerCase())) {
          continue;
        }

        const fullPath = path.join(dirPath, entry.name);

        // Symlink 检查：解析后确认仍在白名单内
        let realPath: string;
        try {
          realPath = await fs.promises.realpath(fullPath);
        } catch {
          continue; // 无法解析的路径跳过
        }
        if (!realPath.startsWith(collabRoot + path.sep) && realPath !== collabRoot) {
          continue; // symlink 逃逸，跳过
        }

        if (entry.isDirectory()) {
          await addDirToZip(fullPath, zipFolder.folder(entry.name)!, depth + 1);
        } else if (entry.isFile()) {
          const stat = await fs.promises.stat(fullPath);
          totalSize += stat.size;
          if (totalSize > MAX_ZIP_SIZE) {
            throw new Error(`ZIP 打包超过大小限制 (${MAX_ZIP_SIZE} bytes)`);
          }
          const content = await fs.promises.readFile(fullPath);
          zipFolder.file(entry.name, content);
        }
      }
    }

    try {
      await addDirToZip(realWsPath, zip, 0);
    } catch (err: any) {
      // API-P1-03：ZIP 打包失败（大小超限或 IO 异常）仅日志，响应体给通用业务提示
      app.log.warn({ err, workspaceDir: realWsPath }, "ZIP packaging failed");
      return reply.status(413).send({ error: "ZIP 打包失败或超出大小限制" });
    }

    // 7. 生成 ZIP 流并流式返回（P2-2：避免全量加载到内存导致 OOM）
    const zipStream = zip.generateNodeStream({ type: "nodebuffer", compression: "DEFLATE", streamFiles: true });
    const zipFilename = `${id}.zip`;

    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${encodeURIComponent(zipFilename)}"`)
      .send(zipStream);
  });

  // ─── Python 文档生成环境检测端点 ─────────────────────

  /**
   * GET /api/collab/env-check
   * 返回 Python 文档生成库的可用状态。
   */
  app.get("/api/collab/env-check", async (_req, reply) => {
    const result = await checkPythonDocLibs();
    return sendSuccess(reply, result);
  });

  // P2-4: 日志移到所有端点注册完成之后
  app.log.info("Collaboration routes registered (all endpoints including download & env-check)");
}
