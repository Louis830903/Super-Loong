/**
 * WebSocket module for real-time event streaming.
 *
 * Provides:
 * - Event bus (pub/sub) for platform events
 * - WebSocket server at /ws for client subscriptions
 * - Topic-based filtering (e.g. "agent:*", "session:start")
 * - Heartbeat / keep-alive
 */

import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import type { PlatformEventType, PlatformEvent } from "@super-agent/core";
import type { AppContext } from "../context.js";
import { requirePermission } from "../auth/index.js";

// ─── Event Bus ───────────────────────────────────────────────

type EventHandler = (event: PlatformEvent) => void;

class EventBus {
  private listeners = new Map<string, Set<EventHandler>>();

  /** Subscribe to events matching a topic pattern (supports trailing wildcard) */
  on(topic: string, handler: EventHandler): () => void {
    if (!this.listeners.has(topic)) {
      this.listeners.set(topic, new Set());
    }
    this.listeners.get(topic)!.add(handler);
    return () => this.listeners.get(topic)?.delete(handler);
  }

  /** Emit an event, notifying all matching subscribers */
  emit(event: PlatformEvent): void {
    for (const [topic, handlers] of this.listeners) {
      if (this.matches(topic, event.type)) {
        for (const handler of handlers) {
          try {
            handler(event);
          } catch {
            // Ignore subscriber errors
          }
        }
      }
    }
  }

  /** Check if an event type matches a subscription topic */
  private matches(topic: string, eventType: string): boolean {
    if (topic === "*") return true;
    if (topic.endsWith(":*")) {
      return eventType.startsWith(topic.slice(0, -1));
    }
    return topic === eventType;
  }

  /** Number of active subscriptions */
  get size(): number {
    let count = 0;
    for (const handlers of this.listeners.values()) count += handlers.size;
    return count;
  }
}

// Singleton event bus
let _eventBus: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!_eventBus) _eventBus = new EventBus();
  return _eventBus;
}

/** Helper to emit a platform event from anywhere */
export function emitEvent(type: PlatformEventType, data: Record<string, unknown> = {}): void {
  getEventBus().emit({ type, timestamp: new Date(), data });
}

// ─── WebSocket Client Tracking ───────────────────────────────

interface WsClient {
  id: string;
  socket: WebSocket;
  topics: Set<string>;
  connectedAt: Date;
  lastPingAt: Date;
}

const clients = new Map<string, WsClient>();

// ─── Register WebSocket Server ───────────────────────────────

export async function registerWebSocket(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Register the Fastify WebSocket plugin
  await app.register(websocket);

  const bus = getEventBus();

  // B-20: 保存 listener 引用，以便在 onClose 时移除
  const onAgentCreated = (agentState: any) => {
    emitEvent("agent:start", { agentId: agentState.id, name: agentState.config?.name });
  };
  const onAgentUpdated = (agentState: any) => {
    emitEvent("agent:updated", { agentId: agentState.id, name: agentState.config?.name });
  };
  const onAgentDeleted = (id: string) => {
    emitEvent("agent:stop", { agentId: id });
  };

  // Wire up AgentManager events to the event bus
  ctx.agentManager.on("agent:created", onAgentCreated);
  ctx.agentManager.on("agent:updated", onAgentUpdated);
  ctx.agentManager.on("agent:deleted", onAgentDeleted);

  // WebSocket endpoint
  app.get("/ws", { websocket: true }, (socket: WebSocket, request) => {
    const clientId = crypto.randomUUID();
    const client: WsClient = {
      id: clientId,
      socket,
      topics: new Set(["*"]),
      connectedAt: new Date(),
      lastPingAt: new Date(),
    };
    clients.set(clientId, client);

    app.log.info({ clientId, total: clients.size }, "WebSocket client connected");

    // Send welcome message
    send(socket, {
      type: "connected",
      clientId,
      serverTime: new Date().toISOString(),
    });

    // Subscribe client to event bus
    const unsubscribe = bus.on("*", (event) => {
      // Check if client is interested in this event
      const interested = client.topics.has("*") ||
        [...client.topics].some((t) => {
          if (t.endsWith(":*")) return event.type.startsWith(t.slice(0, -1));
          return t === event.type;
        });

      if (interested) {
        send(socket, {
          type: "event",
          event: {
            type: event.type,
            timestamp: event.timestamp.toISOString(),
            data: event.data,
          },
        });
      }
    });

    // Handle incoming messages from client
    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleClientMessage(client, msg, app);
      } catch {
        send(socket, { type: "error", message: "Invalid JSON" });
      }
    });

    // Handle pong for keep-alive
    socket.on("pong", () => {
      client.lastPingAt = new Date();
    });

    // Cleanup on disconnect
    socket.on("close", () => {
      unsubscribe();
      clients.delete(clientId);
      app.log.info({ clientId, total: clients.size }, "WebSocket client disconnected");
    });

    socket.on("error", (err) => {
      app.log.warn({ clientId, err: err.message }, "WebSocket error");
    });
  });

  // Heartbeat interval (every 30s)
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [id, client] of clients) {
      // Drop stale clients (no pong in 90s)
      if (now - client.lastPingAt.getTime() > 90_000) {
        client.socket.terminate();
        clients.delete(id);
        continue;
      }
      try {
        client.socket.ping();
      } catch {
        clients.delete(id);
      }
    }
  }, 30_000);

  app.addHook("onClose", () => {
    clearInterval(heartbeat);
    // B-20: 移除 AgentManager 事件监听器
    ctx.agentManager.off("agent:created", onAgentCreated);
    ctx.agentManager.off("agent:updated", onAgentUpdated);
    ctx.agentManager.off("agent:deleted", onAgentDeleted);
    for (const client of clients.values()) {
      client.socket.close(1001, "Server shutting down");
    }
    clients.clear();
  });

  // REST endpoint to check WS status
  app.get("/api/ws/status", async () => ({
    clients: clients.size,
    subscriptions: bus.size,
    connections: [...clients.values()].map((c) => ({
      id: c.id,
      topics: [...c.topics],
      connectedAt: c.connectedAt.toISOString(),
    })),
  }));

  // REST endpoint to broadcast an event (admin use)
  // P0-A6: 添加 RBAC 认证，广播事件需要 admin 权限
  app.post<{
    Body: { type: PlatformEventType; data?: Record<string, unknown> };
  }>("/api/ws/broadcast", {
    preHandler: requirePermission("*"),
  }, async (request) => {
    const { type, data } = request.body ?? {};
    if (!type) return { error: "Event type required" };
    emitEvent(type, data ?? {});
    return { status: "broadcasted", clients: clients.size };
  });

  app.log.info("WebSocket server registered at /ws");

  // ─── IM Gateway 专用 WebSocket 端点 ──────────────────────
  // 替代 HTTP POST /api/chat，支持流式响应
  // 协议: Gateway→API { type:"chat", requestId, agentId, sessionId, message, metadata }
  //        API→Gateway { type:"chunk", requestId, data } / { type:"done", requestId } / { type:"error", requestId, error }
  // 鉴权: WebSocket 握手时通过 Authorization header 携带 Bearer Token
  app.get("/ws/gateway", { websocket: true }, (socket: WebSocket, request) => {
    // ── 鉴权检查：验证 Gateway 身份（与 HTTP 路径的 api_key 一致）──
    const authHeader = request.headers["authorization"] || "";
    const expectedKey = process.env.API_KEY || process.env.AUTH_SECRET || "";
    if (expectedKey) {
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== expectedKey) {
        app.log.warn("IM Gateway WebSocket 鉴权失败: token 不匹配");
        send(socket, { type: "error", error: "Unauthorized: invalid or missing API key" });
        socket.close(4001, "Unauthorized");
        return;
      }
    }

    app.log.info("IM Gateway WebSocket connected");

    socket.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: "error", message: "Invalid JSON" });
        return;
      }

      // 心跳
      if (msg.type === "ping") {
        send(socket, { type: "pong", serverTime: new Date().toISOString() });
        return;
      }

      // 聊天消息 — 路由到 Agent 并流式返回
      if (msg.type === "chat") {
        const { requestId, agentId, sessionId, message: userMsg, metadata } = msg;

        // 允许空 message（图片/文件/音频消息），但 requestId 和 agentId 仍必填
        if (!requestId || !agentId) {
          send(socket, { type: "error", requestId, error: "Missing required fields: requestId, agentId" });
          return;
        }

        // ── P0: 幂等性去重检查（学习 Hermes MessageDeduplicator，共享缓存跨 WS/HTTP 生效） ──
        if (ctx.dedup.isSeen(requestId)) {
          app.log.info({ requestId }, "WS dedup hit: skipping duplicate message");
          send(socket, {
            type: "error",
            requestId,
            error: "Duplicate request \u2014 already processing or completed",
            code: "DEDUP_HIT",
          });
          return;
        }
        // 立即标记为已处理，防止并发重复
        ctx.dedup.markSeen(requestId);

        const agent = ctx.agentManager.getAgent(agentId);
        if (!agent) {
          send(socket, { type: "error", requestId, error: `Agent not found: ${agentId}` });
          return;
        }

        try {
          const convId = sessionId || `gw-${requestId}`;
          let fullContent = "";
          const attachments: unknown[] = [];

          // B-5: 从 metadata 提取 images 传递给 chatStream
          // 兼容 Python IM Gateway 的 mime_type（snake_case）和前端的 mimeType（camelCase）
          const rawImages = metadata?.images as Array<Record<string, unknown>> | undefined;
          const images = rawImages?.map(img => ({
            data: img.data as string,
            mimeType: (img.mimeType as string) || (img.mime_type as string) || "image/png",
          }));

          for await (const event of agent.chatStream(userMsg, convId, {
            signal: undefined,
            images,
          })) {
            if (socket.readyState !== 1) break; // 连接已断开

            // 累积内容用于幂等性缓存
            if (typeof event === "string") {
              fullContent += event;
            } else if (event && typeof event === "object") {
              const ev = event as Record<string, unknown>;
              if (ev.content && typeof ev.content === "string") fullContent += ev.content;
              if (ev.type === "attachment") attachments.push(ev);
            }

            send(socket, { type: "chunk", requestId, data: event });
          }

          if (socket.readyState === 1) {
            send(socket, { type: "done", requestId, response: fullContent, attachments });
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          if (socket.readyState === 1) {
            send(socket, { type: "error", requestId, error: errMsg });
          }
        }
        return;
      }

      send(socket, { type: "error", message: `Unknown message type: ${msg.type}` });
    });

    socket.on("close", () => {
      app.log.info("IM Gateway WebSocket disconnected");
    });

    socket.on("error", (err) => {
      app.log.warn({ err: err.message }, "IM Gateway WebSocket error");
    });
  });

  app.log.info("Gateway WebSocket endpoint registered at /ws/gateway");
}

// ─── Client Message Handling ─────────────────────────────────

function handleClientMessage(client: WsClient, msg: any, app: FastifyInstance): void {
  switch (msg.action) {
    case "subscribe": {
      const topics = Array.isArray(msg.topics) ? msg.topics : [msg.topics];
      for (const t of topics) {
        if (typeof t === "string") client.topics.add(t);
      }
      send(client.socket, {
        type: "subscribed",
        topics: [...client.topics],
      });
      break;
    }

    case "unsubscribe": {
      const topics = Array.isArray(msg.topics) ? msg.topics : [msg.topics];
      for (const t of topics) client.topics.delete(t);
      send(client.socket, {
        type: "unsubscribed",
        topics: [...client.topics],
      });
      break;
    }

    case "ping":
      send(client.socket, { type: "pong", serverTime: new Date().toISOString() });
      break;

    default:
      send(client.socket, { type: "error", message: `Unknown action: ${msg.action}` });
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function send(socket: WebSocket, data: unknown): void {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(data));
  }
}
