/**
 * Chat Routes — conversation and messaging endpoints.
 *
 * POST /api/chat             — Send a message to an agent (returns full response)
 * POST /api/chat/stream      — Send a message with streaming response (SSE)
 *
 * Conversation persistence endpoints:
 * GET    /api/conversations              — List conversations for an agent
 * POST   /api/conversations              — Create a new conversation
 * GET    /api/conversations/:id/messages — Get messages with pagination
 * DELETE /api/conversations/:id          — Delete a conversation
 * PATCH  /api/conversations/:id          — Update conversation title
 * GET    /api/conversations/search       — FTS5 full-text search
 *
 * Legacy session endpoints (kept for backwards compat):
 * GET  /api/sessions         — List sessions for an agent
 * GET  /api/sessions/:id     — Get session details and history
 * DELETE /api/sessions/:id   — Delete a session
 *
 * OpenAI-compatible endpoints:
 * POST /v1/chat/completions  — OpenAI Chat Completions format
 */

import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  ChatMessageSchema,
  searchSessionsFTS,
  createConversation,
  listConversations,
  getConversation,
  getConvMessages,
  deleteConversation,
  updateConversationTitle,
  updateConversationModel,
  searchConvMessages,
  getProviderById,
  getModelById,
} from "@super-agent/core";
import type { AppContext } from "../context.js";
import { SEEN_NO_RESPONSE } from "../shared/dedup.js";

export async function chatRoutes(app: FastifyInstance, ctx: AppContext) {
  // ─── 使用共享去重模块（传输层无关，WS/HTTP 共用同一实例） ───
  const dedup = ctx.dedup;

  // Send a message (non-streaming)
  app.post("/api/chat", async (request, reply) => {
    const parsed = ChatMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid message",
        details: parsed.error.flatten(),
      });
    }

    const { agentId, sessionId, message } = parsed.data;

    // ── 幂等性检查：requestId 去重（共享缓存，WS/HTTP 互通） ──
    const requestId = (request.body as Record<string, unknown>)?.requestId as string | undefined;
    if (requestId) {
      const cached = dedup.check(requestId);
      if (cached !== undefined && cached !== SEEN_NO_RESPONSE) {
        app.log.info({ requestId }, "Dedup hit: returning cached response");
        return cached;
      }
      if (cached === SEEN_NO_RESPONSE) {
        // 已被 WS 路径处理过 → 短路返回（WS 已流式响应给 Gateway）
        app.log.info({ requestId }, "Dedup hit: already processed via WS");
        return reply.status(200).send({ message: "Already processed", requestId });
      }
    }

    const agent = ctx.agentManager.getAgent(agentId);
    if (!agent) {
      return reply.status(404).send({ error: "Agent not found" });
    }

    try {
      const result = await agent.chat(message, sessionId);
      const response = {
        sessionId: result.sessionId,
        response: result.response,
        toolCalls: result.toolCalls,
        attachments: result.attachments ?? [],
      };

      // 缓存成功响应（供重试去重使用，共享缓存跨 WS/HTTP 生效）
      if (requestId) {
        dedup.record(requestId, response);
      }

      return response;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: errMsg });
    }
  });

  // Send a message with SSE streaming
  // Accepts conversationId (preferred) or sessionId (legacy) — auto-creates conversation if neither provided
  app.post("/api/chat/stream", async (request, reply) => {
    const parsed = ChatMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid message",
        details: parsed.error.flatten(),
      });
    }

    const { agentId, message } = parsed.data;
    const body = request.body as Record<string, unknown>;
    // Support both conversationId and sessionId
    let convId = (body.conversationId as string) || parsed.data.sessionId;
    // 提取图片数据（与 WS gateway ws/index.ts 保持一致）
    const metadata = body.metadata as Record<string, unknown> | undefined;
    const images = metadata?.images as Array<{ data: string; mimeType: string }> | undefined;
    const agent = ctx.agentManager.getAgent(agentId);
    if (!agent) {
      return reply.status(404).send({ error: "Agent not found" });
    }

    // Auto-create a new conversation if no ID provided
    if (!convId) {
      convId = `conv-${crypto.randomUUID()}`;
      try { createConversation(convId, agentId); } catch { /* may exist */ }
    }

    // ── Per-conversation model override (immutable — no global state mutation) ──
    // Inspired by Letta model_copy(update=...) pattern: build an override config
    // and pass it to chatStream() instead of mutating the agent's global LLM config.
    let llmOverride: Record<string, unknown> | undefined;
    try {
      const conv = getConversation(convId);
      if (conv?.modelOverride) {
        // Parse "providerId:modelId" format, e.g. "moonshot:kimi-k2-0711-preview"
        const [providerId, modelId] = conv.modelOverride.includes(":")
          ? conv.modelOverride.split(":", 2)
          : [null, conv.modelOverride];

        // Look up provider config
        const providerRecord = providerId ? ctx.providerStore.get(providerId) : null;
        const providerDef = providerId ? getProviderById(providerId) : null;
        const modelDef = providerId && modelId ? getModelById(providerId, modelId) : null;

        if (providerRecord?.apiKey || providerDef) {
          llmOverride = {
            type: "openai" as const,
            model: modelId || conv.modelOverride,
            apiKey: providerRecord?.apiKey || (agent.config as any).llmProvider?.apiKey,
            baseUrl: providerRecord?.baseUrl || providerDef?.baseUrl || (agent.config as any).llmProvider?.baseUrl,
          };
          if (modelDef?.fixedTemperature !== undefined) {
            llmOverride.temperature = modelDef.fixedTemperature;
          }
          app.log.info({ convId, model: conv.modelOverride }, "Applying per-conversation model override (immutable)");
        }
      }
    } catch { /* best-effort — continue with default model */ }

    // 合并 Fastify 中间件（含 CORS）已设置的响应头与 SSE 头
    // reply.raw.writeHead 会绕过 Fastify 响应管道，必须手动合并
    reply.raw.writeHead(200, {
      ...reply.getHeaders(),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Abort LLM call when client disconnects (e.g. frontend 120s timeout)
    // IMPORTANT: Listen on reply.raw (ServerResponse), NOT request.raw (IncomingMessage).
    // Fastify consumes POST body eagerly, which can fire request.raw "close" prematurely
    // before the SSE stream even begins, causing instant abort.
    const ac = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) {
        ac.abort();
      }
    });

    // Send conversationId as the first event so frontend knows the ID
    reply.raw.write(`data: ${JSON.stringify({ conversationId: convId })}\n\n`);

    try {
      for await (const event of agent.chatStream(message, convId, { llmOverride, signal: ac.signal, images })) {
        if (ac.signal.aborted) break;
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (!ac.signal.aborted) reply.raw.write(`data: [DONE]\n\n`);
    } catch (error) {
      if (!ac.signal.aborted) {
        const errMsg = error instanceof Error ? error.message : String(error);
        reply.raw.write(
          `data: ${JSON.stringify({ error: errMsg })}\n\n`
        );
      }
    }
    reply.raw.end();
  });

  // OpenAI-compatible chat completions
  app.post("/v1/chat/completions", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: string }>;
    const model = (body.model as string) ?? "default";
    const stream = body.stream === true;

    if (!messages?.length) {
      return reply.status(400).send({ error: "messages is required" });
    }

    // Use the first available agent or match by model name
    const agents = ctx.agentManager.listAgents();
    const targetAgent = agents.find((a) => a.config.name === model) ?? agents[0];
    if (!targetAgent) {
      return reply.status(404).send({ error: "No agent available" });
    }

    const agent = ctx.agentManager.getAgent(targetAgent.id);
    if (!agent) {
      return reply.status(404).send({ error: "Agent not found" });
    }

    const lastMessage = messages[messages.length - 1];

    // Inject prior messages into a deterministic session so multi-turn context is preserved
    const sessionId = `openai-compat-${targetAgent.id}`;
    const session = agent.getSession(sessionId);
    // Replace session messages with the full conversation history (except the last user msg)
    session.messages = messages.slice(0, -1).map((m) => ({
      role: m.role as "user" | "assistant" | "system" | "tool",
      content: m.content,
    }));

    if (stream) {
      // 合并 Fastify 中间件（含 CORS）已设置的响应头与 SSE 头
      reply.raw.writeHead(200, {
        ...reply.getHeaders(),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // P0-A12: 添加 AbortController，客户端断开时取消 LLM 调用
      const ac = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) {
          ac.abort();
        }
      });

      const id = `chatcmpl-${Date.now()}`;
      try {
        for await (const chunk of agent.chatStream(lastMessage.content, sessionId, { signal: ac.signal })) {
          if (ac.signal.aborted) break;
          const sseData = {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: { content: chunk },
                finish_reason: null,
              },
            ],
          };
          reply.raw.write(`data: ${JSON.stringify(sseData)}\n\n`);
        }
      } catch (error) {
        if (!ac.signal.aborted) {
          const errMsg = error instanceof Error ? error.message : String(error);
          reply.raw.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
        }
      }

      if (!ac.signal.aborted) {
        reply.raw.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`
        );
        reply.raw.write(`data: [DONE]\n\n`);
      }
      reply.raw.end();
      return;
    }

    // Non-streaming
    const result = await agent.chat(lastMessage.content, sessionId);
    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.response },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  });

  // ─── Conversation Persistence Endpoints ────────────────────

  /** List conversations for an agent */
  app.get<{ Querystring: { agentId?: string } }>("/api/conversations", async (request, reply) => {
    const { agentId } = request.query;
    if (!agentId) {
      return reply.status(400).send({ error: "agentId is required" });
    }
    const conversations = listConversations(agentId);
    return { conversations };
  });

  /** Create a new conversation */
  app.post("/api/conversations", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const agentId = body.agentId as string;
    if (!agentId) {
      return reply.status(400).send({ error: "agentId is required" });
    }
    const id = `conv-${crypto.randomUUID()}`;
    const conversation = createConversation(id, agentId, (body.title as string) || undefined);
    return { conversation };
  });

  /** Get messages for a conversation (with pagination) */
  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>(
    "/api/conversations/:id/messages",
    async (request, reply) => {
      const conv = getConversation(request.params.id);
      if (!conv) {
        return reply.status(404).send({ error: "Conversation not found" });
      }
      const limit = parseInt(request.query.limit ?? "50", 10);
      const before = request.query.before ? parseInt(request.query.before, 10) : undefined;
      const messages = getConvMessages(request.params.id, { limit, before });
      return { messages, conversationId: request.params.id, total: conv.messageCount };
    }
  );

  /** Delete a conversation */
  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const conv = getConversation(request.params.id);
    if (!conv) {
      return reply.status(404).send({ error: "Conversation not found" });
    }
    deleteConversation(request.params.id);
    return { success: true };
  });

  /** Update conversation (title and/or modelOverride) */
  app.patch<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const conv = getConversation(request.params.id);
    if (!conv) {
      return reply.status(404).send({ error: "Conversation not found" });
    }

    if (typeof body.title === "string" && body.title) {
      updateConversationTitle(request.params.id, body.title);
    }

    if (body.modelOverride !== undefined) {
      // null or "" clears the override, string sets it
      const model = body.modelOverride ? (body.modelOverride as string) : null;
      updateConversationModel(request.params.id, model);
    }

    if (!body.title && body.modelOverride === undefined) {
      return reply.status(400).send({ error: "title or modelOverride is required" });
    }

    return { success: true, conversation: getConversation(request.params.id) };
  });

  /** FTS5 search across conversation messages */
  app.get<{
    Querystring: { q: string; agentId?: string; limit?: string };
  }>("/api/conversations/search", async (request, reply) => {
    const { q, agentId, limit } = request.query;
    if (!q) {
      return reply.status(400).send({ error: "q parameter is required" });
    }
    const results = searchConvMessages(q, {
      agentId,
      limit: parseInt(limit ?? "30", 10),
    });
    return { results, total: results.length };
  });

  // ─── Legacy Session Endpoints ─────────────────────────────

  // List sessions for an agent
  app.get<{ Querystring: { agentId?: string } }>("/api/sessions", async (request) => {
    const { agentId } = request.query;
    if (!agentId) {
      return { sessions: [] };
    }
    const agent = ctx.agentManager.getAgent(agentId);
    if (!agent) {
      return { sessions: [] };
    }
    return { sessions: agent.listSessions() };
  });

  // Get session details
  app.get<{ Params: { id: string }; Querystring: { agentId: string } }>(
    "/api/sessions/:id",
    async (request, reply) => {
      const agent = ctx.agentManager.getAgent(request.query.agentId);
      if (!agent) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const session = agent.findSession(request.params.id);
      if (!session) {
        return reply.status(404).send({ error: "Session not found" });
      }
      return { session };
    }
  );

  // Delete a session
  app.delete<{ Params: { id: string }; Querystring: { agentId: string } }>(
    "/api/sessions/:id",
    async (request, reply) => {
      const agent = ctx.agentManager.getAgent(request.query.agentId);
      if (!agent) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const deleted = agent.deleteSession(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: "Session not found" });
      }
      return { success: true };
    }
  );

  // ─── FTS5 Cross-Session Search ─────────────────────────

  /** Full-text search across sessions */
  app.get<{
    Querystring: { q: string; agentId?: string; limit?: string };
  }>("/api/sessions/search", async (request, reply) => {
    const { q, agentId, limit } = request.query;
    if (!q) {
      return reply.status(400).send({ error: "q parameter is required" });
    }
    const results = searchSessionsFTS(q, {
      agentId,
      limit: parseInt(limit ?? "50", 10),
    });
    return { results, total: results.length };
  });
}
