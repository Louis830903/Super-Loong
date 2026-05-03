/**
 * 知识库 ingestion 流水线（知识库 Spec §5.4 / T4）。
 *
 * 职责：把一份原始文件按以下五步走完，每步都更新 kb_documents.status：
 *
 *   upload → hash 去重 → parse → chunk → embed(批 32) → insertChunks
 *
 * 状态机（Spec §5 定义的 KBDocStatus）：
 *   pending → parsing → chunking → embedding → indexed   （成功路径）
 *   {任一步} → failed + error 字段                         （失败路径）
 *
 * 去重策略（决策 #3：同 user 内去重）：
 *   - 计算 SHA-256 content_hash
 *   - findDocumentByHash(hash, userId) 命中：
 *       · status=indexed / embedding / chunking / parsing / pending → 直接返回已有文档（skipped=true）
 *       · status=failed   → 用同一 id 重跑（覆盖 status / chunks）
 *   - 未命中：新建 doc，进入状态机
 *
 * 并发队列（决策 #5：固定并发 3）：
 *   - createIngestionQueue(concurrency=3) 返回 { enqueue(opts) }
 *   - 内部用轻量 semaphore 实现（与 collaboration/agent-matcher.ts mapLimit 同源）
 *   - 不引入 p-limit 外部依赖
 *
 * 解耦：
 *   - embedder 通过参数注入（KBEmbedder 接口），不直接依赖 core/memory
 *   - parser / chunker 通过 parser/index.ts、chunker/index.ts 的公共入口调用
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash, randomUUID } from "node:crypto";

import type { KBChunk, KBDocStatus, KBDocument } from "../types.js";
import {
  findDocumentByHash,
  getDocument,
  insertChunks,
  insertDocument,
  listChunksByDoc,
  updateDocument,
  deleteChunksByDoc,
} from "../storage/kb-repo.js";
import { parseWithFallback } from "../parser/router.js";
import type { DoclingClient } from "../parser/parser-docling.js";
import { chunkParseResult } from "../chunker/index.js";
import { embedChunks, type KBEmbedder } from "../storage/vector-index.js";

// ─── 入参 / 出参类型 ─────────────────────────────────────

/** 单次 ingestion 入参 */
export interface IngestOptions {
  /** 文件二进制（必填） */
  buffer: Buffer;
  /** 原始文件名，用于格式识别与落库展示（必填） */
  filename: string;
  /** MIME 类型（可选，格式识别优先级最高） */
  mime?: string;
  /** 向量化器（必填） */
  embedder: KBEmbedder;

  /** 所属 Agent；undefined 或 null = 非 Agent 隔离（默认 null） */
  agentId?: string | null;
  /** 所属用户；undefined 或 null = 全局库（默认 null） */
  userId?: string | null;
  /** 原始文件落盘路径（可选） */
  sourcePath?: string | null;
  /** 自定义元数据 */
  metadata?: Record<string, unknown>;

  /** 向量化批大小（默认 32） */
  embedBatchSize?: number;
  /** 分块 maxTokens（默认 512） */
  chunkMaxTokens?: number;
  /** 分块 overlapTokens（默认 64） */
  chunkOverlapTokens?: number;
  /** 分块 minTokens（默认 32） */
  chunkMinTokens?: number;

  /** PDF 最大页数（传给 parseFile） */
  maxPdfPages?: number;

  /**
   * 可选的 Docling sidecar 客户端（知识库 Spec §T7）。
   *
   * 注入后，当 TS parser 抛 PARSE_NEEDS_OCR / PARSE_EMPTY 时，会自动降级到 Docling；
   * 不注入则行为等价直接调用 parseFile（零破坏）。
   */
  docling?: DoclingClient | null;

  /**
   * Docling 降级事件回调（知识库 Spec §T7）。
   *
   * 仅当真正触发降级（即 TS 已抛错且 docling 可用）时调用；用于日志与审计。
   */
  onDoclingFallback?: (ev: {
    reason: "NEEDS_OCR" | "EMPTY";
    tsError: Error;
    filename?: string;
  }) => void;

  /** 状态流转回调（调试 / UI 进度） */
  onStatus?: (status: KBDocStatus, doc: KBDocument) => void;
}

/** ingestion 返回值 */
export interface IngestResult {
  /** 最终状态的 document（failed 也会返回） */
  document: KBDocument;
  /** 本次写入或已存在的 chunks（跳过时返回已有 chunks，不重新读取可传 []） */
  chunks: KBChunk[];
  /** 是否命中去重（命中则未重跑流水线） */
  duplicated: boolean;
  /** 是否跳过（命中且复用现有成果） */
  skipped: boolean;
}

// ─── 工具 ─────────────────────────────────────────────

/** SHA-256 hex */
function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 归一化 agentId / userId：undefined → null */
function nz(v: string | null | undefined): string | null {
  return v ?? null;
}

/**
 * 写 status + 错误 + updatedAt，统一出口。
 *
 * 成功转移不带 error；失败转移同时写 error 非空字符串（最多截断到 2000 字符）。
 */
function transitStatus(
  docId: string,
  status: KBDocStatus,
  error?: string | null,
): KBDocument {
  const patch: Partial<KBDocument> = {
    status,
    error: error ?? null,
    updatedAt: Date.now(),
  };
  updateDocument(docId, patch);
  const doc = getDocument(docId);
  if (!doc) throw new Error(`kb-pipeline: doc not found after transit: ${docId}`);
  return doc;
}

// ─── 主流程 ───────────────────────────────────────────

/**
 * 执行一次完整的 ingestion。
 *
 * 任一步失败：doc.status='failed' + error 记录后 rethrow；
 * 去重命中且状态非 failed：直接返回 skipped=true，不重跑流水线。
 *
 * @throws Error parse / chunk / embed / DB 任一阶段的底层错误
 */
export async function ingestDocument(opts: IngestOptions): Promise<IngestResult> {
  const now = Date.now();
  const agentId = nz(opts.agentId);
  const userId = nz(opts.userId);

  // ── Step 0：计算 hash ───────────────────────────────
  const contentHash = sha256Hex(opts.buffer);

  // ── Step 1：去重查找 ────────────────────────────────
  const existing = findDocumentByHash(contentHash, userId);
  let docId: string;
  let isRerunFailed = false;

  if (existing) {
    // failed 允许重跑；其它状态视为跳过
    if (existing.status !== "failed") {
      const existingChunks =
        existing.status === "indexed" ? listChunksByDoc(existing.id) : [];
      return {
        document: existing,
        chunks: existingChunks,
        duplicated: true,
        skipped: true,
      };
    }
    // failed 重跑：沿用 id，清掉旧 chunks（避免 chunk_index 重复）
    docId = existing.id;
    isRerunFailed = true;
    deleteChunksByDoc(docId);
  } else {
    docId = randomUUID();
  }

  // ── Step 2：写入或刷新 doc（status=pending）────────────
  const doc: KBDocument = {
    id: docId,
    agentId,
    userId,
    filename: opts.filename,
    mime: opts.mime ?? null,
    size: opts.buffer.byteLength,
    contentHash,
    sourcePath: opts.sourcePath ?? null,
    status: "pending",
    error: null,
    metadata: { ...(opts.metadata ?? {}) },
    createdAt: isRerunFailed && existing ? existing.createdAt : now,
    updatedAt: now,
  };
  // insertDocument 的 INSERT OR REPLACE 会覆盖现有 id；重跑时 createdAt 保留
  insertDocument(doc);
  opts.onStatus?.("pending", doc);

  // ── Step 3：parse ───────────────────────────────────
  let parseResult;
  try {
    const parsingDoc = transitStatus(docId, "parsing");
    opts.onStatus?.("parsing", parsingDoc);
    parseResult = await parseWithFallback(
      { buffer: opts.buffer, filename: opts.filename, mime: opts.mime },
      {
        maxPdfPages: opts.maxPdfPages,
        docling: opts.docling ?? null,
        onFallback: opts.onDoclingFallback,
      },
    );
  } catch (e: any) {
    const failedDoc = transitStatus(docId, "failed", stringifyErr(e, "parse"));
    opts.onStatus?.("failed", failedDoc);
    throw e;
  }

  // ── Step 4：chunk ───────────────────────────────────
  let rawChunks: KBChunk[];
  try {
    const chunkingDoc = transitStatus(docId, "chunking");
    opts.onStatus?.("chunking", chunkingDoc);
    rawChunks = chunkParseResult(parseResult, {
      docId,
      maxTokens: opts.chunkMaxTokens,
      overlapTokens: opts.chunkOverlapTokens,
      minTokens: opts.chunkMinTokens,
      embeddingType: opts.embedder.embeddingType,
    });
  } catch (e: any) {
    const failedDoc = transitStatus(docId, "failed", stringifyErr(e, "chunk"));
    opts.onStatus?.("failed", failedDoc);
    throw e;
  }

  // ── Step 5：embed ──────────────────────────────────
  let embeddedChunks: KBChunk[];
  try {
    const embeddingDoc = transitStatus(docId, "embedding");
    opts.onStatus?.("embedding", embeddingDoc);
    embeddedChunks = await embedChunks(rawChunks, {
      embedder: opts.embedder,
      batchSize: opts.embedBatchSize,
    });
  } catch (e: any) {
    const failedDoc = transitStatus(docId, "failed", stringifyErr(e, "embed"));
    opts.onStatus?.("failed", failedDoc);
    throw e;
  }

  // ── Step 6：insertChunks + status=indexed ──────────
  try {
    insertChunks(embeddedChunks);
    const indexedDoc = transitStatus(docId, "indexed");
    opts.onStatus?.("indexed", indexedDoc);
    return {
      document: indexedDoc,
      chunks: embeddedChunks,
      duplicated: false,
      skipped: false,
    };
  } catch (e: any) {
    const failedDoc = transitStatus(docId, "failed", stringifyErr(e, "index"));
    opts.onStatus?.("failed", failedDoc);
    throw e;
  }
}

/** 错误信息字符串化（带阶段前缀，截断到 2000 字符） */
function stringifyErr(e: unknown, phase: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  const full = `[${phase}] ${msg}`;
  return full.length > 2000 ? full.slice(0, 2000) : full;
}

// ─── 并发队列（决策 #5：固定并发 3）───────────────────

/** 并发队列实例 */
export interface IngestionQueue {
  /** 入队一次 ingestion；返回 Promise（无论成功失败） */
  enqueue(opts: IngestOptions): Promise<IngestResult>;
  /** 当前运行中 + 排队中任务数 */
  pending(): number;
  /** 当前运行中任务数（<= concurrency） */
  running(): number;
}

/**
 * 创建 ingestion 并发队列，语义等价 p-limit(concurrency)。
 *
 * 实现：自写信号量（复用 collaboration/agent-matcher mapLimit 思路，不引入外部依赖）。
 * 任务异常不影响其他任务（每个 promise 独立 catch）。
 */
export function createIngestionQueue(concurrency = 3): IngestionQueue {
  if (concurrency <= 0) {
    throw new Error("createIngestionQueue: concurrency must be > 0");
  }

  let runningCount = 0;
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (runningCount < concurrency) {
      runningCount++;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    runningCount++;
  }

  function release(): void {
    runningCount--;
    const next = waiters.shift();
    if (next) next();
  }

  let pendingCount = 0;
  return {
    async enqueue(opts: IngestOptions): Promise<IngestResult> {
      pendingCount++;
      try {
        await acquire();
        try {
          return await ingestDocument(opts);
        } finally {
          release();
        }
      } finally {
        pendingCount--;
      }
    },
    pending() {
      return pendingCount;
    },
    running() {
      return runningCount;
    },
  };
}
