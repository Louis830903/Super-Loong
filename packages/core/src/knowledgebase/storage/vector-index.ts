/**
 * 知识库向量化与相似度内核（知识库 Spec §5.4 / T4）。
 *
 * 职责：
 *   1. 批量向量化：把 chunk 文本喂给 embedder，按批 32 并发 embed，回填到 KBChunk.embedding
 *   2. 余弦相似度：T5 检索阶段使用，提前抽到这里以便 vector-index 单元自洽
 *
 * 解耦策略：
 *   - 不直接 import `core/memory/manager.ts`，而是定义本地结构化 `KBEmbedder` 接口
 *   - 运行时调用方（pipeline / tests）按此接口注入任意实现（simple/hrr/qwen/mock）
 *   - 这样既复用了 memory 的 embedder 能力，又避免了两个模块的硬依赖
 *
 * 批大小策略：
 *   - 默认 32：经验值，平衡 API 并发压力与单批延迟
 *   - 每批内 `Promise.all` 并发，批与批之间串行
 *   - embed 失败会抛错中断当前批，由上层捕获
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { KBChunk, KBEmbeddingType } from "../types.js";

/**
 * 向量化器最小接口（结构类型，不耦合具体实现）。
 * 与 `core/memory/manager.ts` 里的 `EmbeddingProvider` 同构，可直接互注。
 */
export interface KBEmbedder {
  /** 将文本转为向量（与 memories 共用语义） */
  embed(text: string): Promise<number[]>;
  /** 向量类型（决定 BLOB 精度 / 跨库一致性） */
  readonly embeddingType: KBEmbeddingType;
}

/** 批量向量化参数 */
export interface EmbedChunksOptions {
  /** 向量化器（必填） */
  embedder: KBEmbedder;
  /** 批大小（默认 32） */
  batchSize?: number;
  /** 可选：每批完成后的回调（用于进度上报） */
  onBatchDone?: (done: number, total: number) => void;
}

/**
 * 批量向量化：把 chunks 每个 content 算出 embedding，返回带 embedding 的新数组。
 *
 * 不修改入参（返回浅拷贝）；embeddingType 以 embedder 为准（覆盖 chunk 预设）。
 * 空数组直接返回 []；batchSize <= 0 抛错。
 *
 * @throws Error("embedChunks: batchSize must be > 0") 参数非法
 */
export async function embedChunks(
  chunks: KBChunk[],
  opts: EmbedChunksOptions,
): Promise<KBChunk[]> {
  if (chunks.length === 0) return [];
  const batchSize = opts.batchSize ?? 32;
  if (batchSize <= 0) throw new Error("embedChunks: batchSize must be > 0");
  const { embedder } = opts;
  const embType = embedder.embeddingType;

  const out: KBChunk[] = new Array(chunks.length);
  for (let start = 0; start < chunks.length; start += batchSize) {
    const end = Math.min(start + batchSize, chunks.length);
    const batch = chunks.slice(start, end);
    // 批内并发 embed
    const vectors = await Promise.all(batch.map((c) => embedder.embed(c.content)));
    for (let i = 0; i < batch.length; i++) {
      out[start + i] = {
        ...batch[i],
        embedding: vectors[i],
        embeddingType: embType,
      };
    }
    if (opts.onBatchDone) opts.onBatchDone(end, chunks.length);
  }
  return out;
}

/**
 * 余弦相似度：`a · b / (|a| * |b|)`，结果 ∈ [-1, 1]。
 * 供 T5 向量检索使用，提前放 vector-index 层，避免多处实现。
 *
 * 维度不一致 / 空向量 / 零向量 → 返回 0（稳健降级，不抛）。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
