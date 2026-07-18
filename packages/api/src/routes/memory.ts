/**
 * Memory REST API routes.
 *
 * Endpoints:
 *   GET    /api/memory                — List memories (with filters)
 *   POST   /api/memory                — Create a new memory entry
 *   GET    /api/memory/search         — Semantic search memories
 *   GET    /api/memory/stats          — Get memory statistics
 *   GET    /api/memory/:id            — Get a single memory
 *   PUT    /api/memory/:id            — Update a memory
 *   DELETE /api/memory/:id            — Delete a memory
 *   DELETE /api/memory                — Clear memories (with filters)
 *
 * Core Memory:
 *   GET    /api/memory/core/:agentId          — List core blocks
 *   GET    /api/memory/core/:agentId/:label   — Read a core block
 *   PUT    /api/memory/core/:agentId/:label   — Replace a core block
 *   POST   /api/memory/core/:agentId/:label/append — Append to a core block
 */

import type { FastifyInstance } from "fastify";
import { searchMemoriesFTS } from "@super-agent/core";
import type { AppContext } from "../context.js";
import { sendSuccess, Errors } from "./response-helper.js";

export async function memoryRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { memoryManager } = ctx;
  if (!memoryManager) {
    app.log.warn("MemoryManager not available, memory routes disabled");
    return;
  }

  // ─── Archival / Recall Memory ────────────────────────────

  /** List memories */
  app.get<{
    Querystring: { agentId?: string; userId?: string; type?: string; limit?: string };
  }>("/api/memory", async (request, reply) => {
    const { agentId, userId, type, limit } = request.query;
    const entries = await memoryManager.list({
      agentId,
      userId,
      type: type as any,
    });
    const max = parseInt(limit ?? "100", 10);
    return sendSuccess(reply, {
      memories: entries.slice(0, max),
      total: entries.length,
    });
  });

  /** Create a memory entry */
  app.post<{
    Body: { agentId: string; content: string; type?: string; userId?: string; metadata?: Record<string, unknown> };
  }>("/api/memory", async (request, reply) => {
    const { agentId, content, type, userId, metadata } = request.body ?? {};
    if (!agentId || !content) {
      return Errors.badRequest(reply, "agentId and content are required");
    }
    const entry = await memoryManager.add({
      agentId,
      userId,
      content,
      type: (type as any) ?? "archival",
      metadata,
    });
    return sendSuccess(reply, entry, 201);
  });

  /** Semantic search */
  app.get<{
    Querystring: { query: string; agentId?: string; userId?: string; type?: string; topK?: string };
  }>("/api/memory/search", async (request, reply) => {
    const { query, agentId, userId, type, topK } = request.query;
    if (!query) {
      return Errors.badRequest(reply, "query parameter is required");
    }
    const results = await memoryManager.search(
      query,
      { agentId, userId, type: type as any },
      parseInt(topK ?? "10", 10),
    );
    return sendSuccess(reply, { results, total: results.length });
  });

  /** Memory statistics */
  app.get<{
    Querystring: { agentId?: string };
  }>("/api/memory/stats", async (request, reply) => {
    return sendSuccess(reply, memoryManager.stats(request.query.agentId));
  });

  /** Get a single memory */
  app.get<{ Params: { id: string } }>("/api/memory/:id", async (request, reply) => {
    const entry = await memoryManager.get(request.params.id);
    if (!entry) return Errors.notFound(reply, "Memory not found");
    return sendSuccess(reply, entry);
  });

  /** Update a memory */
  app.put<{
    Params: { id: string };
    Body: { content: string; metadata?: Record<string, unknown> };
  }>("/api/memory/:id", async (request, reply) => {
    const { content, metadata } = request.body ?? {};
    if (!content) return Errors.badRequest(reply, "content is required");
    try {
      await memoryManager.update(request.params.id, content, metadata);
      return sendSuccess(reply, { status: "updated", id: request.params.id });
    } catch (err: any) {
      app.log.warn({ id: request.params.id, err }, "Memory update failed");
      return Errors.notFound(reply, "Memory update failed");
    }
  });

  /** Delete a memory */
  app.delete<{ Params: { id: string } }>("/api/memory/:id", async (request, reply) => {
    const ok = await memoryManager.delete(request.params.id);
    if (!ok) return Errors.notFound(reply, "Memory not found");
    return sendSuccess(reply, { status: "deleted" });
  });

  /** Clear memories with filter */
  app.delete<{
    Querystring: { agentId?: string; userId?: string; type?: string };
  }>("/api/memory", async (request, reply) => {
    const { agentId, userId, type } = request.query;
    const count = await memoryManager.clear({ agentId, userId, type: type as any });
    return sendSuccess(reply, { status: "cleared", count });
  });

  // ─── Core Memory ─────────────────────────────────────────

  /** List core blocks for an agent */
  app.get<{ Params: { agentId: string } }>("/api/memory/core/:agentId", async (request, reply) => {
    const blocks = memoryManager.getCoreBlocks(request.params.agentId);
    return sendSuccess(reply, { blocks, agentId: request.params.agentId });
  });

  /** Read a specific core block */
  app.get<{
    Params: { agentId: string; label: string };
  }>("/api/memory/core/:agentId/:label", async (request, reply) => {
    const block = memoryManager.getCoreBlock(request.params.agentId, request.params.label);
    if (!block) return Errors.notFound(reply, "Core block not found");
    return sendSuccess(reply, block);
  });

  /** Replace a core block */
  app.put<{
    Params: { agentId: string; label: string };
    Body: { value: string };
  }>("/api/memory/core/:agentId/:label", async (request, reply) => {
    try {
      const block = memoryManager.updateCoreBlock(
        request.params.agentId,
        request.params.label,
        request.body?.value ?? "",
      );
      return sendSuccess(reply, block);
    } catch (err: any) {
      app.log.warn({ agentId: request.params.agentId, label: request.params.label, err }, "Core block update failed");
      return Errors.badRequest(reply, "Core block update failed");
    }
  });

  /** Append to a core block */
  app.post<{
    Params: { agentId: string; label: string };
    Body: { text: string };
  }>("/api/memory/core/:agentId/:label/append", async (request, reply) => {
    try {
      const block = memoryManager.appendCoreBlock(
        request.params.agentId,
        request.params.label,
        request.body?.text ?? "",
      );
      return sendSuccess(reply, block);
    } catch (err: any) {
      app.log.warn({ agentId: request.params.agentId, label: request.params.label, err }, "Core block append failed");
      return Errors.badRequest(reply, "Core block append failed");
    }
  });

  // ─── FTS5 Full-Text Search ──────────────────────────────

  /** Full-text search memories using FTS5 */
  app.get<{
    Querystring: { q: string; agentId?: string; type?: string; limit?: string };
  }>("/api/memory/fts", async (request, reply) => {
    const { q, agentId, type, limit } = request.query;
    if (!q) {
      return Errors.badRequest(reply, "q parameter is required");
    }
    const results = searchMemoriesFTS(q, {
      agentId,
      type,
      limit: parseInt(limit ?? "50", 10),
    });
    return sendSuccess(reply, { results, total: results.length });
  });

  // C-2: 记忆矛盾检测 REST API（学 Hermes retrieval.py:103-175 contradict）
  app.get<{
    Querystring: { agentId?: string; threshold?: string; limit?: string };
  }>("/api/memory/contradictions", async (request, reply) => {
    const { agentId, threshold, limit } = request.query;
    const contradictions = await memoryManager.contradict(
      agentId ? { agentId } : {},
      parseFloat(threshold ?? "0.3"),
      parseInt(limit ?? "10", 10),
    );
    return sendSuccess(reply, { contradictions, count: contradictions.length });
  });

  // ─── P0-4: 个人知识库归档 ────────────────

  /** 归档一段对话为知识库条目（LLM 提炼结构化） */
  app.post<{
    Body: {
      sessionId: string;
      agentId: string;
      category?: string;
      messages: Array<{ role: string; content: string }>;
    };
  }>("/api/memory/archive", async (request, reply) => {
    const archiver = ctx.knowledgeArchiver;
    if (!archiver) return Errors.serviceUnavailable(reply, "KnowledgeArchiver 未启用");
    const { sessionId, agentId, category, messages } = request.body;
    if (!sessionId || !agentId || !Array.isArray(messages) || messages.length === 0) {
      return Errors.badRequest(reply, "sessionId / agentId / messages 必填，且 messages 非空");
    }
    await archiver.archiveConversation(sessionId, agentId, category ?? "未分类", messages);
    return sendSuccess(reply, { archived: true, sessionId });
  });

  /** 搜索知识库归档条目 */
  app.get<{
    Querystring: { q: string; agentId: string };
  }>("/api/memory/archive/search", async (request, reply) => {
    const archiver = ctx.knowledgeArchiver;
    if (!archiver) return Errors.serviceUnavailable(reply, "KnowledgeArchiver 未启用");
    const { q, agentId } = request.query;
    if (!q || !agentId) return Errors.badRequest(reply, "q / agentId 必填");
    const results = await archiver.searchKnowledge(q, agentId);
    return sendSuccess(reply, { results, total: results.length });
  });

  /** 知识库归档统计（总数 + 分类） */
  app.get<{
    Querystring: { agentId: string };
  }>("/api/memory/archive/stats", async (request, reply) => {
    const archiver = ctx.knowledgeArchiver;
    if (!archiver) return Errors.serviceUnavailable(reply, "KnowledgeArchiver 未启用");
    const { agentId } = request.query;
    if (!agentId) return Errors.badRequest(reply, "agentId 必填");
    const stats = await archiver.getStats(agentId);
    return sendSuccess(reply, stats);
  });

  app.log.info("Memory routes registered");
}
