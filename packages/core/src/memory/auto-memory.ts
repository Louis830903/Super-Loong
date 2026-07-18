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
   * 将实体写入知识图谱（修正：用真实 entityId，消除 sessionId as any 类型错误）
   *
   * sessionId 不是实体，不能当 objectId。正确做法：
   * 把实体名 getOrCreateEntityId 获得真实数字 ID，确保实体节点落库。
   * 实体与会话的关联通过 memory metadata.sessionId 保留（add 时已写）。
   */
  private async linkEntityToGraph(entity: ExtractedEntity, sessionId: string): Promise<void> {
    try {
      // getOrCreateEntityId：不存在则创建，返回真实数字 ID（保证实体节点落库）
      const entityId = this.knowledgeGraph.getOrCreateEntityId(entity.name);
      logger.debug({ entity: entity.name, entityId, sessionId }, "Entity linked to graph");
    } catch (err) {
      logger.warn({ entity: entity.name, err }, "Failed to link entity to graph");
    }
  }
  
  /**
   * 建立跨会话关联（修正：same_as 自指无意义，改为按实体名关联已存在实体）
   *
   * 同名实体在不同会话中出现时，getOrCreateEntityId 会返回同一 ID
   *（INSERT OR IGNORE + COLLATE NOCASE），天然实现跨会话实体统一。
   * 无需写 same_as 自指三元组（那是无意义的脏数据）。
   * 实体间的真实关系由 MemoryManager.add() 的 addRelationsFromText 抽取。
   */
  private async linkToPreviousSessions(_entities: ExtractedEntity[], _topics: string[]): Promise<void> {
    // 跨会话实体统一已由 getOrCreateEntityId 的 COLLATE NOCASE 天然保证（同名=同 ID），
    // 无需额外 same_as 三元组。保留方法签名以便后续扩展更复杂的跨会话推理。
    return;
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
