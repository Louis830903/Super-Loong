/**
 * T6 · KnowledgeBaseProvider —— 接入记忆编排器的只读 Provider（Spec §T6）
 *
 * 设计要点：
 *   1. 实现 IMemoryProvider，通过 MemoryProviderOrchestrator.addProvider 注入；
 *   2. `prefetch(query)` 调 searchHybrid，格式化为：
 *        ## 知识库参考资料
 *        ### {filename}
 *        {content}
 *        ---
 *   3. `syncTurn` no-op —— 知识库只读，不因对话增删；
 *   4. `getToolSchemas` 返回 kb_search / kb_list；
 *   5. `handleToolCall` 按 name 分发；
 *   6. `name` 固定 "knowledge-base"（非 "builtin"），占用 external 槽位。
 *
 * 与其他 Provider 的关系：
 *   - 与 BuiltinMemoryProvider（若存在）共存：builtin 管对话记忆，KB 管文档知识；
 *   - Orchestrator 限制最多 1 个 external provider，故 KB 与 Mem0/Honcho 互斥。
 */

import type {
  IMemoryProvider,
  MemoryProviderConfig,
} from "../memory/provider.js";
import type {
  LLMMessage,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../types/index.js";
import { searchHybrid } from "./retrieval/hybrid.js";
import type { KBEmbedder } from "./storage/vector-index.js";
import {
  createKbListTool,
  createKbSearchTool,
  type KbToolDeps,
} from "./tools/kb-search.js";
import type { RetrievedChunk } from "./types.js";
import pino from "pino";
const logger = pino({ name: "kb-provider" });

/** KnowledgeBaseProvider 构造参数 */
export interface KnowledgeBaseProviderOptions {
  /** 与入库一致的 embedder */
  embedder: KBEmbedder;
  /** prefetch 默认 topK（仅影响 prefetch 注入；kb_search 工具默认 topK=5，独立与此参数） */
  prefetchTopK?: number;
  /** prefetch 最大 token 累计预算（Spec §6 默认 2000） */
  prefetchMaxTokens?: number;
  /** prefetch 最低分数阈值（归一化后 [0,1]；默认不过滤） */
  prefetchMinScore?: number;
  /**
   * systemPromptBlock 返回的静态片段（可选）。
   * 若为空字符串，Provider 不贡献 system prompt（prefetch 才动态注入）。
   */
  systemPromptHint?: string;
}

/** KB prefetch 的格式化选项 */
const PREFETCH_HEADER = "## 知识库参考资料";
const PREFETCH_SEP = "---";

/**
 * 把命中结果格式化为人类可读的 Markdown 片段。
 *
 * @example
 * ## 知识库参考资料
 * ### foo.md
 * 内容...
 * ---
 * ### bar.pdf
 * 内容...
 */
export function formatKbPrefetch(hits: RetrievedChunk[]): string {
  if (hits.length === 0) return "";
  const blocks: string[] = [PREFETCH_HEADER];
  for (const h of hits) {
    blocks.push(`### ${h.document.filename}`);
    blocks.push(h.chunk.content.trim());
    blocks.push(PREFETCH_SEP);
  }
  // 去掉尾部多余的 ---
  if (blocks[blocks.length - 1] === PREFETCH_SEP) blocks.pop();
  return blocks.join("\n");
}

export class KnowledgeBaseProvider implements IMemoryProvider {
  public readonly name = "knowledge-base";

  private _config: MemoryProviderConfig | null = null;
  private _toolDeps: KbToolDeps;
  private _tools: ToolDefinition[];

  constructor(private readonly opts: KnowledgeBaseProviderOptions) {
    if (!opts.embedder) {
      throw new Error("KnowledgeBaseProvider: embedder is required");
    }
    // 构造时即创建工具（agentId/userId 使用 null 作为默认 fallback，
    // 工具执行时优先从 ToolContext 读取实际隔离值——支持全局工具注册模式）
    this._toolDeps = {
      embedder: this.opts.embedder,
      agentId: null,
      userId: null,
      defaultTopK: this.opts.prefetchTopK ?? 5,
      defaultMaxTokens: this.opts.prefetchMaxTokens ?? 2000,
    };
    this._tools = [
      createKbSearchTool(this._toolDeps),
      createKbListTool(this._toolDeps),
    ];
  }

  // ── 生命周期 ────────────────────────────────────────────

  /**
   * 初始化：记录会话上下文，构造运行时工具定义（带隔离作用域）。
   *
   * MemoryProviderConfig.userId 缺省 → 视为全局库（userId = null）。
   * agentId 必填。
   */
  async initialize(config: MemoryProviderConfig): Promise<void> {
    this._config = config;
    this._toolDeps = {
      embedder: this.opts.embedder,
      agentId: config.agentId ?? null,
      userId: config.userId ?? null,
      defaultTopK: this.opts.prefetchTopK ?? 5,
      defaultMaxTokens: this.opts.prefetchMaxTokens ?? 2000,
    };
    // 工具定义只在 initialize 后生成（依赖 scope）
    this._tools = [
      createKbSearchTool(this._toolDeps),
      createKbListTool(this._toolDeps),
    ];
  }

  /**
   * 关闭：本 Provider 无外部连接 / 后台任务，仅清理引用。
   */
  async shutdown(): Promise<void> {
    this._config = null;
    // _toolDeps 和 _tools 在构造时即初始化且不再为 null，shutdown 不重置
  }

  // ── System Prompt 贡献 ─────────────────────────────────

  /**
   * 静态提示片段（可选）。
   * 默认空 —— prefetch 会在每轮动态注入具体命中。
   */
  systemPromptBlock(): string {
    return this.opts.systemPromptHint ?? "";
  }

  // ── 每轮回调 ────────────────────────────────────────────

  /**
   * 预取：基于 query 做混合检索，格式化为 Markdown 注入 prompt。
   *
   * 故障隔离：任何异常都转成空字符串（Orchestrator.prefetchAll 本身也会 catch，
   *           但本层提前 swallow 可避免 rejection 打印 stack trace）。
   */
  async prefetch(query: string): Promise<string> {
    if (!query || query.trim().length === 0) return "";
    try {
      const hits = await searchHybrid({
        query,
        embedder: this._toolDeps.embedder,
        agentId: this._toolDeps.agentId,
        userId: this._toolDeps.userId,
        topK: this.opts.prefetchTopK ?? 3,
        maxTokens: this.opts.prefetchMaxTokens ?? 2000,
        minScore: this.opts.prefetchMinScore,
      });
      return formatKbPrefetch(hits);
    } catch (err) {
      logger.error({ err }, "KnowledgeBaseProvider prefetch failed");
      return "";
    }
  }

  /**
   * 同步阶段：KB 只读，不受对话内容影响，no-op。
   */
  async syncTurn(_userContent: string, _assistantContent: string): Promise<void> {
    // 知识库不随对话更新；文档的增删走独立的 ingestion 流水线。
    return;
  }

  // ── 工具注册 ────────────────────────────────────────────

  getToolSchemas(): ToolDefinition[] {
    return this._tools;
  }

  async handleToolCall(
    toolName: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this._tools.find((t) => t.name === toolName);
    if (!tool) {
      return {
        success: false,
        output: `KnowledgeBaseProvider: unknown tool "${toolName}"`,
        error: "unknown_tool",
      };
    }
    return tool.execute(args, ctx);
  }

  // ── 可选钩子：全部 no-op（KB 只读） ─────────────────────

  onTurnStart(_turnNumber: number, _message: string): void {
    // KB 不关心轮次起点
  }

  onSessionEnd(_messages: LLMMessage[]): void {
    // KB 不需要 session 结束持久化
  }

  onPreCompress(_messages: LLMMessage[]): string {
    // KB 不向上下文注入压缩保留内容
    return "";
  }

  onMemoryWrite(_action: string, _target: string, _content: string): void {
    // KB 写入走独立 ingestion 流水线，不由此通道触发
  }
}
