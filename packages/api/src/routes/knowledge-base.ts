/**
 * 知识库 REST 路由（知识库 Spec §8.1 / T8）。
 *
 * 6 个端点：
 *   POST   /api/kb/documents      — base64 上传 → ingestDocument → 入库
 *   GET    /api/kb/documents      — 列表（支持 agentId/userId/status/limit/offset）
 *   GET    /api/kb/documents/:id  — 单文档详情（含 chunkCount）
 *   DELETE /api/kb/documents/:id  — 删除（级联 chunks）
 *   POST   /api/kb/search         — 混合检索（vector + BM25）
 *   GET    /api/kb/stats          — 全量统计（文档数/分块数/字节数）
 *
 * 设计要点：
 *   1. embedder 从 AppContext 注入（与 memoryManager 同源），统一 Key/维度
 *   2. agentId / userId 双 nullable 隔离模型（Spec 决策 #2）
 *      — 请求未传 → undefined = 不限；显式 null → 严格匹配 NULL
 *      HTTP 语义下约定：query "agentId=__null__" 表示 null，缺省表示 undefined
 *   3. 上传走 base64 + bodyLimit 30MB（与 files.ts 一致），避免 multipart 依赖
 *   4. ingestDocument 已带去重：duplicated/skipped 原样透传
 *   5. 所有错误返回 4xx/5xx + { error: string }，与其他路由对齐
 */

import type { FastifyInstance } from "fastify";
import {
  countDocuments,
  deleteDocument,
  getDocument,
  ingestDocument,
  listChunksByDoc,
  listDocuments,
  searchHybrid,
  type KBDocStatus,
  type KBDocumentFilter,
  type KBEmbedder,
} from "@super-agent/core";
import type { AppContext } from "../context.js";
import path from "node:path";
import { sendSuccess, sendError, Errors } from "./response-helper.js";

// ─── 常量 ────────────────────────────────────────────────

/** 允许上传的文件扩展名白名单（Spec §T3） */
const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".html", ".pdf", ".docx", ".xlsx", ".pptx", ".csv", ".tsv", ".log"]);

/** 单次上传文件大小上限 20MB（与 files.ts 对齐） */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** body 体积上限 30MB（base64 编码有 ~33% 膨胀） */
const BODY_LIMIT = 30 * 1024 * 1024;
/** 列表查询默认分页 */
const DEFAULT_LIMIT = 50;
/** 列表查询硬上限 */
const MAX_LIMIT = 200;
/** 搜索默认 topK */
const DEFAULT_SEARCH_TOPK = 5;
/** 搜索硬上限 */
const MAX_SEARCH_TOPK = 50;

// ─── 辅助函数 ────────────────────────────────────────────

/**
 * 解析 agentId / userId 的三态：
 *   - undefined      → undefined（不限）
 *   - "__null__" / "" → null（严格匹配 NULL）
 *   - 其他字符串     → 等值匹配
 */
function parseIsolation(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === "" || v === "__null__") return null;
  return v;
}

/** 校验 status 字符串是否是合法 KBDocStatus */
function parseStatus(v: string | undefined): KBDocStatus | undefined {
  if (!v) return undefined;
  const valid: KBDocStatus[] = ["pending", "parsing", "chunking", "embedding", "indexed", "failed"];
  return valid.includes(v as KBDocStatus) ? (v as KBDocStatus) : undefined;
}

/** 把 AppContext.embedder（EmbeddingProvider 结构）安全转成 KBEmbedder */
function asKbEmbedder(ctxEmbedder: AppContext["embedder"]): KBEmbedder {
  // EmbeddingProvider 与 KBEmbedder 结构兼容：embed(text) → Promise<number[]>，embeddingType 一致。
  // 禁止在别处新增 as unknown as KBEmbedder；长期应让 EmbeddingProvider 显式实现接口。
  return ctxEmbedder as unknown as KBEmbedder;
}

// ─── 路由实现 ─────────────────────────────────────────────

export async function knowledgeBaseRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const embedder = asKbEmbedder(ctx.embedder);

  /**
   * POST /api/kb/documents
   * Body: { filename, data (base64), mime?, agentId?, userId?, metadata? }
   * Returns: { document, duplicated, skipped, chunkCount }
   */
  app.post<{
    Body: {
      filename: string;
      data: string;
      mime?: string;
      agentId?: string | null;
      userId?: string | null;
      metadata?: Record<string, unknown>;
    };
  }>("/api/kb/documents", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const { filename, data, mime, agentId, userId, metadata } = request.body ?? {};

    if (!filename || !data) {
      return Errors.badRequest(reply, "filename and data (base64) are required");
    }

    // 解码 base64
    let buffer: Buffer;
    try {
      buffer = Buffer.from(data, "base64");
    } catch {
      return Errors.badRequest(reply, "Invalid base64 data");
    }

    if (buffer.length === 0) {
      return Errors.badRequest(reply, "Empty file buffer after base64 decode");
    }
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return sendError(reply, 413, "PAYLOAD_TOO_LARGE",
        `文件过大 (${(buffer.length / 1024 / 1024).toFixed(1)}MB)，最大支持 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`);
    }

    // 校验文件类型白名单（防 exe/dll/sh 等危险格式上传）
    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return Errors.badRequest(reply, `Unsupported file type: ${ext}`);
    }

    try {
      const result = await ingestDocument({
        buffer,
        filename,
        mime,
        embedder,
        agentId: agentId ?? null,
        userId: userId ?? null,
        metadata,
        // 知识库 Spec §T7：注入 Docling sidecar 客户端（未启用时为 undefined，pipeline 将不做降级）
        docling: ctx.kbParserClient,
        onDoclingFallback: (ev) => {
          app.log.info(
            { filename, reason: ev.reason, tsError: ev.tsError.message },
            "KB parse fallback to Docling sidecar",
          );
        },
      });
      app.log.info(
        {
          docId: result.document.id,
          filename,
          size: buffer.length,
          status: result.document.status,
          duplicated: result.duplicated,
          skipped: result.skipped,
          chunkCount: result.chunks.length,
        },
        "KB document ingested",
      );
      return sendSuccess(reply, {
        document: result.document,
        duplicated: result.duplicated,
        skipped: result.skipped,
        chunkCount: result.chunks.length,
      }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ filename, error: msg }, "KB ingest failed");
      return Errors.internal(reply,
        process.env.NODE_ENV === "production" ? "知识库录入失败" : `Ingestion failed: ${msg}`);
    }
  });

  /**
   * GET /api/kb/documents
   * Query: agentId? userId? status? limit? offset?
   * Returns: { documents: KBDocument[], total: number }
   */
  app.get<{
    Querystring: {
      agentId?: string;
      userId?: string;
      status?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/kb/documents", async (request, reply) => {
    const q = request.query;
    const filter: KBDocumentFilter = {
      agentId: parseIsolation(q.agentId),
      userId: parseIsolation(q.userId),
      status: parseStatus(q.status),
    };
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(q.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
    const offset = Math.max(0, parseInt(q.offset ?? "0", 10) || 0);

    const documents = listDocuments(filter, { limit, offset });
    const total = countDocuments(filter);
    return sendSuccess(reply, { documents, total, limit, offset });
  });

  /**
   * GET /api/kb/documents/:id
   * Returns: { document, chunkCount }
   */
  app.get<{
    Params: { id: string };
  }>("/api/kb/documents/:id", async (request, reply) => {
    const { id } = request.params;
    const document = getDocument(id);
    if (!document) {
      return Errors.notFound(reply, `Document not found: ${id}`);
    }
    const chunks = listChunksByDoc(id);
    return sendSuccess(reply, {
      document,
      chunkCount: chunks.length,
    });
  });

  /**
   * DELETE /api/kb/documents/:id
   * Returns: { deleted: true }
   */
  app.delete<{
    Params: { id: string };
  }>("/api/kb/documents/:id", async (request, reply) => {
    const { id } = request.params;
    const existed = deleteDocument(id);
    if (!existed) {
      return Errors.notFound(reply, `Document not found: ${id}`);
    }
    app.log.info({ docId: id }, "KB document deleted");
    return sendSuccess(reply, { deleted: true });
  });

  /**
   * POST /api/kb/search
   * Body: { query, agentId?, userId?, topK?, docIds? }
   * Returns: { hits: RetrievedChunk[], count }
   */
  app.post<{
    Body: {
      query: string;
      agentId?: string | null;
      userId?: string | null;
      topK?: number;
      docIds?: string[];
      maxTokens?: number;
    };
  }>("/api/kb/search", async (request, reply) => {
    const { query, agentId, userId, topK, docIds, maxTokens } = request.body ?? {};
    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return Errors.badRequest(reply, "query is required");
    }

    const k = Math.min(MAX_SEARCH_TOPK, Math.max(1, topK ?? DEFAULT_SEARCH_TOPK));
    try {
      const hits = await searchHybrid({
        query,
        embedder,
        agentId: agentId === undefined ? undefined : agentId,
        userId: userId === undefined ? undefined : userId,
        topK: k,
        docIds,
        maxTokens,
      });
      return sendSuccess(reply, {
        hits,
        count: hits.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ query, error: msg }, "KB search failed");
      return Errors.internal(reply,
        process.env.NODE_ENV === "production" ? "搜索失败" : `Search failed: ${msg}`);
    }
  });

  /**
   * GET /api/kb/stats
   * Query: agentId? userId?
   * Returns: { documentCount, indexedCount, failedCount, totalBytes, totalChunks }
   */
  app.get<{
    Querystring: {
      agentId?: string;
      userId?: string;
    };
  }>("/api/kb/stats", async (request, reply) => {
    const agentId = parseIsolation(request.query.agentId);
    const userId = parseIsolation(request.query.userId);

    const baseFilter: KBDocumentFilter = { agentId, userId };
    const documentCount = countDocuments(baseFilter);
    const indexedCount = countDocuments({ ...baseFilter, status: "indexed" });
    const failedCount = countDocuments({ ...baseFilter, status: "failed" });

    // 按范围累计 size + chunkCount（一次性拉所有 doc 列表，v1 阶段可接受）
    // 注意：listDocuments 默认 limit=50，需要显式传大 limit
    const allDocs = listDocuments(baseFilter, { limit: 10000, offset: 0 });
    let totalBytes = 0;
    let totalChunks = 0;
    for (const d of allDocs) {
      totalBytes += d.size;
      // 只对 indexed 文档统计分块数（避免扫 pending）
      if (d.status === "indexed") {
        totalChunks += listChunksByDoc(d.id).length;
      }
    }

    return sendSuccess(reply, {
      documentCount,
      indexedCount,
      failedCount,
      totalBytes,
      totalChunks,
    });
  });
}
