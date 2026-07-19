/**
 * T5 · BM25 召回（Spec §5.5） + LIKE 降级（Spec §10 风险 #5）。
 *
 * 两条路径：
 *   1. FTS5 可用：`kb_chunks_fts MATCH ?` + `bm25(kb_chunks_fts)` 打分
 *   2. FTS5 不可用：分词后 `content LIKE '%kw%'` 逐个匹配，score = 命中关键词数
 *
 * 路径选择通过模块级缓存 `_fts5Available` 探测一次，后续查询复用结果。
 *
 * 当前 sql.js 构建**不支持 FTS5**（`no such module: fts5`），
 * 生产环境使用 better-sqlite3/原生 SQLite 时 FTS5 可用。
 */
import { getDatabase } from "../../persistence/sqlite/client.js";
import type { KBChunk, KBDocumentFilter, RetrievedChunk } from "../types.js";

export interface BM25SearchOptions {
  /** 查询文本 */
  query: string;
  /** 隔离过滤：undefined=不限过滤; null=严格匹配 IS NULL; string=等值匹配 */
  agentId?: string | null;
  /** 隔离过滤：undefined=不限过滤; null=严格匹配 IS NULL; string=等值匹配 */
  userId?: string | null;
  /** 范围限定：仅在指定 docIds 内搜索 */
  docIds?: string[];
  /** topK，默认 20 */
  topK?: number;
}

// ─── FTS5 可用性探测（模块级缓存） ─────────────────────────

/** null = 尚未探测；true/false = 已探测结果 */
let _fts5Available: boolean | null = null;

/** 手动重置探测缓存（仅供测试；生产代码不应调用） */
export function __resetFts5Cache(): void {
  _fts5Available = null;
}

/**
 * 探测 FTS5 是否可用：尝试一次轻量查询，成功则 true。
 *
 * sql.js 构建不含 FTS5 模块时：kb_chunks_fts 根本不会创建（migration catch 住），
 * 任何 `SELECT FROM kb_chunks_fts` 都会抛「no such table」。
 */
function probeFts5(): boolean {
  if (_fts5Available !== null) return _fts5Available;
  try {
    const db = getDatabase();
    // 只要查询不抛错即视为可用
    db.exec("SELECT count(*) FROM kb_chunks_fts LIMIT 1");
    _fts5Available = true;
  } catch {
    _fts5Available = false;
  }
  return _fts5Available;
}

// ─── 分词（LIKE 降级路径专用） ──────────────────────────────

/**
 * 轻量分词：
 *   - ASCII 单词按空格/标点切 + 小写化
 *   - 中文（CJK Unified Ideographs）按 2-gram 切；不足 2 字保单字
 *   - 去重 + 过滤空串
 *
 * 策略说明：FTS5 unicode61 tokenizer 对 CJK 也是按空格切（不做分词），
 * 本函数是 LIKE 降级时的"等价近似"，保证中文关键字可命中。
 */
export function tokenizeQuery(query: string): string[] {
  if (!query) return [];
  // 第一步：按"非字母非数字"切成片段（统一处理所有 ASCII 标点、空白、连字符）
  //   \p{L} 包含 CJK 字母；\p{N} 包含各语种数字；取其补集即分隔符。
  const segments = query.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  const tokens: string[] = [];
  const cjkRange = /[\u4e00-\u9fff]/;
  const asciiWord = /^[a-zA-Z0-9_]+$/;
  for (const seg of segments) {
    // ASCII 词整体保留
    if (asciiWord.test(seg)) {
      tokens.push(seg.toLowerCase());
      continue;
    }
    // 混合：逐字处理，CJK 做 2-gram，ASCII 聚合
    const chars = Array.from(seg);
    const cjkBuf: string[] = [];
    const asciiBuf: string[] = [];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (cjkRange.test(ch)) {
        if (asciiBuf.length > 0) {
          tokens.push(asciiBuf.join("").toLowerCase());
          asciiBuf.length = 0;
        }
        cjkBuf.push(ch);
      } else if (/[a-zA-Z0-9_]/.test(ch)) {
        if (cjkBuf.length > 0) {
          // flush CJK 的 2-gram
          flushCjkBigrams(cjkBuf, tokens);
          cjkBuf.length = 0;
        }
        asciiBuf.push(ch);
      }
    }
    if (cjkBuf.length > 0) flushCjkBigrams(cjkBuf, tokens);
    if (asciiBuf.length > 0) tokens.push(asciiBuf.join("").toLowerCase());
  }
  // 去重 + 过滤空
  return Array.from(new Set(tokens.filter((t) => t.length > 0)));
}

/** CJK 2-gram 展开；不足 2 字退化为单字 */
function flushCjkBigrams(buf: string[], out: string[]): void {
  if (buf.length === 1) {
    out.push(buf[0]);
    return;
  }
  for (let i = 0; i < buf.length - 1; i++) {
    out.push(buf[i] + buf[i + 1]);
  }
}

// ─── 内部工具：构造隔离过滤 SQL 片段 ───────────────────────

function buildIsolationWhere(filter: KBDocumentFilter): { clause: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.agentId !== undefined) {
    if (filter.agentId === null) conds.push("d.agent_id IS NULL");
    else {
      conds.push("d.agent_id = ?");
      params.push(filter.agentId);
    }
  }
  if (filter.userId !== undefined) {
    if (filter.userId === null) conds.push("d.user_id IS NULL");
    else {
      conds.push("d.user_id = ?");
      params.push(filter.userId);
    }
  }
  if (filter.status) {
    conds.push("d.status = ?");
    params.push(filter.status);
  }
  return {
    clause: conds.length > 0 ? " AND " + conds.join(" AND ") : "",
    params,
  };
}

/** sql.js 行反序列化：按列名取值 */
function rowToChunkAndDoc(
  cols: string[],
  row: unknown[],
): { chunk: KBChunk; docFilename: string; docAgentId: string | null; docUserId: string | null } {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
  // 重用 kb-repo.rowToChunk 太重（未导出），这里就地反序列化 content + 基础字段
  // 注意：BM25/LIKE 搜索**不需要 embedding**（合并阶段也不参与），故不反序列化 BLOB
  const chunk: KBChunk = {
    id: obj.id as string,
    docId: obj.doc_id as string,
    chunkIndex: (obj.chunk_index as number) ?? 0,
    content: obj.content as string,
    // 不解析 embedding BLOB：BM25 路径用不到（合并由 vector-search 的结果提供）
    embeddingType: ((obj.embedding_type as string) || "simple") as KBChunk["embeddingType"],
    tokenCount: (obj.token_count as number) ?? 0,
    metadata: (() => { try { return JSON.parse((obj.metadata as string) || "{}"); } catch { return {}; } })(),
    createdAt: (obj.created_at as number) ?? 0,
  };
  return {
    chunk,
    docFilename: (obj._doc_filename as string) ?? "",
    docAgentId: (obj._doc_agent_id as string | null) ?? null,
    docUserId: (obj._doc_user_id as string | null) ?? null,
  };
}

// ─── 主入口 ────────────────────────────────────────────────

/**
 * BM25 召回（或 LIKE 降级）。
 * score 含义：
 *   - FTS5 路径：-bm25(rank)（BM25 rank 越负越相关，取负使大=相关）
 *   - LIKE 路径：命中关键词数量（0~tokens.length）
 *
 * 上层 reranker.minMaxNormalize 会统一归一化到 [0,1]。
 */
export function searchByBM25(opts: BM25SearchOptions): RetrievedChunk[] {
  const topK = opts.topK ?? 20;
  if (topK <= 0) return [];
  if (!opts.query || opts.query.trim().length === 0) return [];

  const filter: KBDocumentFilter = { status: "indexed" };
  if (opts.agentId !== undefined) filter.agentId = opts.agentId;
  if (opts.userId !== undefined) filter.userId = opts.userId;

  // 【修复】FTS5 的 unicode61 分词器不切分 CJK（中文按空格当单 token），
  // 导致 `MATCH '中文词'` 命中率极低。含 CJK 时直接走 LIKE 降级路径（
  // tokenizeQuery 对 CJK 做 2-gram），保证中文可检索；纯 ASCII 查询仍优先 FTS5（BM25 打分更准）。
  const hasCJK = /[\u4e00-\u9fff]/.test(opts.query);

  // 纯 ASCII/无中文：优先 FTS5，运行时异常降级 LIKE
  if (!hasCJK && probeFts5()) {
    try {
      return searchByFTS5(opts, filter, topK);
    } catch {
      // 运行时 FTS5 异常 → 降级 LIKE
      _fts5Available = false;
    }
  }
  return searchByLike(opts, filter, topK);
}

/** FTS5 路径：kb_chunks_fts MATCH ? 按 bm25 rank 排序 */
function searchByFTS5(
  opts: BM25SearchOptions,
  filter: KBDocumentFilter,
  topK: number,
): RetrievedChunk[] {
  const { clause, params } = buildIsolationWhere(filter);
  const docIdClause =
    opts.docIds && opts.docIds.length > 0
      ? ` AND c.doc_id IN (${opts.docIds.map(() => "?").join(",")})`
      : "";
  const docIdParams = opts.docIds && opts.docIds.length > 0 ? opts.docIds : [];

  const sql = `
    SELECT c.*, d.filename AS _doc_filename, d.agent_id AS _doc_agent_id, d.user_id AS _doc_user_id,
           bm25(kb_chunks_fts) AS _rank
    FROM kb_chunks_fts
    JOIN kb_chunks c ON c.rowid = kb_chunks_fts.rowid
    JOIN kb_documents d ON d.id = c.doc_id
    WHERE kb_chunks_fts MATCH ?${clause}${docIdClause}
    ORDER BY _rank
    LIMIT ?
  `;
  const db = getDatabase();
  const res = db.exec(sql, [opts.query, ...params, ...docIdParams, topK]);
  if (!res.length) return [];
  const cols: string[] = res[0].columns;
  const rankIdx = cols.indexOf("_rank");
  const out: RetrievedChunk[] = [];
  for (const row of res[0].values) {
    const { chunk, docFilename, docAgentId, docUserId } = rowToChunkAndDoc(cols, row);
    const rank = (row[rankIdx] as number) ?? 0;
    // BM25 rank 越负越相关；取负号，大=相关
    const score = -rank;
    out.push({
      chunk,
      score,
      bm25Score: score,
      document: {
        id: chunk.docId,
        filename: docFilename,
        agentId: docAgentId,
        userId: docUserId,
      },
    });
  }
  return out;
}

/**
 * LIKE 降级路径：对分词后的每个 keyword 做 content LIKE '%kw%'，
 * 合并后按命中关键词数量打分。
 *
 * 性能考虑：对 N 条 chunk × K 个 keyword，最坏 O(N*K)；v1 阶段接受
 * （sql.js 内存库本来就是小数据集，FTS5 可用时走快路径）。
 */
function searchByLike(
  opts: BM25SearchOptions,
  filter: KBDocumentFilter,
  topK: number,
): RetrievedChunk[] {
  const tokens = tokenizeQuery(opts.query);
  if (tokens.length === 0) return [];

  const { clause, params } = buildIsolationWhere(filter);
  const docIdClause =
    opts.docIds && opts.docIds.length > 0
      ? ` AND c.doc_id IN (${opts.docIds.map(() => "?").join(",")})`
      : "";
  const docIdParams = opts.docIds && opts.docIds.length > 0 ? opts.docIds : [];

  // 把多个 LIKE OR 起来一次性过滤出候选（大幅减少反序列化成本）
  const likeClause = tokens.map(() => "c.content LIKE ?").join(" OR ");
  const likeParams = tokens.map((t) => `%${t}%`);

  const sql = `
    SELECT c.*, d.filename AS _doc_filename, d.agent_id AS _doc_agent_id, d.user_id AS _doc_user_id
    FROM kb_chunks c
    JOIN kb_documents d ON d.id = c.doc_id
    WHERE (${likeClause})${clause}${docIdClause}
  `;

  const db = getDatabase();
  const res = db.exec(sql, [...likeParams, ...params, ...docIdParams]);
  if (!res.length) return [];
  const cols: string[] = res[0].columns;

  const out: RetrievedChunk[] = [];
  for (const row of res[0].values) {
    const { chunk, docFilename, docAgentId, docUserId } = rowToChunkAndDoc(cols, row);
    // 精确命中计数（SQL 的 LIKE 只做筛选，这里统计精确 score）
    const contentLower = chunk.content.toLowerCase();
    let hits = 0;
    for (const kw of tokens) {
      if (contentLower.includes(kw.toLowerCase())) hits++;
    }
    if (hits === 0) continue;
    out.push({
      chunk,
      score: hits,
      bm25Score: hits,
      document: {
        id: chunk.docId,
        filename: docFilename,
        agentId: docAgentId,
        userId: docUserId,
      },
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topK);
}
