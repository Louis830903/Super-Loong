/**
 * Task 3.5 — 知识图谱 REST 端点
 *
 * 暴露 KnowledgeGraph 的三元组 CRUD、子图查询、路径搜索、导出功能。
 *
 *   GET    /api/knowledge/stats              — 三元组统计
 *   GET    /api/knowledge/entities/:name     — 获取实体关系（出边 + 入边）
 *   POST   /api/knowledge/search             — 子图查询（BFS 遍历）
 *   POST   /api/knowledge/path               — 路径搜索（A → B 最短路径）
 *   GET    /api/knowledge/export             — 导出子图（json/mermaid/graphml）
 *   POST   /api/knowledge/triples            — 添加三元组
 *   DELETE /api/knowledge/triples            — 删除三元组
 */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { sendSuccess, Errors } from "./response-helper.js";

// ─── Zod Schemas ──────────────────────────────────────────────

const SubgraphSchema = z.object({
  rootId: z.number().int(),
  maxDepth: z.number().int().min(1).max(10).optional(),
});

const PathSchema = z.object({
  fromId: z.number().int(),
  toId: z.number().int(),
  maxHops: z.number().int().min(1).max(10).optional(),
});

const AddTripleSchema = z.object({
  subjectId: z.number().int(),
  predicate: z.string().min(1),
  objectId: z.number().int(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

const DeleteTripleSchema = z.object({
  tripleId: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
}).refine((d) => d.tripleId || d.source, {
  message: "需要提供 tripleId 或 source 之一",
});

export async function knowledgeGraphRoutes(app: FastifyInstance, ctx: AppContext) {
  const kg = ctx.knowledgeGraph;

  // 所有端点的前置守护：KnowledgeGraph 未初始化时返回 501
  const guard = () => {
    if (!kg) return { error: "KnowledgeGraph 未初始化", code: 501 as const };
    return null;
  };

  // ─── GET /api/knowledge/stats ─────────────────────────────

  app.get("/api/knowledge/stats", async (_req, reply) => {
    const err = guard();
    if (err) return reply.status(err.code).send({ error: err.error });
    return sendSuccess(reply, {
      tripleCount: kg!.countTriples(),
    });
  });

  // ─── GET /api/knowledge/entities/:name ────────────────────

  app.get("/api/knowledge/entities/:name", async (req, reply) => {
    const err = guard();
    if (err) return reply.status(err.code).send({ error: err.error });

    const { name } = req.params as { name: string };
    const entityId = kg!.findEntityId(decodeURIComponent(name));
    if (entityId == null) {
      return Errors.notFound(reply, `实体 "${name}" 不存在`);
    }

    const outgoing = kg!.getOutgoing(entityId);
    const incoming = kg!.getIncoming(entityId);
    return sendSuccess(reply, { entityId, name, outgoing, incoming });
  });

  // ─── POST /api/knowledge/search ───────────────────────────

  app.post("/api/knowledge/search", async (req, reply) => {
    const err = guard();
    if (err) return reply.status(err.code).send({ error: err.error });

    const parsed = SubgraphSchema.safeParse(req.body);
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { rootId, maxDepth } = parsed.data;
    const subgraph = kg!.subgraph(rootId, maxDepth ?? 3);
    return sendSuccess(reply, subgraph);
  });

  // ─── POST /api/knowledge/path ─────────────────────────────

  app.post("/api/knowledge/path", async (req, reply) => {
    const err = guard();
    if (err) return reply.status(err.code).send({ error: err.error });

    const parsed = PathSchema.safeParse(req.body);
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { fromId, toId, maxHops } = parsed.data;
    const pathEdges = kg!.findPath(fromId, toId, maxHops ?? 5);
    return sendSuccess(reply, { path: pathEdges, hops: pathEdges.length });
  });

  // ─── GET /api/knowledge/export ────────────────────────────

  app.get("/api/knowledge/export", async (req, reply) => {
    const err = guard();
    if (err) return reply.status(err.code).send({ error: err.error });

    const query = req.query as { rootId?: string; depth?: string; format?: string };
    const rootId = parseInt(query.rootId ?? "0", 10);
    const depth = parseInt(query.depth ?? "2", 10);
    const format = (query.format ?? "json") as "json" | "mermaid" | "graphml";

    if (!["json", "mermaid", "graphml"].includes(format)) {
      return Errors.badRequest(reply, "format 须为 json、mermaid 或 graphml");
    }

    const result = kg!.exportSubgraph(rootId, depth, format);

    // Mermaid 和 GraphML 返回纯文本
    if (format === "mermaid" || format === "graphml") {
      return reply.type("text/plain").send(result);
    }
    return sendSuccess(reply, JSON.parse(result));
  });

  // ─── POST /api/knowledge/triples ──────────────────────────

  app.post("/api/knowledge/triples", async (req, reply) => {
    const err = guard();
    if (err) return reply.status(err.code).send({ error: err.error });

    const parsed = AddTripleSchema.safeParse(req.body);
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const id = kg!.addTriple(parsed.data);
    return sendSuccess(reply, { id }, 201);
  });

  // ─── DELETE /api/knowledge/triples ────────────────────────

  app.delete("/api/knowledge/triples", async (req, reply) => {
    const err = guard();
    if (err) return reply.status(err.code).send({ error: err.error });

    const parsed = DeleteTripleSchema.safeParse(req.body);
    if (!parsed.success) {
      return Errors.badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
    }

    if (parsed.data.tripleId) {
      const ok = kg!.removeTriple(parsed.data.tripleId);
      return sendSuccess(reply, { deleted: ok ? 1 : 0 });
    } else {
      const count = kg!.removeBySource(parsed.data.source!);
      return sendSuccess(reply, { deleted: count });
    }
  });

  app.log.info("Knowledge graph routes registered (7 endpoints)");
}
