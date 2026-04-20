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
  }>("/api/memory", async (request) => {
    const { agentId, userId, type, limit } = request.query;
    const entries = await memoryManager.list({
      agentId,
      userId,
      type: type as any,
    });
    const max = parseInt(limit ?? "100", 10);
    return {
      memories: entries.slice(0, max),
      total: entries.length,
    };
  });

  /** Create a memory entry */
  app.post<{
    Body: { agentId: string; content: string; type?: string; userId?: string; metadata?: Record<string, unknown> };
  }>("/api/memory", async (request, reply) => {
    const { agentId, content, type, userId, metadata } = request.body ?? {};
    if (!agentId || !content) {
      return reply.status(400).send({ error: "agentId and content are required" });
    }
    const entry = await memoryManager.add({
      agentId,
      userId,
      content,
      type: (type as any) ?? "archival",
      metadata,
    });
    return reply.status(201).send(entry);
  });

  /** Semantic search */
  app.get<{
    Querystring: { query: string; agentId?: string; userId?: string; type?: string; topK?: string };
  }>("/api/memory/search", async (request, reply) => {
    const { query, agentId, userId, type, topK } = request.query;
    if (!query) {
      return reply.status(400).send({ error: "query parameter is required" });
    }
    const results = await memoryManager.search(
      query,
      { agentId, userId, type: type as any },
      parseInt(topK ?? "10", 10),
    );
    return { results, total: results.length };
  });

  /** Memory statistics */
  app.get<{
    Querystring: { agentId?: string };
  }>("/api/memory/stats", async (request) => {
    return memoryManager.stats(request.query.agentId);
  });

  /** Get a single memory */
  app.get<{ Params: { id: string } }>("/api/memory/:id", async (request, reply) => {
    const entry = await memoryManager.get(request.params.id);
    if (!entry) return reply.status(404).send({ error: "Memory not found" });
    return entry;
  });

  /** Update a memory */
  app.put<{
    Params: { id: string };
    Body: { content: string; metadata?: Record<string, unknown> };
  }>("/api/memory/:id", async (request, reply) => {
    const { content, metadata } = request.body ?? {};
    if (!content) return reply.status(400).send({ error: "content is required" });
    try {
      await memoryManager.update(request.params.id, content, metadata);
      return { status: "updated", id: request.params.id };
    } catch (err: any) {
      return reply.status(404).send({ error: err.message });
    }
  });

  /** Delete a memory */
  app.delete<{ Params: { id: string } }>("/api/memory/:id", async (request, reply) => {
    const ok = await memoryManager.delete(request.params.id);
    if (!ok) return reply.status(404).send({ error: "Memory not found" });
    return { status: "deleted" };
  });

  /** Clear memories with filter */
  app.delete<{
    Querystring: { agentId?: string; userId?: string; type?: string };
  }>("/api/memory", async (request) => {
    const { agentId, userId, type } = request.query;
    const count = await memoryManager.clear({ agentId, userId, type: type as any });
    return { status: "cleared", count };
  });

  // ─── Core Memory ─────────────────────────────────────────

  /** List core blocks for an agent */
  app.get<{ Params: { agentId: string } }>("/api/memory/core/:agentId", async (request) => {
    const blocks = memoryManager.getCoreBlocks(request.params.agentId);
    return { blocks, agentId: request.params.agentId };
  });

  /** Read a specific core block */
  app.get<{
    Params: { agentId: string; label: string };
  }>("/api/memory/core/:agentId/:label", async (request, reply) => {
    const block = memoryManager.getCoreBlock(request.params.agentId, request.params.label);
    if (!block) return reply.status(404).send({ error: "Core block not found" });
    return block;
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
      return block;
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
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
      return block;
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // ─── FTS5 Full-Text Search ──────────────────────────────

  /** Full-text search memories using FTS5 */
  app.get<{
    Querystring: { q: string; agentId?: string; type?: string; limit?: string };
  }>("/api/memory/fts", async (request, reply) => {
    const { q, agentId, type, limit } = request.query;
    if (!q) {
      return reply.status(400).send({ error: "q parameter is required" });
    }
    const results = searchMemoriesFTS(q, {
      agentId,
      type,
      limit: parseInt(limit ?? "50", 10),
    });
    return { results, total: results.length };
  });

  // C-2: 记忆矛盾检测 REST API（学 Hermes retrieval.py:103-175 contradict）
  app.get<{
    Querystring: { agentId?: string; threshold?: string; limit?: string };
  }>("/api/memory/contradictions", async (request) => {
    const { agentId, threshold, limit } = request.query;
    const contradictions = await memoryManager.contradict(
      agentId ? { agentId } : {},
      parseFloat(threshold ?? "0.3"),
      parseInt(limit ?? "10", 10),
    );
    return { contradictions, count: contradictions.length };
  });

  app.log.info("Memory routes registered");
}
