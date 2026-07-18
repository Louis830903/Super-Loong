/**
 * 个人知识库 — 对话自动归档为知识库
 *
 * 功能：
 * - 对话自动归档
 * - 知识条目生成
 * - 知识库搜索
 */

import type { MemoryManager } from "./manager.js";
import type { KnowledgeGraph } from "./knowledge-graph.js";
import pino from "pino";

const logger = pino({ name: "knowledge-archiver" });

export class KnowledgeArchiver {
  constructor(
    private memoryManager: MemoryManager,
    private knowledgeGraph: KnowledgeGraph,
  ) {}

  /**
   * 归档对话到知识库
   */
  async archiveConversation(
    sessionId: string,
    agentId: string,
    category: string,
  ): Promise<void> {
    try {
      // 1. 获取对话记录
      const memories = await this.memoryManager.list({ agentId });

      // 2. 生成知识条目
      const knowledgeEntry = this.generateKnowledgeEntry(memories, category);

      // 3. 写入知识库
      await this.memoryManager.add({
        agentId,
        type: "archival",
        content: knowledgeEntry,
        metadata: {
          sessionId,
          category,
          archivedAt: new Date().toISOString(),
        },
      });

      logger.info({ sessionId, category }, "Conversation archived to knowledge base");
    } catch (error) {
      logger.error({ sessionId, error }, "Failed to archive conversation");
    }
  }

  /**
   * 生成知识条目
   */
  private generateKnowledgeEntry(memories: any[], category: string): string {
    const lines = [
      `# ${category}`,
      "",
      `> 归档时间：${new Date().toISOString()}`,
      "",
      "## 对话内容",
      "",
    ];

    for (const memory of memories) {
      lines.push(`### ${memory.type}`);
      lines.push("");
      lines.push(memory.content);
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * 搜索知识库
   */
  async searchKnowledge(query: string, agentId: string): Promise<any[]> {
    return this.memoryManager.search(query, { agentId, type: "archival" }, 10);
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
      const category = memory.metadata?.category as string ?? "未分类";
      byCategory[category] = (byCategory[category] ?? 0) + 1;
    }

    return {
      total: memories.length,
      byCategory,
    };
  }
}
