/**
 * 自动记忆系统 — 对话后自动提取关键信息并关联
 *
 * 功能：
 * - 对话自动摘要
 * - 实体提取
 * - 主题提取
 * - 行动项提取
 * - 跨会话关联
 */

import type { MemoryManager } from "./manager.js";
import type { KnowledgeGraph } from "./knowledge-graph.js";
import type { LLMProvider } from "../llm/provider.js";
import pino from "pino";

const logger = pino({ name: "auto-memory" });

export interface ExtractedEntity {
  name: string;
  type: "person" | "project" | "date" | "location" | "organization" | "task";
  confidence: number;
  context: string;
}

export interface ConversationSummary {
  summary: string;
  entities: ExtractedEntity[];
  topics: string[];
  actionItems: string[];
}

export class AutoMemorySystem {
  constructor(
    private memoryManager: MemoryManager,
    private knowledgeGraph: KnowledgeGraph,
    private llm: LLMProvider,
  ) {}

  /**
   * 对话结束后自动处理（合并为 1 次 LLM 调用）
   */
  async processConversation(
    sessionId: string,
    agentId: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<void> {
    try {
      // 合并为 1 次 LLM 调用
      const result = await this.extractAll(messages);

      // 写入记忆
      await this.memoryManager.add({
        agentId,
        type: "recall",
        content: result.summary,
        metadata: {
          sessionId,
          entities: result.entities.map(e => e.name),
          topics: result.topics,
          actionItems: result.actionItems,
          timestamp: new Date().toISOString(),
        },
      });

      // 写入知识图谱
      for (const entity of result.entities) {
        await this.linkEntityToGraph(entity, sessionId);
      }

      // 建立跨会话关联
      await this.linkToPreviousSessions(result.entities, result.topics);

      logger.info({ sessionId, entities: result.entities.length }, "Auto-memory processed");
    } catch (error) {
      logger.error({ sessionId, error }, "Failed to process auto-memory");
    }
  }

  /**
   * 合并提取所有信息（1 次 LLM 调用）
   */
  private async extractAll(messages: Array<{ role: string; content: string }>): Promise<{
    summary: string;
    entities: ExtractedEntity[];
    topics: string[];
    actionItems: string[];
  }> {
    const text = messages.map(m => `${m.role}: ${m.content}`).join("\n");

    const response = await this.llm.complete({
      messages: [{
        role: "user",
        content: `请为以下对话生成摘要、提取实体、主题和行动项。

对话内容：
${text}

请以 JSON 格式返回：
{
  "summary": "对话摘要",
  "entities": [{"name": "实体名", "type": "person|project|date|location|organization|task", "confidence": 0.95}],
  "topics": ["主题1", "主题2"],
  "actionItems": ["行动项1", "行动项2"]
}`,
      }],
    });

    try {
      return JSON.parse(response.content ?? "{}");
    } catch {
      return { summary: "", entities: [], topics: [], actionItems: [] };
    }
  }

  /**
   * 将实体链接到知识图谱
   */
  private async linkEntityToGraph(entity: ExtractedEntity, sessionId: string): Promise<void> {
    // 查找或创建实体
    const entityId = this.knowledgeGraph.findEntityId(entity.name);

    if (!entityId) {
      // 创建新实体（通过添加三元组）
      logger.debug({ entity: entity.name }, "New entity discovered");
    }

    // 添加会话关联
    await this.knowledgeGraph.addTriple({
      subjectId: entityId ?? 0,
      predicate: "mentioned_in",
      objectId: sessionId as any,
      confidence: entity.confidence,
      source: "auto_memory",
    });
  }

  /**
   * 建立跨会话关联
   */
  private async linkToPreviousSessions(entities: ExtractedEntity[], topics: string[]): Promise<void> {
    for (const entity of entities) {
      const previousId = this.knowledgeGraph.findEntityId(entity.name);
      if (previousId) {
        // 建立"同一实体"关联
        await this.knowledgeGraph.addTriple({
          subjectId: previousId,
          predicate: "same_as",
          objectId: previousId,
          confidence: 0.95,
          source: "auto_memory",
        });
      }
    }
  }

  /**
   * 查询相关记忆（使用 searchEntities）
   */
  async queryRelatedMemory(query: string, agentId: string): Promise<string[]> {
    // 使用 searchEntities 查找相关实体
    const entityIds = this.knowledgeGraph.searchEntities(query);

    // 检索相关记忆
    const memories = await this.memoryManager.search(query, { agentId }, 5);

    return memories.map(m => m.entry.content);
  }
}
