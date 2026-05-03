/**
 * T5 · 向量召回（Spec §5.5）。
 *
 * 流程：
 *   1. 用 embedder 把 query 转成查询向量
 *   2. scanIndexedChunks(filter) 扫同隔离空间下全部带向量分块（含文档元数据）
 *   3. 逐块算 cosineSimilarity → 组装 RetrievedChunk（score=余弦原始值）
 *   4. 按 docIds 过滤（若指定）
 *   5. 按分数降序，取 topK
 *
 * v1 限制（Spec §10 风险 #3）：O(N) 全表扫描。N 大时需上 HNSW，v1 接受。
 *
 * 注意：本函数返回的 score 是**原始余弦值**（-1~1，大多数情况 0~1），
 * 归一化工作交由 reranker.mergeByWeight 统一处理，保证向量/BM25 对齐。
 */
import { scanIndexedChunks } from "../storage/kb-repo.js";
import { cosineSimilarity } from "../storage/vector-index.js";
import type { KBEmbedder } from "../storage/vector-index.js";
import type { KBDocumentFilter, RetrievedChunk } from "../types.js";

export interface VectorSearchOptions {
  /** 查询文本 */
  query: string;
  /** 查询向量化使用的 embedder（与入库 embedder 同构即可） */
  embedder: KBEmbedder;
  /** 隔离过滤：agentId（undefined=不限；null=强制 NULL） */
  agentId?: string | null;
  /** 隔离过滤：userId（undefined=不限；null=强制 NULL） */
  userId?: string | null;
  /** 范围限定：仅在指定 docIds 内搜索 */
  docIds?: string[];
  /** topK，默认 20（供后续混合合并再削减到 5） */
  topK?: number;
}

/**
 * 纯向量召回。
 * 返回 RetrievedChunk，其中 score = 原始余弦相似度；vectorScore 未归一化（留给上游）。
 */
export async function searchByVector(
  opts: VectorSearchOptions,
): Promise<RetrievedChunk[]> {
  const topK = opts.topK ?? 20;
  if (topK <= 0) return [];
  if (!opts.query || opts.query.trim().length === 0) return [];

  // Step 1: 查询向量化
  const queryVec = await opts.embedder.embed(opts.query);
  if (!queryVec || queryVec.length === 0) return [];

  // Step 2: 扫同隔离空间的全部 indexed chunks
  const filter: KBDocumentFilter = {
    status: "indexed",
  };
  if (opts.agentId !== undefined) filter.agentId = opts.agentId;
  if (opts.userId !== undefined) filter.userId = opts.userId;
  const rows = scanIndexedChunks(filter);

  // Step 3: docIds 额外过滤（在应用层做，避免 scanIndexedChunks 接口膨胀）
  const docIdSet = opts.docIds && opts.docIds.length > 0 ? new Set(opts.docIds) : null;

  // Step 4: 逐块算余弦，组装候选
  const hits: RetrievedChunk[] = [];
  for (const row of rows) {
    if (docIdSet && !docIdSet.has(row.chunk.docId)) continue;
    const emb = row.chunk.embedding;
    if (!emb || emb.length === 0) continue;
    const sim = cosineSimilarity(queryVec, emb);
    // 截断负分（反向相关）：与 BM25 对齐到 [0, +]
    if (sim <= 0) continue;
    hits.push({
      chunk: row.chunk,
      score: sim,
      vectorScore: sim,
      document: {
        id: row.chunk.docId,
        filename: row.docFilename,
        agentId: row.docAgentId,
        userId: row.docUserId,
      },
    });
  }

  // Step 5: 降序取 topK
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}
