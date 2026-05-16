/**
 * T6.2 — 知识图谱核心模块
 *
 * 在 SQLite relations 表上实现三元组 CRUD + 递归 CTE 子图查询 + 路径搜索。
 * 纯 SQLite 零外部依赖，对齐 hello-agents 第 8 章 SemanticMemory 设计。
 *
 * 核心能力：
 *   - addTriple / upsertTriple：写入三元组
 *   - getOutgoing / getIncoming：单步邻居查询
 *   - subgraph：递归 CTE 多跳子图（maxDepth 默认 3，含环保护）
 *   - findPath：从 A 到 B 的最短路径（BFS + CTE）
 *   - exportSubgraph：导出 JSON / Mermaid / GraphML 三种格式
 */

import pino from "pino";
import { randomUUID } from "node:crypto";
import { getDatabase, scheduleSave } from "../persistence/sqlite.js";
import type { EntityRow } from "./entity-resolver.js";
import { extractRelations } from "./relation-extractor.js";

const logger = pino({ name: "knowledge-graph" });

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/** 三元组：主体 → 谓词 → 客体 */
export interface Triple {
  id: string;
  subjectId: number;
  predicate: string;
  objectId: number;
  confidence: number;
  source: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

/** 新建三元组的输入参数（id 和 createdAt 自动生成） */
export interface TripleInput {
  subjectId: number;
  predicate: string;
  objectId: number;
  confidence?: number;
  source: string;
  metadata?: Record<string, unknown>;
}

/** 子图结构：节点集 + 边集 */
export interface Subgraph {
  nodes: EntityRow[];
  edges: Triple[];
}

/** 导出格式 */
export type ExportFormat = "json" | "mermaid" | "graphml";

// ═══════════════════════════════════════════════════════════════
// 节点数熔断阈值（防递归 CTE 在大图上爆炸）
// ═══════════════════════════════════════════════════════════════
const MAX_SUBGRAPH_NODES = 500;

// ═══════════════════════════════════════════════════════════════
// KnowledgeGraph 核心类
// ═══════════════════════════════════════════════════════════════

export class KnowledgeGraph {
  private get db() {
    return getDatabase();
  }

  // ─── 写入 ─────────────────────────────────────────────────

  /** 添加三元组，返回生成的 id */
  addTriple(input: TripleInput): string {
    const id = `rel_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO relations (id, subjectId, predicate, objectId, confidence, source, createdAt, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.subjectId,
        input.predicate,
        input.objectId,
        input.confidence ?? 0.5,
        input.source,
        now,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    scheduleSave();
    logger.debug({ id, subjectId: input.subjectId, predicate: input.predicate, objectId: input.objectId }, "triple added");
    return id;
  }

  /**
   * Upsert 三元组：同三元组已存在时取最大 confidence。
   * 利用 idx_relations_triple 唯一索引做冲突检测。
   */
  upsertTriple(input: TripleInput): void {
    const id = `rel_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO relations (id, subjectId, predicate, objectId, confidence, source, createdAt, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subjectId, predicate, objectId) DO UPDATE SET
         confidence = MAX(relations.confidence, excluded.confidence),
         metadata = excluded.metadata`,
      [
        id,
        input.subjectId,
        input.predicate,
        input.objectId,
        input.confidence ?? 0.5,
        input.source,
        now,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    scheduleSave();
  }

  /** 删除三元组 */
  removeTriple(tripleId: string): boolean {
    this.db.run("DELETE FROM relations WHERE id = ?", [tripleId]);
    scheduleSave();
    return true;
  }

  /** 按 source 批量删除（如清理推理结果） */
  removeBySource(source: string): number {
    const before = this.countTriples();
    this.db.run("DELETE FROM relations WHERE source = ?", [source]);
    scheduleSave();
    return before - this.countTriples();
  }

  /** 统计三元组总数 */
  countTriples(): number {
    const results = this.db.exec("SELECT COUNT(*) FROM relations");
    return results.length ? (results[0].values[0][0] as number) : 0;
  }

  // ─── 实体解析 ───────────────────────────────────────────────

  /**
   * 按名称查找实体 ID（不区分大小写）。
   * 仅查找不创建，用于搜索路径避免污染实体表。
   */
  findEntityId(name: string): number | null {
    const results = this.db.exec(
      "SELECT id FROM entities WHERE name = ? COLLATE NOCASE",
      [name],
    );
    if (results.length && results[0].values.length) {
      return results[0].values[0][0] as number;
    }
    return null;
  }

  /**
   * 按名称查找或创建实体，返回实体 ID。
   * 用于关系写入路径（实体不存在时自动创建）。
   */
  getOrCreateEntityId(name: string): number {
    // P1 修复：使用 INSERT OR IGNORE 防止并发创建大小写重复实体
    // （findEntityId 和 INSERT 之间有竞争窗口，INSERT OR IGNORE + UNIQUE 约束原子化这个操作）
    this.db.run(
      "INSERT OR IGNORE INTO entities (name, entityType, aliases, createdAt) VALUES (?, ?, ?, ?)",
      [name, "unknown", "[]", new Date().toISOString()],
    );
    scheduleSave();
    // INSERT OR IGNORE 后统一用 COLLATE NOCASE 查询获取 ID（无论新建还是已存在）
    const newResults = this.db.exec(
      "SELECT id FROM entities WHERE name = ? COLLATE NOCASE",
      [name],
    );
    return newResults[0].values[0][0] as number;
  }

  // ─── 关系抽取集成 ─────────────────────────────────────────

  /**
   * T6.3: 从文本中抽取实体间关系并写入三元组表。
   * 在 MemoryManager.add() 中调用，source = memoryId。
   * @returns 实际写入的三元组数量
   */
  addRelationsFromText(memoryId: string, content: string, entityNames: string[]): number {
    if (entityNames.length < 2) return 0;

    const candidates = extractRelations(content, entityNames);
    let count = 0;

    for (const c of candidates) {
      try {
        const subjectId = this.getOrCreateEntityId(c.subject);
        const objectId = this.getOrCreateEntityId(c.object);
        this.upsertTriple({
          subjectId,
          predicate: c.predicate,
          objectId,
          confidence: c.confidence,
          source: memoryId,
        });
        count++;
      } catch (err) {
        logger.warn({ subject: c.subject, predicate: c.predicate, object: c.object, err }, "failed to upsert relation triple");
      }
    }

    logger.debug({ memoryId, candidateCount: candidates.length, writtenCount: count }, "relations extracted from text");
    return count;
  }

  /**
   * T6.4: 通过实体 ID 集合查找关联的记忆 ID 列表。
   * 用于图扩展检索：子图实体 → 反查 memory_entities → 关联记忆。
   */
  findMemoriesByEntityIds(entityIds: number[]): string[] {
    if (entityIds.length === 0) return [];
    const placeholders = entityIds.map(() => "?").join(",");
    const results = this.db.exec(
      `SELECT DISTINCT memoryId FROM memory_entities WHERE entityId IN (${placeholders})`,
      entityIds,
    );
    if (!results.length || !results[0].values.length) return [];
    return results[0].values.map((row: unknown[]) => row[0] as string);
  }

  // ─── 查询 ─────────────────────────────────────────────────

  /** 获取某实体的所有出边（可选按 predicate 过滤） */
  getOutgoing(subjectId: number, predicate?: string): Triple[] {
    const sql = predicate
      ? "SELECT * FROM relations WHERE subjectId = ? AND predicate = ?"
      : "SELECT * FROM relations WHERE subjectId = ?";
    const params = predicate ? [subjectId, predicate] : [subjectId];
    return this.queryTriples(sql, params);
  }

  /** 获取某实体的所有入边（可选按 predicate 过滤） */
  getIncoming(objectId: number, predicate?: string): Triple[] {
    const sql = predicate
      ? "SELECT * FROM relations WHERE objectId = ? AND predicate = ?"
      : "SELECT * FROM relations WHERE objectId = ?";
    const params = predicate ? [objectId, predicate] : [objectId];
    return this.queryTriples(sql, params);
  }

  // ─── 递归 CTE 子图查询 ────────────────────────────────────

  /**
   * 从 rootId 出发做 BFS 子图遍历，收集所有深度 ≤ maxDepth 的节点和边。
   * 使用 SQLite 递归 CTE 实现，含环保护（DISTINCT + visited 集合）。
   * maxDepth 默认 3，MAX_SUBGRAPH_NODES 熔断兜底。
   */
  subgraph(rootId: number, maxDepth = 3): Subgraph {
    // 用递归 CTE 收集所有可达节点 id（双向：出边 + 入边）
    const results = this.db.exec(
      `WITH RECURSIVE walk(id, depth) AS (
        SELECT ?, 0
        UNION
        SELECT r.objectId, w.depth + 1
        FROM relations r JOIN walk w ON r.subjectId = w.id
        WHERE w.depth < ? AND w.depth < 10
        UNION
        SELECT r.subjectId, w.depth + 1
        FROM relations r JOIN walk w ON r.objectId = w.id
        WHERE w.depth < ? AND w.depth < 10
      )
      SELECT DISTINCT id FROM walk LIMIT ?`,
      [rootId, maxDepth, maxDepth, MAX_SUBGRAPH_NODES],
    );

    if (!results.length || !results[0].values.length) {
      return { nodes: [], edges: [] };
    }

    const nodeIds = results[0].values.map((row: unknown[]) => row[0] as number);

    // 收集这些节点间的所有边
    const placeholders = nodeIds.map(() => "?").join(",");
    const edgeResults = this.db.exec(
      `SELECT * FROM relations WHERE subjectId IN (${placeholders}) AND objectId IN (${placeholders})`,
      [...nodeIds, ...nodeIds],
    );
    const edges = edgeResults.length ? this.parseTripleResults(edgeResults[0]) : [];

    // 收集节点实体信息
    const nodeResults = this.db.exec(
      `SELECT * FROM entities WHERE id IN (${placeholders})`,
      nodeIds,
    );
    const nodes = nodeResults.length ? this.parseEntityResults(nodeResults[0]) : [];

    logger.debug({ rootId, maxDepth, nodeCount: nodes.length, edgeCount: edges.length }, "subgraph traversed");
    return { nodes, edges };
  }

  // ─── 路径搜索 ─────────────────────────────────────────────

  /**
   * 从 fromId 到 toId 查找长度 ≤ maxHops 的路径。
   * 使用递归 CTE + path 列记录完整路径，找到第一条最短路径后返回。
   * 返回路径上的所有边（有序），如无路径返回空数组。
   */
  findPath(fromId: number, toId: number, maxHops = 5): Triple[] {
    // 递归 CTE 记录路径：path 列存储逗号分隔的节点 id 序列
    const results = this.db.exec(
      `WITH RECURSIVE pathfinder(nodeId, depth, path) AS (
        SELECT ?, 0, CAST(? AS TEXT)
        UNION ALL
        SELECT r.objectId, pf.depth + 1, pf.path || ',' || CAST(r.objectId AS TEXT)
        FROM relations r JOIN pathfinder pf ON r.subjectId = pf.nodeId
        WHERE pf.depth < ?
          AND INSTR(pf.path, CAST(r.objectId AS TEXT)) = 0
      )
      SELECT path FROM pathfinder WHERE nodeId = ? LIMIT 1`,
      [fromId, String(fromId), maxHops, toId],
    );

    if (!results.length || !results[0].values.length) {
      return [];
    }

    // 解析路径中相邻节点对，查找对应边
    const pathStr = results[0].values[0][0] as string;
    const nodeSeq = pathStr.split(",").map(Number);
    const pathEdges: Triple[] = [];

    for (let i = 0; i < nodeSeq.length - 1; i++) {
      const from = nodeSeq[i];
      const to = nodeSeq[i + 1];
      const edgeResult = this.db.exec(
        "SELECT * FROM relations WHERE subjectId = ? AND objectId = ? LIMIT 1",
        [from, to],
      );
      if (edgeResult.length && edgeResult[0].values.length) {
        const triples = this.parseTripleResults(edgeResult[0]);
        if (triples.length > 0) pathEdges.push(triples[0]);
      }
    }

    return pathEdges;
  }

  // ─── 导出 ─────────────────────────────────────────────────

  /** 导出子图为指定格式 */
  exportSubgraph(rootId: number, depth = 2, format: ExportFormat = "json"): string {
    const graph = this.subgraph(rootId, depth);

    switch (format) {
      case "json":
        return JSON.stringify(graph, null, 2);

      case "mermaid":
        return this.toMermaid(graph);

      case "graphml":
        return this.toGraphML(graph);

      default:
        return JSON.stringify(graph, null, 2);
    }
  }

  // ─── 内部辅助 ─────────────────────────────────────────────

  /** 执行查询返回 Triple 数组 */
  private queryTriples(sql: string, params: unknown[]): Triple[] {
    const results = this.db.exec(sql, params);
    if (!results.length) return [];
    return this.parseTripleResults(results[0]);
  }

  /** 从 sql.js exec 结果解析 Triple 列表 */
  private parseTripleResults(result: { columns: string[]; values: unknown[][] }): Triple[] {
    return result.values.map((vals) => {
      const row: Record<string, unknown> = {};
      result.columns.forEach((col, i) => { row[col] = vals[i]; });
      return {
        id: row.id as string,
        subjectId: row.subjectId as number,
        predicate: row.predicate as string,
        objectId: row.objectId as number,
        confidence: row.confidence as number,
        source: row.source as string,
        createdAt: row.createdAt as string,
        metadata: JSON.parse((row.metadata as string) || "{}"),
      };
    });
  }

  /** 从 sql.js exec 结果解析 EntityRow 列表 */
  private parseEntityResults(result: { columns: string[]; values: unknown[][] }): EntityRow[] {
    return result.values.map((vals) => {
      const row: Record<string, unknown> = {};
      result.columns.forEach((col, i) => { row[col] = vals[i]; });
      return {
        id: row.id as number,
        name: row.name as string,
        entityType: (row.entityType as string) ?? "unknown",
        aliases: JSON.parse((row.aliases as string) || "[]"),
        createdAt: row.createdAt as string,
      };
    });
  }

  /** 子图转 Mermaid 格式 */
  private toMermaid(graph: Subgraph): string {
    const lines: string[] = ["graph TD"];
    // 节点
    for (const node of graph.nodes) {
      const label = node.name.replace(/"/g, "'");
      lines.push(`    ${node.id}["${label} (${node.entityType})"]`);
    }
    // 边
    for (const edge of graph.edges) {
      const label = edge.predicate.replace(/"/g, "'");
      lines.push(`    ${edge.subjectId} -->|${label}| ${edge.objectId}`);
    }
    return lines.join("\n");
  }

  /** 子图转 GraphML 格式 */
  private toGraphML(graph: Subgraph): string {
    const lines: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
      '  <key id="name" for="node" attr.name="name" attr.type="string"/>',
      '  <key id="type" for="node" attr.name="entityType" attr.type="string"/>',
      '  <key id="predicate" for="edge" attr.name="predicate" attr.type="string"/>',
      '  <key id="confidence" for="edge" attr.name="confidence" attr.type="double"/>',
      '  <graph id="G" edgedefault="directed">',
    ];
    for (const node of graph.nodes) {
      lines.push(`    <node id="n${node.id}">`);
      lines.push(`      <data key="name">${this.xmlEscape(node.name)}</data>`);
      lines.push(`      <data key="type">${this.xmlEscape(node.entityType)}</data>`);
      lines.push(`    </node>`);
    }
    for (const edge of graph.edges) {
      lines.push(`    <edge id="${edge.id}" source="n${edge.subjectId}" target="n${edge.objectId}">`);
      lines.push(`      <data key="predicate">${this.xmlEscape(edge.predicate)}</data>`);
      lines.push(`      <data key="confidence">${edge.confidence}</data>`);
      lines.push(`    </edge>`);
    }
    lines.push("  </graph>");
    lines.push("</graphml>");
    return lines.join("\n");
  }

  /** XML 特殊字符转义 */
  private xmlEscape(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }
}
