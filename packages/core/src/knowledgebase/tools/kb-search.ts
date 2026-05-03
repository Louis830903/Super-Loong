/**
 * T6 · 知识库 LLM 工具（Spec §T6 / §7）
 *
 * 为 LLM Agent 提供两个可调用工具：
 *   - `kb_search`：混合检索，返回命中分块摘要（JSON）
 *   - `kb_list`  ：列出当前隔离空间下的文档清单（JSON）
 *
 * 设计要点：
 *   1. 以**工厂函数**形式导出（而非静态 ToolDefinition），
 *      因为执行时需要注入 embedder / agentId / userId 等运行时依赖；
 *   2. 工具输出统一 JSON 字符串（output 字段），便于 LLM 解析；
 *      结构化结果同时挂在 data 字段，便于宿主程序二次消费；
 *   3. 隔离过滤严格沿用 Provider 配置（不允许 LLM 越权指定 agentId/userId）。
 */

import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolResult } from "../../types/index.js";
import { listDocuments } from "../storage/kb-repo.js";
import type { KBEmbedder } from "../storage/vector-index.js";
import { searchHybrid } from "../retrieval/hybrid.js";
import type { RetrievedChunk } from "../types.js";

/** 工具工厂注入的运行时依赖 —— Provider 初始化后填入 */
export interface KbToolDeps {
  /** 与入库一致的 embedder */
  embedder: KBEmbedder;
  /** 所属 Agent（隔离） */
  agentId: string | null;
  /** 所属用户（隔离） */
  userId: string | null;
  /** 默认返回条数（覆盖 Spec 默认值） */
  defaultTopK?: number;
  /** 单次检索最大 token 累计预算 */
  defaultMaxTokens?: number;
}

// ───────────────────────── kb_search ─────────────────────────

/** kb_search 的参数 Zod schema（给 LLM 和本地执行共用） */
const kbSearchParamsSchema = z.object({
  query: z.string().describe("查询文本（必填）"),
  topK: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("返回命中条数（可选，默认 Provider 配置）"),
  docIds: z
    .array(z.string())
    .optional()
    .describe("限定文档 ID 范围（可选）"),
});

type KbSearchParams = z.infer<typeof kbSearchParamsSchema>;

/** 单条命中在 LLM 侧的精简表示（去除无用字段，避免 token 浪费） */
export interface KbSearchHitDTO {
  chunkId: string;
  docId: string;
  filename: string;
  score: number;
  vectorScore?: number;
  bm25Score?: number;
  content: string;
  tokenCount: number;
}

function toHitDTO(h: RetrievedChunk): KbSearchHitDTO {
  return {
    chunkId: h.chunk.id,
    docId: h.chunk.docId,
    filename: h.document.filename,
    score: h.score,
    vectorScore: h.vectorScore,
    bm25Score: h.bm25Score,
    content: h.chunk.content,
    tokenCount: h.chunk.tokenCount,
  };
}

/**
 * 创建 `kb_search` 工具定义。
 *
 * @param deps Provider 运行时依赖
 * @returns ToolDefinition
 */
export function createKbSearchTool(deps: KbToolDeps): ToolDefinition {
  return {
    name: "kb_search",
    description:
      "在当前知识库中检索与 query 最相关的文档片段（混合向量 + BM25 检索）。" +
      "返回 JSON，包含每条命中的 filename / content / score。" +
      "用于回答事实性问题、查阅文档细节、补充上下文。",
    parameters: kbSearchParamsSchema,
    execute: async (params: unknown, ctx: ToolContext): Promise<ToolResult> => {
      // 参数校验（容错处理：LLM 可能生成不规范参数）
      const parsed = kbSearchParamsSchema.safeParse(params);
      if (!parsed.success) {
        return {
          success: false,
          output: `kb_search 参数校验失败: ${parsed.error.message}`,
          error: parsed.error.message,
        };
      }
      const { query, topK, docIds } = parsed.data as KbSearchParams;

      if (!query || query.trim().length === 0) {
        return {
          success: false,
          output: "kb_search: query 不能为空",
          error: "empty_query",
        };
      }

      try {
        // 运行时隔离：优先从 ToolContext 读取（全局工具模式），
        // 降级到 deps 初始值（Provider 内部 initialize 模式，向后兼容）
        const agentId = ctx.agentId ?? deps.agentId ?? null;
        const userId = ctx.userId ?? deps.userId ?? null;
        const hits = await searchHybrid({
          query,
          embedder: deps.embedder,
          agentId,
          userId,
          docIds,
          topK: topK ?? deps.defaultTopK ?? 5,
          maxTokens: deps.defaultMaxTokens,
        });
        const dtos = hits.map(toHitDTO);
        // 空结果也视为 success（只是没命中），避免 LLM 误判为工具故障
        return {
          success: true,
          output: JSON.stringify({ count: dtos.length, hits: dtos }, null, 2),
          data: { count: dtos.length, hits: dtos },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          output: `kb_search 执行失败: ${msg}`,
          error: msg,
        };
      }
    },
  };
}

// ───────────────────────── kb_list ─────────────────────────

/** kb_list 的参数 Zod schema */
const kbListParamsSchema = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("返回文档上限（默认 20）"),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("偏移量（分页，默认 0）"),
});

type KbListParams = z.infer<typeof kbListParamsSchema>;

/** 文档摘要 DTO（LLM 友好，剥离向量 / hash 等无用字段） */
export interface KbDocDTO {
  id: string;
  filename: string;
  mime: string | null;
  size: number;
  status: string;
  createdAt: number;
}

/**
 * 创建 `kb_list` 工具定义。
 *
 * 只列出**当前隔离空间内** + status = 'indexed' 的文档，
 * 给 LLM 用于"先列清单再定向检索"的两步策略。
 */
export function createKbListTool(deps: KbToolDeps): ToolDefinition {
  return {
    name: "kb_list",
    description:
      "列出当前知识库中已索引的文档（filename / status / size）。" +
      "可用于先了解有哪些文档，再用 kb_search 定向查询。",
    parameters: kbListParamsSchema,
    execute: async (params: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = kbListParamsSchema.safeParse(params ?? {});
      if (!parsed.success) {
        return {
          success: false,
          output: `kb_list 参数校验失败: ${parsed.error.message}`,
          error: parsed.error.message,
        };
      }
      const { limit, offset } = parsed.data as KbListParams;

      try {
        // 运行时隔离：优先从 ToolContext 读取（全局工具模式），
        // 降级到 deps 初始值（Provider 内部 initialize 模式，向后兼容）
        const agentId = ctx.agentId ?? deps.agentId ?? null;
        const userId = ctx.userId ?? deps.userId ?? null;
        const docs = listDocuments(
          {
            agentId,
            userId,
            status: "indexed",
          },
          {
            limit: limit ?? 20,
            offset: offset ?? 0,
          },
        );
        const dtos: KbDocDTO[] = docs.map((d) => ({
          id: d.id,
          filename: d.filename,
          mime: d.mime,
          size: d.size,
          status: d.status,
          createdAt: d.createdAt,
        }));
        return {
          success: true,
          output: JSON.stringify({ count: dtos.length, docs: dtos }, null, 2),
          data: { count: dtos.length, docs: dtos },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          output: `kb_list 执行失败: ${msg}`,
          error: msg,
        };
      }
    },
  };
}
