/**
 * T5 · 混合检索主入口（Spec §5.5）。
 *
 * 编排 vector + BM25 两路召回 → 加权合并 → minScore 过滤 → maxTokens 截断 → topK 截取。
 *
 * 默认权重（Spec §6）：vectorWeight=0.6 / bm25Weight=0.4
 * 默认阈值（Spec §13 决策 #4）：topK=3 / maxTokens=2000 / minScore=0.3
 *   注：Spec 表述 "minScore=0.3" 是**归一化后**的分数阈值（[0,1] 区间）。
 */
import type { KBEmbedder } from "../storage/vector-index.js";
import type { RetrievedChunk } from "../types.js";
import { searchByBM25 } from "./bm25-search.js";
import {
  applyMinScore,
  mergeByWeight,
  truncateByTokens,
} from "./reranker.js";
import { searchByVector } from "./vector-search.js";

/**
 * 混合检索查询选项（Spec §6 KbQueryOptions 的 TS 实现版本）。
 *
 * 与 Spec 差异：
 *   - `embedder` 由调用方注入（与 T4 保持一致）；Spec 未明示但必需
 *   - 返回 `RetrievedChunk`（实际代码类型），字段对等但更完整
 */
export interface KBHybridSearchOptions {
  /** 查询文本 */
  query: string;
  /** 查询向量化 embedder（与入库 embedder 同结构） */
  embedder: KBEmbedder;
  /** 隔离过滤：agentId（undefined=不限；null=强制 NULL） */
  agentId?: string | null;
  /** 隔离过滤：userId（undefined=不限；null=强制 NULL） */
  userId?: string | null;
  /** 范围限定：仅在指定 docIds 内搜索 */
  docIds?: string[];
  /** 最终返回条数，默认 5 */
  topK?: number;
  /** 向量权重，默认 0.6 */
  vectorWeight?: number;
  /** BM25 权重，默认 0.4 */
  bm25Weight?: number;
  /** 最低分数阈值（归一化后 [0,1]），默认不过滤 */
  minScore?: number;
  /** 最大累计 token 数，默认 2000 */
  maxTokens?: number;
  /**
   * 单路召回条数（合并前各自的 topK），默认 20。
   * 建议 ≥ 最终 topK × 4 以保证混合合并有充足候选。
   */
  recallSize?: number;
}

/**
 * 执行混合检索。
 *
 * 步骤：
 *   1. 并行发起 vector + BM25 两路召回（各取 recallSize 条）
 *   2. mergeByWeight 做加权归一合并
 *   3. applyMinScore 按阈值过滤
 *   4. truncateByTokens 按 token 预算截断
 *   5. 取前 topK
 */
export async function searchHybrid(
  opts: KBHybridSearchOptions,
): Promise<RetrievedChunk[]> {
  if (!opts.query || opts.query.trim().length === 0) return [];
  const topK = opts.topK ?? 5;
  const recallSize = opts.recallSize ?? 20;
  const vectorWeight = opts.vectorWeight ?? 0.6;
  const bm25Weight = opts.bm25Weight ?? 0.4;
  const maxTokens = opts.maxTokens ?? 2000;

  // Step 1: 并行两路召回
  //   - vector: 异步（embed 耗时 I/O）
  //   - bm25  : 同步 SQL（wrap 成 Promise 以便并发 await）
  const [vectorHits, bm25Hits] = await Promise.all([
    searchByVector({
      query: opts.query,
      embedder: opts.embedder,
      agentId: opts.agentId,
      userId: opts.userId,
      docIds: opts.docIds,
      topK: recallSize,
    }),
    Promise.resolve().then(() =>
      searchByBM25({
        query: opts.query,
        agentId: opts.agentId,
        userId: opts.userId,
        docIds: opts.docIds,
        topK: recallSize,
      }),
    ),
  ]);

  // Step 2: 加权归一合并
  let merged = mergeByWeight(vectorHits, bm25Hits, vectorWeight, bm25Weight);

  // Step 3: minScore 过滤
  merged = applyMinScore(merged, opts.minScore);

  // Step 4: maxTokens 截断
  merged = truncateByTokens(merged, maxTokens);

  // Step 5: 取 topK
  return merged.slice(0, topK);
}
