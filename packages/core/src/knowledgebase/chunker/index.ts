/**
 * 分块器总入口（知识库 Spec §5.3 / T3.6）。
 *
 * 三层策略（按优先级从高到低）：
 *   L1：pageBreaks 优先——若 ParseResult 带 pageBreaks，先按 page/sheet/slide 切出 regions
 *   L2：标题切——每个 region 内部按 Markdown / 中文章节标题再切
 *   L3：滑窗兜底——仍超 maxTokens 的段按 token 预算滑窗 + overlap 切
 *
 * 输出：KBChunk[]（不含 embedding，向量化由 T4 负责）
 */

import { randomUUID } from "node:crypto";
import type { ParseResult } from "../parser/types.js";
import type { KBChunk } from "../types.js";
import type { ChunkBoundary, ChunkOptions } from "./types.js";
import { estimateTokens, splitByHeadings, slidingWindow } from "./utils.js";

/** 从 region 文本首行推断 boundary 类型及附加元信息（sheet 名/slide 号） */
function inferRegionMeta(
  text: string,
  pageIndex: number,
): {
  boundary: ChunkBoundary;
  pageNumber?: number;
  sheetName?: string;
  slideNumber?: number;
} {
  const sheetMatch = /^\[Sheet:\s*([^\]]+)\]/.exec(text);
  if (sheetMatch) return { boundary: "sheet", sheetName: sheetMatch[1].trim() };

  const slideMatch = /^\[Slide\s+(\d+)\]/.exec(text);
  if (slideMatch) return { boundary: "slide", slideNumber: Number(slideMatch[1]) };

  return { boundary: "page", pageNumber: pageIndex };
}

/**
 * 将 ParseResult 切分为 KBChunk[]。
 *
 * @param pr ParseResult（来自 T2 parser）
 * @param opts ChunkOptions（必须带 docId）
 */
export function chunkParseResult(pr: ParseResult, opts: ChunkOptions): KBChunk[] {
  const maxTokens = opts.maxTokens ?? 512;
  const overlapTokens = opts.overlapTokens ?? 64;
  const minTokens = opts.minTokens ?? 32;
  const embeddingType = opts.embeddingType ?? "simple";

  // 参数健壮性
  if (maxTokens <= 0) throw new Error("chunker: maxTokens must be > 0");
  if (overlapTokens < 0 || overlapTokens >= maxTokens) {
    throw new Error("chunker: overlapTokens must be in [0, maxTokens)");
  }

  // ─── Step 1: L1 按 pageBreaks 切出初步 regions ──────────────
  type Region = {
    text: string;
    boundary: ChunkBoundary;
    pageNumber?: number;
    sheetName?: string;
    slideNumber?: number;
  };
  const regions: Region[] = [];

  if (pr.pageBreaks && pr.pageBreaks.length > 0) {
    for (let i = 0; i < pr.pageBreaks.length; i++) {
      const start = pr.pageBreaks[i];
      const end = i + 1 < pr.pageBreaks.length ? pr.pageBreaks[i + 1] : pr.text.length;
      const region = pr.text.slice(start, end).trim();
      if (!region) continue;
      const meta = inferRegionMeta(region, i + 1);
      regions.push({ text: region, ...meta });
    }
  } else {
    // 无 pageBreaks：整篇作为单个 region
    if (pr.text.trim()) {
      regions.push({ text: pr.text.trim(), boundary: "paragraph" });
    }
  }

  // ─── Step 2: 每 region 内部 L2+L3 切 ────────────────────────
  const chunks: KBChunk[] = [];
  const now = Date.now();
  let idx = 0;

  for (const region of regions) {
    // L2：按标题切子段
    const sections = splitByHeadings(region.text);

    for (const sec of sections) {
      const body = sec.body.trim();
      if (!body) continue;

      // L3：每个 section 再按 token 预算滑窗
      const windows = slidingWindow(body, maxTokens, overlapTokens);

      for (let wi = 0; wi < windows.length; wi++) {
        const w = windows[wi];
        const tokens = estimateTokens(w);

        // 过短的末尾块尝试合并到上一块（避免碎片）
        if (tokens < minTokens && chunks.length > 0) {
          const last = chunks[chunks.length - 1];
          // 仅在相同 region（同页/同 sheet/同 slide）内合并
          const lastMeta = last.metadata as { pageNumber?: number; sheetName?: string; slideNumber?: number };
          if (
            lastMeta.pageNumber === region.pageNumber &&
            lastMeta.sheetName === region.sheetName &&
            lastMeta.slideNumber === region.slideNumber
          ) {
            last.content = last.content + "\n" + w;
            last.tokenCount = estimateTokens(last.content);
            continue;
          }
        }

        // 决定 boundary：多窗口时，非首窗标 "window"；有标题则标 "heading"
        // 注意：用索引 wi 判断，不用字符串比较——因为 overlap 可能导致首尾窗内容相似
        let boundary: ChunkBoundary = region.boundary;
        if (windows.length > 1 && wi > 0) {
          boundary = "window";
        } else if (sec.heading) {
          boundary = "heading";
        }

        chunks.push({
          id: randomUUID(),
          docId: opts.docId,
          chunkIndex: idx++,
          content: w,
          embeddingType,
          tokenCount: tokens,
          metadata: {
            boundary,
            ...(region.pageNumber !== undefined ? { pageNumber: region.pageNumber } : {}),
            ...(region.sheetName !== undefined ? { sheetName: region.sheetName } : {}),
            ...(region.slideNumber !== undefined ? { slideNumber: region.slideNumber } : {}),
            ...(sec.heading ? { headingPath: [sec.heading] } : {}),
          },
          createdAt: now,
        });
      }
    }
  }

  return chunks;
}

export type { ChunkOptions, ChunkMeta, ChunkBoundary } from "./types.js";
export { estimateTokens, splitByHeadings, slidingWindow, isHeadingLine, takeTailByTokens } from "./utils.js";
