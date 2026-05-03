/**
 * 分块器类型定义（知识库 Spec §5.3 / T3）。
 *
 * 设计要点：
 *   - 输入：ParseResult（T2 输出）+ ChunkOptions
 *   - 输出：KBChunk[]（T1 仓储层定义，不含 embedding，向量化由 T4 负责）
 *   - boundary 语义：标识该 chunk 来自哪一层策略切分，便于 T5 检索时做权重加成
 */

import type { KBEmbeddingType } from "../types.js";

/** 分块边界类型——标识切分依据 */
export type ChunkBoundary =
  | "page" // PDF 页边界（\f 或 pdf-parse 推断）
  | "sheet" // XLSX sheet 边界
  | "slide" // PPTX slide 边界
  | "heading" // Markdown / 中文章节标题
  | "paragraph" // 自然段落
  | "window"; // 滑窗兜底

/** 分块元数据（合并后写入 KBChunk.metadata） */
export interface ChunkMeta {
  /** 切分边界类型 */
  boundary: ChunkBoundary;
  /** 页码（从 1 起；仅 PDF/Word 有效） */
  pageNumber?: number;
  /** sheet 名称（仅 XLSX 有效） */
  sheetName?: string;
  /** slide 编号（从 1 起；仅 PPTX 有效） */
  slideNumber?: number;
  /** 标题路径，如 ["第一章", "## 概述"]（按层级从上到下） */
  headingPath?: string[];
  /** 预估 token 数（冗余字段，与 KBChunk.tokenCount 一致） */
  tokenCount?: number;
}

/** 分块器配置 */
export interface ChunkOptions {
  /** 所属文档 ID（必填，直接写入 KBChunk.docId） */
  docId: string;
  /** 单块最大 token 数，默认 512 */
  maxTokens?: number;
  /** 滑窗重叠 token 数，默认 64；必须 < maxTokens/2 */
  overlapTokens?: number;
  /** 单块最小 token 数（低于此阈值的末尾块会被合并到上一块），默认 32 */
  minTokens?: number;
  /** 向量类型（写入 KBChunk.embeddingType），默认 "simple" */
  embeddingType?: KBEmbeddingType;
}
