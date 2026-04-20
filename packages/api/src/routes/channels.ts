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
import type { AppContext } from "../context.js";

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

  app.get("/api/channels", async () => {
    return { channels: Array.from(channels.values()) };
  });

  app.get<{ Params: { id: string } }>("/api/channels/:id", async (request, reply) => {
    const channel = channels.get(request.params.id);
    if (!channel) {
      return reply.status(404).send({ error: "Channel not found" });
    }
    return { channel };
  });

  app.post("/api/channels", async (request, reply) => {
    const parsed = ChannelConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid channel configuration",
        details: parsed.error.flatten(),
      });
    }
    const id = `ch_${crypto.randomUUID().slice(0, 8)}`;
    const channel = { id, config: parsed.data, status: "configuring" as const };
    channels.set(id, channel);
    // B-18: 持久化到 SQLite
    try { saveChannel(channel); } catch { /* best-effort */ }
    return reply.status(201).send({ channel });
  });

  app.delete<{ Params: { id: string } }>("/api/channels/:id", async (request, reply) => {
    if (!channels.delete(request.params.id)) {
      return reply.status(404).send({ error: "Channel not found" });
    }
    // B-18: 从 SQLite 也删除
    try { deleteChannelDB(request.params.id); } catch { /* best-effort */ }
    return { success: true };
  });

  // ===== IM Gateway v2 代理端点（Schema 驱动） =====

  // 通用代理辅助函数
  const proxyGET = async (path: string, reply: any, timeout = 5000) => {
    try {
      const resp = await fetch(`${IM_GATEWAY_URL}${path}`, {
        signal: AbortSignal.timeout(timeout),
        headers: gatewayHeaders(),
      });
      if (!resp.ok) return reply.status(resp.status).send({ error: `Gateway ${resp.status}` });
      return await resp.json();
    } catch (e: any) {
      return reply.status(502).send({ error: "IM Gateway unavailable", detail: e.message });
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
        return reply.status(resp.ok ? 502 : resp.status).send({
          error: `Gateway returned non-JSON (${resp.status})`,
          detail: brief,
        });
      }
      if (!resp.ok) return reply.status(resp.status).send(data);
      return data;
    } catch (e: any) {
      const detail = e.message || "unknown error";
      return reply.status(502).send({ error: `IM Gateway unavailable: ${detail}`, detail });
    }
  };

  // ── 健康 + 运行时 ─────────────────────────────────

  app.get("/api/gateway/health", async (_req, reply) => {
    try {
      const resp = await fetch(`${IM_GATEWAY_URL}/health`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return { status: "offline", error: `Gateway returned ${resp.status}` };
      return await resp.json();
    } catch (e: any) {
      return { status: "offline", error: e.message };
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

  // ── QR 扫码登录（微信等）──────────────────────────

  app.post<{ Params: { channelId: string } }>("/api/gateway/channels/:channelId/qr/start", async (request, reply) => {
    app.log.info({ action: "qr_start", channel: request.params.channelId }, "Proxy: QR login start");
    return proxyPOST(`/api/gateway/channels/${request.params.channelId}/qr/start`, request.body, reply);
  });

  app.get<{ Params: { channelId: string } }>("/api/gateway/channels/:channelId/qr/status", async (request, reply) =>
    proxyGET(`/api/gateway/channels/${request.params.channelId}/qr/status`, reply)
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
    if (!channelId) return reply.status(400).send({ error: "Missing platform" });
    return proxyPOST(`/api/gateway/channels/${channelId}/connect`, {
      credentials: body?.config?.extra || body?.config || {},
    }, reply);
  });

  app.post<{ Params: { platform: string } }>("/api/gateway/disconnect/:platform", async (request, reply) =>
    proxyPOST(`/api/gateway/channels/${request.params.platform}/disconnect`, {}, reply)
  );

  app.post<{ Params: { platform: string } }>("/api/gateway/restart/:platform", async (request, reply) => {
    // 重启 = 断开 + 重连
    app.log.info({ action: "gateway_restart", platform: request.params.platform }, "Proxy: restart channel");
    await proxyPOST(`/api/gateway/channels/${request.params.platform}/disconnect`, {}, reply);
    // TODO: 需要从持久化配置重新连接
    return { status: "restarted", platform: request.params.platform };
  });

  // Health/system info

  // 轻量 ping 端点 — 仅返回 API 存活状态，不调用 Gateway（打破循环依赖）
  app.get("/api/ping", async () => {
    return { status: "ok", uptime: process.uptime() };
  });

  app.get("/api/system/health", async () => {
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
    return {
      status: "ok",
      agents: ctx.agentManager.count,
      skills: ctx.skillLoader.listSkills().length,
      channels: channels.size,
      sessions: ctx.agentManager.listAgents().length,
      gateway: gatewayHealth,
      uptime: process.uptime(),
    };
  });

  app.get("/v1/models", async () => {
    const agents = ctx.agentManager.listAgents();
    return {
      object: "list",
      data: agents.map((a) => ({
        id: a.config.name,
        object: "model",
        created: Math.floor(a.createdAt.getTime() / 1000),
        owned_by: "super-agent",
      })),
    };
  });
}
