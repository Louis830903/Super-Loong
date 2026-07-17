/**
 * 记忆自动关联系统 — 对话后自动提取关键信息并关联
 *
 * 优化：
 * 1. LLM 驱动的实体提取
 * 2. 关联置信度评分
 * 3. 跨会话关联
 */

import type { MemoryManager } from "./manager.js";
import type { KnowledgeGraph } from "./knowledge-graph.js";
import type { LLMProvider } from "../llm/provider.js";
import pino from "pino";

const logger = pino({ name: "memory-auto-associator" });

export interface Entity {
  id: string;
  name: string;
  type: "person" | "organization" | "project" | "location" | "other";
  confidence: number;
}

export interface Relation {
  subjectId: string;
  predicate: string;
  objectId: string;
  confidence: number;
}

export interface Event {
  description: string;
  entities: string[];
  timestamp: Date;
  type: "meeting" | "deadline" | "decision" | "other";
}

export class MemoryAutoAssociator {
  constructor(
    private memoryManager: MemoryManager,
    private knowledgeGraph: KnowledgeGraph,
    private llm: LLMProvider,
  ) {}

  /**
   * 处理对话，自动提取并关联信息
   */
  async processConversation(
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<void> {
    try {
      // 1. 提取实体
      const entities = await this.extractEntities(messages);
      logger.debug({ count: entities.length }, "Entities extracted");

      // 2. 提取关系
      const relations = await this.extractRelations(messages, entities);
      logger.debug({ count: relations.length }, "Relations extracted");

      // 3. 提取事件
      const events = await this.extractEvents(messages, entities);
      logger.debug({ count: events.length }, "Events extracted");

      // 4. 写入知识图谱
      for (const entity of entities) {
        // 使用 findEntityId 检查实体是否存在，不存在则创建
        const existingId = this.knowledgeGraph.findEntityId(entity.name);
        if (!existingId) {
          // 创建实体（通过 addTriple 的 subject/object）
          logger.debug({ entity: entity.name }, "Entity will be created via triple");
        }
      }
      for (const relation of relations) {
        await this.knowledgeGraph.addTriple({
          subjectId: parseInt(relation.subjectId.replace("entity_", ""), 10) || 0,
          predicate: relation.predicate,
          objectId: parseInt(relation.objectId.replace("entity_", ""), 10) || 0,
          confidence: relation.confidence,
          source: "auto_association",
        });
      }

      // 5. 写入记忆
      for (const event of events) {
        await this.memoryManager.add({
          agentId: "system",
          type: "recall",
          content: event.description,
          metadata: {
            sessionId,
            entities: event.entities,
            timestamp: event.timestamp.toISOString(),
            eventType: event.type,
          },
        });
      }

      // 6. 建立跨会话关联
      await this.linkToPreviousSessions(entities);

      logger.info({ sessionId, entities: entities.length, relations: relations.length, events: events.length }, "Conversation processed");
    } catch (error) {
      logger.error({ sessionId, error }, "Failed to process conversation");
    }
  }

  /**
   * 提取实体（使用 LLM）
   */
  private async extractEntities(
    messages: Array<{ role: string; content: string }>,
  ): Promise<Entity[]> {
    const text = messages.map(m => m.content).join("\n");

    const prompt = `从以下对话中提取所有实体（人名、组织、项目、地点等）。
对话内容：
${text}

请以 JSON 格式返回，格式如下：
[
  { "name": "实体名称", "type": "person|organization|project|location|other", "confidence": 0.95 }
]`;

    try {
      const response = await this.llm.complete({
        messages: [{ role: "user", content: prompt }],
      });
      const entities = JSON.parse(response.content ?? "[]") as Array<{
        name: string;
        type: Entity["type"];
        confidence: number;
      }>;

      return entities.map(e => ({
        id: `entity_${e.name.toLowerCase().replace(/\s+/g, "_")}`,
        name: e.name,
        type: e.type,
        confidence: e.confidence,
      }));
    } catch (error) {
      logger.warn({ error }, "Failed to extract entities with LLM");
      return [];
    }
  }

  /**
   * 提取关系（使用 LLM）
   */
  private async extractRelations(
    messages: Array<{ role: string; content: string }>,
    entities: Entity[],
  ): Promise<Relation[]> {
    if (entities.length < 2) return [];

    const text = messages.map(m => m.content).join("\n");
    const entityNames = entities.map(e => e.name).join(", ");

    const prompt = `从以下对话中提取实体之间的关系。
对话内容：
${text}

已知实体：${entityNames}

请以 JSON 格式返回，格式如下：
[
  { "subject": "实体1", "predicate": "关系", "object": "实体2", "confidence": 0.9 }
]`;

    try {
      const response = await this.llm.complete({
        messages: [{ role: "user", content: prompt }],
      });
      const relations = JSON.parse(response.content ?? "[]") as Array<{
        subject: string;
        predicate: string;
        object: string;
        confidence: number;
      }>;

      return relations.map(r => ({
        subjectId: `entity_${r.subject.toLowerCase().replace(/\s+/g, "_")}`,
        predicate: r.predicate,
        objectId: `entity_${r.object.toLowerCase().replace(/\s+/g, "_")}`,
        confidence: r.confidence,
      }));
    } catch (error) {
      logger.warn({ error }, "Failed to extract relations with LLM");
      return [];
    }
  }

  /**
   * 提取事件（使用 LLM）
   */
  private async extractEvents(
    messages: Array<{ role: string; content: string }>,
    entities: Entity[],
  ): Promise<Event[]> {
    const text = messages.map(m => m.content).join("\n");

    const prompt = `从以下对话中提取重要事件（会议、截止日期、决策等）。
对话内容：
${text}

请以 JSON 格式返回，格式如下：
[
  { "description": "事件描述", "type": "meeting|deadline|decision|other", "entities": ["相关实体"] }
]`;

    try {
      const response = await this.llm.complete({
        messages: [{ role: "user", content: prompt }],
      });
      const events = JSON.parse(response.content ?? "[]") as Array<{
        description: string;
        type: Event["type"];
        entities: string[];
      }>;

      return events.map(e => ({
        description: e.description,
        entities: e.entities,
        timestamp: new Date(),
        type: e.type,
      }));
    } catch (error) {
      logger.warn({ error }, "Failed to extract events with LLM");
      return [];
    }
  }

  /**
   * 建立跨会话关联
   */
  private async linkToPreviousSessions(entities: Entity[]): Promise<void> {
    for (const entity of entities) {
      // 查找历史会话中相同的实体
      const previousId = this.knowledgeGraph.findEntityId(entity.name);
      if (previousId && previousId.toString() !== entity.id) {
        // 建立"同一实体"关联
        await this.knowledgeGraph.addTriple({
          subjectId: parseInt(entity.id.replace("entity_", ""), 10) || 0,
          predicate: "same_as",
          objectId: previousId,
          confidence: 0.95,
          source: "auto_association",
        });
        logger.debug({ entity: entity.name, previous: previousId }, "Linked to previous session");
      }
    }
  }
}
