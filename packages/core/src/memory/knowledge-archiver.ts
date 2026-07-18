/**
 * 个人知识库 — 对话自动归档为知识库（P0-4 真实现）
 *
 * 功能：
 * - 按 session 归档单次对话（不再无脑堆叠 agent 全部记忆）
 * - LLM 提炼结构化知识条目（标题 + 要点 + 标签），无 LLM 时降级原文归档
 * - 知识库搜索 / 分类统计
 */

import type { MemoryManager } from "./manager.js";
import type { KnowledgeGraph } from "./knowledge-graph.js";
import type { LLMProvider } from "../llm/provider.js";
import pino from "pino";

const logger = pino({ name: "knowledge-archiver" });

/** 归档用的对话消息 */
export interface ArchiveMessage {
  role: string;
  content: string;
}

/** LLM 提炼出的结构化知识条目 */
export interface DistilledKnowledge {
  title: string;
  keyPoints: string[];
  tags: string[];
  summary: string;
}

export class KnowledgeArchiver {
  constructor(
    private memoryManager: MemoryManager,
    private knowledgeGraph: KnowledgeGraph,
    // P0-4: 可选 LLM，用于提炼结构化知识；缺省时降级为原文归档
    private llm?: LLMProvider,
  ) {}

  /**
   * 归档对话到知识库（P0-4：按 session 粒度 + LLM 提炼）。
   *
   * @param sessionId 会话 ID（归档粒度，避免重复归档 agent 全部记忆）
   * @param agentId   归属 agent
   * @param category  知识分类
   * @param messages  本次会话的对话消息（由调用方传入，而非拉取全部记忆）
   */
  async archiveConversation(
    sessionId: string,
    agentId: string,
    category: string,
    messages: ArchiveMessage[],
  ): Promise<void> {
    try {
      if (!messages || messages.length === 0) {
        logger.warn({ sessionId }, "No messages to archive, skipping");
        return;
      }

      // 1. LLM 提炼结构化知识（失败降级原文）
      const distilled = await this.distill(messages, category);

      // 2. 格式化为知识条目 Markdown
      const knowledgeEntry = this.formatEntry(distilled, category);

      // 3. 写入知识库（archival 类型）
      await this.memoryManager.add({
        agentId,
        type: "archival",
        content: knowledgeEntry,
        metadata: {
          sessionId,
          category,
          title: distilled.title,
          tags: distilled.tags,
          archivedAt: new Date().toISOString(),
          distilled: this.llm ? true : false,
        },
      });

      logger.info({ sessionId, category, title: distilled.title, distilled: !!this.llm }, "Conversation archived to knowledge base");
    } catch (error) {
      logger.error({ sessionId, error }, "Failed to archive conversation");
    }
  }

  /**
   * LLM 提炼结构化知识（1 次调用）；无 LLM 或失败时降级原文摘要。
   */
  private async distill(messages: ArchiveMessage[], category: string): Promise<DistilledKnowledge> {
    const text = messages.map((m) => `${m.role}: ${m.content}`).join("\n");

    // 降级：无 LLM 时用原文构造基础条目
    if (!this.llm) {
      return this.fallbackDistill(messages, category);
    }

    try {
      const response = await this.llm.complete({
        messages: [{
          role: "user",
          content: `请把以下对话提炼为一条结构化知识条目，用于个人知识库归档。

对话内容：
${text}

请以 JSON 格式返回（不要输出多余文字）：
{
  "title": "简洁标题（不超过 30 字）",
  "keyPoints": ["关键要点1", "关键要点2"],
  "tags": ["标签1", "标签2"],
  "summary": "一段话总结（不超过 200 字）"
}`,
        }],
      });

      const parsed = JSON.parse(response.content ?? "{}") as Partial<DistilledKnowledge>;
      return {
        title: parsed.title || `${category} 知识条目`,
        keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
        tags: Array.isArray(parsed.tags) ? parsed.tags : [category],
        summary: parsed.summary || "",
      };
    } catch (err) {
      logger.warn({ err }, "LLM distill failed, falling back to raw archive");
      return this.fallbackDistill(messages, category);
    }
  }

  /**
   * 降级提炼：无 LLM 时用对话原文构造基础条目（不堆叠、截断保护）。
   */
  private fallbackDistill(messages: ArchiveMessage[], category: string): DistilledKnowledge {
    const summary = messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n")
      .slice(0, 2000);
    return {
      title: `${category} 归档（${new Date().toLocaleDateString("zh-CN")}）`,
      keyPoints: [],
      tags: [category],
      summary,
    };
  }

  /**
   * 把提炼结果格式化为知识条目 Markdown。
   */
  private formatEntry(k: DistilledKnowledge, category: string): string {
    const lines = [
      `# ${k.title}`,
      "",
      `> 分类：${category} ｜ 归档时间：${new Date().toISOString()}`,
      "",
    ];

    if (k.tags.length > 0) {
      lines.push(`**标签**：${k.tags.map((t) => `#${t}`).join(" ")}`, "");
    }

    if (k.summary) {
      lines.push("## 摘要", "", k.summary, "");
    }

    if (k.keyPoints.length > 0) {
      lines.push("## 关键要点", "");
      for (const point of k.keyPoints) {
        lines.push(`- ${point}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * 搜索知识库
   */
  async searchKnowledge(query: string, agentId: string): Promise<Array<{ id: string; content: string; score: number }>> {
    const results = await this.memoryManager.search(query, { agentId, type: "archival" }, 10);
    return results.map((r) => ({ id: r.entry.id, content: r.entry.content, score: r.score }));
  }

  /**
   * 获取知识库统计
   */
  async getStats(agentId: string): Promise<{
    total: number;
    byCategory: Record<string, number>;
  }> {
    const memories = await this.memoryManager.list({ agentId, type: "archival" });
    const byCategory: Record<string, number> = {};

    for (const memory of memories) {
      const category = (memory.metadata?.category as string) ?? "未分类";
      byCategory[category] = (byCategory[category] ?? 0) + 1;
    }

    return {
      total: memories.length,
      byCategory,
    };
  }
}
