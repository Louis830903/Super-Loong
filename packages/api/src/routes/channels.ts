/**
 * Channel Routes — IM channel management.
 *
 * GET  /api/channels         — List all channels and their status
 * GET  /api/channels/:id     — Get channel details
 * POST /api/channels         — Configure a new channel
 * PUT  /api/channels/:id     — Update channel config
 * DELETE /api/channels/:id   — Remove a channel
 * POST /api/channels/:id/test — Test channel connectivity
 */

import type { FastifyInstance } from "fastify";
import { ChannelConfigSchema, saveChannel, loadChannels, deleteChannel as deleteChannelDB } from "@super-agent/core";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { sendSuccess, sendError, Errors } from "./response-helper.js";

// B-18: 从 SQLite 加载已持久化的 channel 配置
const channels = new Map<string, { id: string; config: Record<string, unknown>; status: string }>();
function loadChannelsFromDB() {
  try {
    const saved = loadChannels();
    for (const ch of saved) channels.set(ch.id, ch);
  } catch { /* DB might not be initialized */ }
}
loadChannelsFromDB();

export async function channelRoutes(app: FastifyInstance, ctx: AppContext) {
  // 延迟读取：确保 dotenv.config() 已在 main() 中执行后再取值
  // 模块作用域变量会在 dotenv 加载前被求值，导致始终回退默认值
  const IM_GATEWAY_URL = process.env.IM_GATEWAY_URL || "http://localhost:8642";
  const IM_GATEWAY_API_KEY = process.env.IM_GATEWAY_API_KEY || "";

  // 安全加固：构建带 API Key 的请求头
  const gatewayHeaders = (): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (IM_GATEWAY_API_KEY) h["x-api-key"] = IM_GATEWAY_API_KEY;
    return h;
  };

  app.get("/api/channels", async (_req, reply) => {
    return sendSuccess(reply, { channels: Array.from(channels.values()) });
  });

  app.get<{ Params: { id: string } }>("/api/channels/:id", async (request, reply) => {
    const channel = channels.get(request.params.id);
    if (!channel) {
      return Errors.notFound(reply, "Channel not found");
    }
    return sendSuccess(reply, { channel });
  });

  app.post("/api/channels", async (request, reply) => {
    const parsed = ChannelConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return Errors.badRequest(reply, "Invalid channel configuration", parsed.error.flatten());
    }
    const id = `ch_${randomUUID().slice(0, 8)}`;
    const channel = { id, config: parsed.data, status: "configuring" as const };
    channels.set(id, channel);
    // B-18: 持久化到 SQLite
    try { saveChannel(channel); } catch { /* best-effort */ }
    return sendSuccess(reply, { channel }, 201);
  });

  app.delete<{ Params: { id: string } }>("/api/channels/:id", async (request, reply) => {
    if (!channels.delete(request.params.id)) {
      return Errors.notFound(reply, "Channel not found");
    }
    // B-18: 从 SQLite 也删除
    try { deleteChannelDB(request.params.id); } catch { /* best-effort */ }
    return sendSuccess(reply, { success: true });
  });

  // ===== IM Gateway v2 代理端点（Schema 驱动） =====

  // 通用代理辅助函数
  const proxyGET = async (path: string, reply: any, timeout = 5000) => {
    try {
      const resp = await fetch(`${IM_GATEWAY_URL}${path}`, {
        signal: AbortSignal.timeout(timeout),
        headers: gatewayHeaders(),
      });
      if (!resp.ok) return sendError(reply, resp.status, "GATEWAY_ERROR", `Gateway ${resp.status}`);
      return sendSuccess(reply, await resp.json());
    } catch (e: any) {
      // API-P1-03：Gateway 异常仅进日志，响应体不回显内部错误详情
      reply.log.warn({ path, err: e }, "IM Gateway proxyGET failed");
      return Errors.badGateway(reply, "IM Gateway unavailable");
    }
  };

  const proxyPOST = async (path: string, body: unknown, reply: any, timeout = 30000) => {
    try {
      const resp = await fetch(`${IM_GATEWAY_URL}${path}`, {
        method: "POST",
        headers: gatewayHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      // 先读取原始文本，再尝试解析 JSON，避免非 JSON 响应触发 SyntaxError
      const text = await resp.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        // Gateway 返回了非 JSON（如纯文本 500 "Internal Server Error"）
        const brief = text.length > 200 ? text.slice(0, 200) + "..." : text;
        return sendError(
          reply,
          resp.ok ? 502 : resp.status,
          "GATEWAY_NON_JSON",
          `Gateway returned non-JSON (${resp.status})`,
          brief,
        );
      }
      if (!resp.ok) return sendError(reply, resp.status, "GATEWAY_ERROR", `Gateway returned ${resp.status}`, data);
      return sendSuccess(reply, data);
    } catch (e: any) {
      // API-P1-03：Gateway 异常仅进日志，响应体不回显内部错误详情
      reply.log.warn({ path, err: e }, "IM Gateway proxyPOST failed");
      return Errors.badGateway(reply, "IM Gateway unavailable");
    }
  };

  // ── 健康 + 运行时 ─────────────────────────────────

  app.get("/api/gateway/health", async (_req, reply) => {
    try {
      const resp = await fetch(`${IM_GATEWAY_URL}/health`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return sendSuccess(reply, { status: "offline", error: `Gateway returned ${resp.status}` });
      return sendSuccess(reply, await resp.json());
    } catch (e: any) {
      // API-P1-03：连接异常栈仅进日志，响应体给通用离线状态
      app.log.warn({ err: e }, "IM Gateway health check failed");
      return sendSuccess(reply, { status: "offline", error: "Gateway unreachable" });
    }
  });

  app.get("/api/gateway/runtime", async (_req, reply) => proxyGET("/runtime", reply));

  // ── Schema 驱动配置（v2 新增）──────────────────────

  // 返回所有渠道的配置 Schema — 前端据此自动渲染表单
  app.get("/api/gateway/channels/schemas", async (_req, reply) =>
    proxyGET("/api/gateway/channels/schemas", reply)
  );

  // 列出所有渠道及其连接状态
  app.get("/api/gateway/channels/list", async (_req, reply) =>
    proxyGET("/api/gateway/channels", reply)
  );

  // ── 渠道连接/断开（v2）─────────────────────────────

  app.post<{ Params: { channelId: string } }>("/api/gateway/channels/:channelId/connect", async (request, reply) => {
    app.log.info({ action: "channel_connect", channel: request.params.channelId }, "Proxy: connect channel");
    return proxyPOST(`/api/gateway/channels/${request.params.channelId}/connect`, request.body, reply);
  });

  app.post<{ Params: { channelId: string } }>("/api/gateway/channels/:channelId/disconnect", async (request, reply) => {
    app.log.info({ action: "channel_disconnect", channel: request.params.channelId }, "Proxy: disconnect channel");
    return proxyPOST(`/api/gateway/channels/${request.params.channelId}/disconnect`, {}, reply);
  });

  // ── 渠道状态查询（v2）─────────────────────────────

  app.get<{ Params: { channelId: string } }>("/api/gateway/channels/:channelId/status", async (request, reply) =>
    proxyGET(`/api/gateway/channels/${request.params.channelId}/status`, reply)
  );

  // ── Doctor 配置诊断（v2）───────────────────────────

  app.get<{ Params: { channelId: string } }>("/api/gateway/channels/:channelId/doctor", async (request, reply) =>
    proxyGET(`/api/gateway/channels/${request.params.channelId}/doctor`, reply)
  );

  // ── Setup 配置向导（v2）───────────────────────────

  app.post<{ Params: { channelId: string } }>("/api/gateway/channels/:channelId/setup", async (request, reply) => {
    app.log.info({ action: "channel_setup", channel: request.params.channelId }, "Proxy: channel setup");
    return proxyPOST(`/api/gateway/channels/${request.params.channelId}/setup`, request.body, reply);
  });

  // ── Security 安全审计（v2）─────────────────────────

  app.get<{ Params: { channelId: string } }>("/api/gateway/channels/:channelId/security", async (request, reply) =>
    proxyGET(`/api/gateway/channels/${request.params.channelId}/security`, reply)
  );

  // ── 兼容旧 API（逐步废弃）─────────────────────────

  app.get("/api/gateway/platforms", async (_req, reply) => proxyGET("/platforms", reply));

  app.get("/api/gateway/adapters", async (_req, reply) =>
    proxyGET("/api/gateway/channels", reply)  // 转发到新端点
  );

  app.post("/api/gateway/connect", async (request, reply) => {
    // 兼容旧格式：{platform, config} → 新格式：/channels/{id}/connect {credentials}
    const body = request.body as any;
    const channelId = body?.platform;
    if (!channelId) return Errors.badRequest(reply, "Missing platform");
    return proxyPOST(`/api/gateway/channels/${channelId}/connect`, {
      credentials: body?.config?.extra || body?.config || {},
    }, reply);
  });

  app.post<{ Params: { platform: string } }>("/api/gateway/disconnect/:platform", async (request, reply) =>
    proxyPOST(`/api/gateway/channels/${request.params.platform}/disconnect`, {}, reply)
  );

  app.post<{ Params: { platform: string } }>("/api/gateway/restart/:platform", async (request, reply) => {
    const { platform } = request.params;
    app.log.info({ action: "gateway_restart", platform }, "Restarting channel");

    // 1. 断开现有连接（直接 fetch，不通过 proxyPOST 避免 reply 竞争）
    try {
      await fetch(`${IM_GATEWAY_URL}/api/gateway/channels/${platform}/disconnect`, {
        method: "POST",
        headers: gatewayHeaders(),
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err: any) {
      app.log.warn({ platform, error: err.message }, "Disconnect failed during restart, continuing");
    }

    // 2. 从持久化 Map 获取连接配置（B-18 已实现 SQLite 持久化 + 启动时 loadFromDB）
    const channelConfig = channels.get(platform);
    if (!channelConfig?.config || Object.keys(channelConfig.config).length === 0) {
      return Errors.badRequest(reply,
        `No saved configuration for platform "${platform}". Cannot restart without config.`);
    }

    // 3. 使用持久化配置重新连接
    try {
      const connectRes = await fetch(`${IM_GATEWAY_URL}/api/gateway/channels/${platform}/connect`, {
        method: "POST",
        headers: gatewayHeaders(),
        body: JSON.stringify({ credentials: channelConfig.config }),
        signal: AbortSignal.timeout(10000),
      });
      const connectData: any = await connectRes.json();
      return sendSuccess(reply, { status: "restarted", platform, connection: connectData });
    } catch (err: any) {
      // API-P1-03：reconnect 异常栈仅进日志，响应体不拼接底层错误信息
      app.log.error({ platform, err }, "Reconnect failed during restart");
      return Errors.badGateway(reply, "Restart failed: disconnect OK but reconnect failed");
    }
  });

  // Health/system info

  // 轻量 ping 端点 — 仅返回 API 存活状态，不调用 Gateway（打破循环依赖）
  app.get("/api/ping", async (_req, reply) => {
    return sendSuccess(reply, { status: "ok", uptime: process.uptime() });
  });

  app.get("/api/system/health", async (_req, reply) => {
    let gatewayStatus = "offline";
    let gatewayHealth: Record<string, unknown> = {};
    try {
      const gw = await fetch(`${IM_GATEWAY_URL}/health`, { signal: AbortSignal.timeout(3000) });
      const gwData: any = await gw.json();
      gatewayStatus = gwData.status || "unknown";
      // 包含运行时和健康详情
      gatewayHealth = {
        status: gatewayStatus,
        version: gwData.version,
        api_connection: gwData.api_connection,
        channel_count: gwData.channel_count,
        active_sessions: gwData.active_sessions,
        channels: gwData.channels,
        health: gwData.health,
        reconnect: gwData.reconnect,
      };
    } catch {}
    return sendSuccess(reply, {
      status: "ok",
      agents: ctx.agentManager.count,
      skills: ctx.skillLoader.listSkills().length,
      channels: channels.size,
      sessions: ctx.agentManager.listAgents().length,
      gateway: gatewayHealth,
      uptime: process.uptime(),
    });
  });

  app.get("/v1/models", async (_req, reply) => {
    const agents = ctx.agentManager.listAgents();
    return sendSuccess(reply, {
      object: "list",
      data: agents.map((a) => ({
        id: a.config.name,
        object: "model",
        created: Math.floor(a.createdAt.getTime() / 1000),
        owned_by: "super-agent",
      })),
    });
  });

  // ─── Task 4.1: 路由绑定管理（MessageRouter 渠道 → Agent 映射）─────────

  const BindingSchema = z.object({
    channelId: z.string().min(1),
    agentId: z.string().min(1),
    chatId: z.string().optional(),
  });

  // 列出所有路由绑定
  app.get("/api/router/bindings", async (_req, reply) => {
    return sendSuccess(reply, { bindings: ctx.router.listBindings() });
  });

  // 添加路由绑定
  app.post("/api/router/bindings", async (req, reply) => {
    const parsed = BindingSchema.safeParse(req.body);
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    // 验证 Agent 存在
    const agent = ctx.agentManager.getAgent(parsed.data.agentId);
    if (!agent) {
      return Errors.notFound(reply, `Agent not found: ${parsed.data.agentId}`);
    }
    ctx.router.addBinding(parsed.data);
    return sendSuccess(reply, { success: true, binding: parsed.data }, 201);
  });

  // 删除路由绑定
  app.delete("/api/router/bindings", async (req, reply) => {
    const body = (req.body ?? {}) as { channelId?: string; agentId?: string };
    if (!body.channelId || !body.agentId) {
      return Errors.badRequest(reply, "需要提供 channelId 和 agentId");
    }
    ctx.router.removeBinding(body.channelId, body.agentId);
    return sendSuccess(reply, { success: true });
  });

  app.log.info("Route binding management endpoints registered (Task 4.1)");
}
