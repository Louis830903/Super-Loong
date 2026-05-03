/**
 * 知识库模块桶导出（知识库 Spec §5 / T1）。
 *
 * 暴露给上游的公开 API：
 *   - 类型：KBDocument / KBChunk / RetrievedChunk / KBDocStatus / KBEmbeddingType / KBDocumentFilter / KBPageOptions
 *   - 仓储 CRUD：insertDocument / updateDocument / getDocument / findDocumentByHash /
 *     listDocuments / countDocuments / deleteDocument /
 *     insertChunks / listChunksByDoc / getChunksByIds / updateChunkEmbedding /
 *     deleteChunksByDoc / scanIndexedChunks
 *
 * 后续批次会在此处追加：parser / chunker / pipeline / retriever / provider 等。
 */

// 类型
export type {
  KBDocument,
  KBChunk,
  RetrievedChunk,
  KBDocStatus,
  KBEmbeddingType,
  KBDocumentFilter,
  KBPageOptions,
} from "./types.js";

// 仓储 CRUD（T1）
export {
  insertDocument,
  updateDocument,
  getDocument,
  findDocumentByHash,
  listDocuments,
  countDocuments,
  deleteDocument,
  insertChunks,
  listChunksByDoc,
  getChunksByIds,
  updateChunkEmbedding,
  deleteChunksByDoc,
  scanIndexedChunks,
} from "./storage/kb-repo.js";

// 解析器（T2）—— 6 格式统一 parseFile 入口 + detectFormat + 独立 parser 导出
export type {
  ParseResult,
  ParserInput,
  ParserFormat,
  ParseMetadata,
  ParserErrorCode,
} from "./parser/index.js";
export {
  parseFile,
  detectFormat,
  parseText,
  parseHtml,
  parsePdf,
  parseDocx,
  parseXlsx,
  parsePptx,
} from "./parser/index.js";

// 分块器（T3）—— ParseResult → KBChunk[]，三层策略（pageBreaks → 标题 → 滑窗）
export type { ChunkOptions, ChunkMeta, ChunkBoundary } from "./chunker/index.js";
export {
  chunkParseResult,
  estimateTokens,
  splitByHeadings,
  slidingWindow,
  isHeadingLine,
} from "./chunker/index.js";

// 向量化 + 相似度内核（T4）—— 批量 embed / cosine
export type { KBEmbedder, EmbedChunksOptions } from "./storage/vector-index.js";
export { embedChunks, cosineSimilarity } from "./storage/vector-index.js";

// Ingestion 流水线（T4）—— upload → hash → parse → chunk → embed → index
export type { IngestOptions, IngestResult, IngestionQueue } from "./ingestion/pipeline.js";
export { ingestDocument, createIngestionQueue } from "./ingestion/pipeline.js";

// Docling Sidecar 客户端 + 路由策略（T7）—— TS 优先、OCR 场景降级到 Docling
export type {
  DoclingClient,
  DoclingClientOptions,
} from "./parser/parser-docling.js";
export {
  createDoclingClient,
  DoclingClientError,
} from "./parser/parser-docling.js";
export type { ParseRouterOptions } from "./parser/router.js";
export { parseWithFallback, shouldBypassTs } from "./parser/router.js";

// 混合检索（T5）—— vector + BM25(FTS5/LIKE 降级) + reranker
export type { VectorSearchOptions } from "./retrieval/vector-search.js";
export { searchByVector } from "./retrieval/vector-search.js";
export type { BM25SearchOptions } from "./retrieval/bm25-search.js";
export { searchByBM25, tokenizeQuery } from "./retrieval/bm25-search.js";
export type { KBHybridSearchOptions } from "./retrieval/hybrid.js";
export { searchHybrid } from "./retrieval/hybrid.js";
export {
  minMaxNormalize,
  mergeByWeight,
  applyMinScore,
  truncateByTokens,
} from "./retrieval/reranker.js";

// Provider 接入（T6）—— IMemoryProvider 实现 + kb_search / kb_list 工具
export type {
  KbToolDeps,
  KbSearchHitDTO,
  KbDocDTO,
} from "./tools/kb-search.js";
export {
  createKbSearchTool,
  createKbListTool,
} from "./tools/kb-search.js";
export type { KnowledgeBaseProviderOptions } from "./provider.js";
export { KnowledgeBaseProvider, formatKbPrefetch } from "./provider.js";
