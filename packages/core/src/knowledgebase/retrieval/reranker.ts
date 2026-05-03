/**
 * T5 · 检索结果重排纯函数（Spec §5.5）。
 *
 * 本模块只包含**无副作用的纯函数**，不触碰数据库，不调用 embedder：
 *   - minMaxNormalize：将一组分数归一化到 [0, 1]
 *   - mergeByWeight   ：按 vectorWeight / bm25Weight 加权合并两路召回结果
 *   - applyMinScore   ：按 minScore 阈值过滤
 *   - truncateByTokens：按 maxTokens 累加截断（prefetch 注入上限）
 *
 * 设计原则：
 *   1. 所有函数返回**新数组**，不修改入参（便于测试 & 链式组合）
 *   2. 边界情况稳健降级：空数组 / 单值数组 / 同值数组 → 回退合理默认
 *   3. 归一化策略采用 min-max（而非 softmax）：BM25 原始 rank 与余弦分布都能统一到 [0,1]
 */
import type { RetrievedChunk } from "../types.js";

/**
 * min-max 归一化：把一组数值线性映射到 [0, 1]。
 *
 * 边界：
 *   - 空数组直接返回空数组
 *   - 全部相同值（min === max）→ 统一返回 1（保留相对位置 + 避免 0 消灭权重）
 */
export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range === 0) {
    // 全部同值时视为等权，返回 1 不丢信息
    return values.map(() => 1);
  }
  return values.map((v) => (v - min) / range);
}

/**
 * 加权合并两路召回结果。
 *
 * 合并规则：
 *   1. 分别对 vector / bm25 侧做 min-max 归一化
 *   2. 按 chunk.id 聚合：最终 score = vectorWeight * normVec + bm25Weight * normBm25
 *   3. 仅一路命中的 chunk：缺失侧按 0 计入（保持两路权重一致）
 *   4. 结果按 score 降序
 *
 * @param vectorHits 向量召回结果（score 为原始余弦值）
 * @param bm25Hits   BM25 召回结果（score 为 BM25 rank 或 LIKE 命中计分）
 * @param vectorWeight 向量权重（默认 0.6）
 * @param bm25Weight   BM25 权重（默认 0.4）
 */
export function mergeByWeight(
  vectorHits: RetrievedChunk[],
  bm25Hits: RetrievedChunk[],
  vectorWeight = 0.6,
  bm25Weight = 0.4,
): RetrievedChunk[] {
  // 归一化两路原始分数
  const vecNorm = minMaxNormalize(vectorHits.map((h) => h.score));
  const bm25Norm = minMaxNormalize(bm25Hits.map((h) => h.score));

  // 按 chunk.id 聚合
  const merged = new Map<string, RetrievedChunk>();
  for (let i = 0; i < vectorHits.length; i++) {
    const h = vectorHits[i];
    merged.set(h.chunk.id, {
      ...h,
      vectorScore: vecNorm[i],
      bm25Score: 0,
      score: vectorWeight * vecNorm[i],
    });
  }
  for (let i = 0; i < bm25Hits.length; i++) {
    const h = bm25Hits[i];
    const prev = merged.get(h.chunk.id);
    const bm25 = bm25Norm[i];
    if (prev) {
      // 两路同时命中，补齐 bm25 分量
      prev.bm25Score = bm25;
      prev.score = vectorWeight * (prev.vectorScore ?? 0) + bm25Weight * bm25;
    } else {
      // 仅 BM25 命中
      merged.set(h.chunk.id, {
        ...h,
        vectorScore: 0,
        bm25Score: bm25,
        score: bm25Weight * bm25,
      });
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

/** 按 minScore 阈值过滤（undefined / null → 不过滤） */
export function applyMinScore(
  hits: RetrievedChunk[],
  minScore: number | undefined,
): RetrievedChunk[] {
  if (minScore === undefined || minScore === null) return hits;
  return hits.filter((h) => h.score >= minScore);
}

/**
 * 按 maxTokens 截断：从分数最高的块开始累加 tokenCount，超过阈值即停。
 * 注意保持已排序顺序（通常上游已按 score 降序）。
 *
 * 边界：
 *   - maxTokens = 0 或未传 → 不截断（返回原数组）
 *   - 首个 chunk 就超限 → 至少保留 1 个（避免完全空结果）
 */
export function truncateByTokens(
  hits: RetrievedChunk[],
  maxTokens: number | undefined,
): RetrievedChunk[] {
  if (!maxTokens || maxTokens <= 0) return hits;
  if (hits.length === 0) return hits;
  const out: RetrievedChunk[] = [];
  let used = 0;
  for (const h of hits) {
    const cost = Math.max(0, h.chunk.tokenCount ?? 0);
    // 已达上限且已保留至少 1 条 → 停
    if (out.length > 0 && used + cost > maxTokens) break;
    out.push(h);
    used += cost;
  }
  return out;
}
