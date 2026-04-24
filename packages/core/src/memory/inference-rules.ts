/**
 * T6.5 — 关系传播规则（传递闭包推理）
 *
 * 对知识图谱中的传递性谓词（partOf / locatedIn / subClassOf）做简单推理：
 *   若 A partOf B 且 B partOf C，则推出 A partOf C。
 *   推理结果写回 relations 表，source = 'inferred'，便于回溯和清理。
 *
 * 设计原则：
 *   - confidence 取乘积（链越长置信度越低，自然衰减）
 *   - maxDepth 限制推理链长度（默认 3，防爆炸）
 *   - 幂等：已存在的推理结果通过 upsert 取 MAX(confidence) 更新
 */

import pino from "pino";
import { KnowledgeGraph } from "./knowledge-graph.js";
import { getDatabase } from "../persistence/sqlite.js";

const logger = pino({ name: "inference-rules" });

// ═══════════════════════════════════════════════════════════════
// 传递性谓词集合
// ═══════════════════════════════════════════════════════════════

/** 支持传递闭包推理的谓词列表 */
export const TRANSITIVE_PREDICATES = new Set(["partOf", "locatedIn", "subClassOf"]);

// ═══════════════════════════════════════════════════════════════
// 传递闭包推理
// ═══════════════════════════════════════════════════════════════

/**
 * 对指定谓词执行传递闭包推理。
 *
 * 策略：
 *   1. 查出所有现有的 (A→B, predicate) 关系
 *   2. 对每条边，沿 B 的出边继续延伸（BFS），最多 maxDepth 跳
 *   3. 发现的间接关系通过 upsert 写入，source = 'inferred'
 *   4. confidence = 路径上各边 confidence 的乘积
 *
 * @param kg - 知识图谱实例
 * @param predicate - 要推理的谓词（必须在 TRANSITIVE_PREDICATES 中）
 * @param maxDepth - 最大推理链长度（默认 3）
 * @returns 新增/更新的推理三元组数量
 */
export function applyTransitiveClosure(
  kg: KnowledgeGraph,
  predicate: string,
  maxDepth = 3,
): number {
  if (!TRANSITIVE_PREDICATES.has(predicate)) {
    logger.warn({ predicate }, "predicate not in TRANSITIVE_PREDICATES, skipping");
    return 0;
  }

  // 收集所有该谓词的直接关系作为种子
  const allTriples = getAllTriplesForPredicate(kg, predicate);
  if (allTriples.length === 0) return 0;

  // 构建邻接表：subjectId → [{objectId, confidence}]
  const adjacency = new Map<number, Array<{ objectId: number; confidence: number }>>();
  for (const t of allTriples) {
    if (!adjacency.has(t.subjectId)) adjacency.set(t.subjectId, []);
    adjacency.get(t.subjectId)!.push({ objectId: t.objectId, confidence: t.confidence });
  }

  let count = 0;

  // 对每个起点节点做 BFS
  for (const startId of adjacency.keys()) {
    // BFS 队列：{nodeId, depth, cumulativeConfidence}
    const queue: Array<{ nodeId: number; depth: number; conf: number }> = [];
    const visited = new Set<number>();
    visited.add(startId);

    // 初始化：起点的直接邻居
    const directNeighbors = adjacency.get(startId) ?? [];
    for (const n of directNeighbors) {
      visited.add(n.objectId);
      if (adjacency.has(n.objectId)) {
        queue.push({ nodeId: n.objectId, depth: 1, conf: n.confidence });
      }
    }

    // BFS 扩展
    while (queue.length > 0) {
      const { nodeId, depth, conf } = queue.shift()!;
      if (depth >= maxDepth) continue;

      const neighbors = adjacency.get(nodeId) ?? [];
      for (const n of neighbors) {
        if (visited.has(n.objectId)) continue; // 避免环
        visited.add(n.objectId);

        // 推出 startId → n.objectId 的间接关系
        const inferredConf = conf * n.confidence;
        try {
          kg.upsertTriple({
            subjectId: startId,
            predicate,
            objectId: n.objectId,
            confidence: inferredConf,
            source: "inferred",
            metadata: { inferredDepth: depth + 1 },
          });
          count++;
        } catch (err) {
          logger.warn({ startId, objectId: n.objectId, err }, "failed to upsert inferred triple");
        }

        // 继续扩展
        if (adjacency.has(n.objectId)) {
          queue.push({ nodeId: n.objectId, depth: depth + 1, conf: inferredConf });
        }
      }
    }
  }

  logger.info({ predicate, maxDepth, inferredCount: count }, "transitive closure applied");
  return count;
}

/**
 * 对所有传递性谓词批量执行推理。
 * @returns 各谓词的推理结果数量总和
 */
export function applyAllTransitiveClosures(kg: KnowledgeGraph, maxDepth = 3): number {
  let total = 0;
  for (const predicate of TRANSITIVE_PREDICATES) {
    total += applyTransitiveClosure(kg, predicate, maxDepth);
  }
  return total;
}

// ═══════════════════════════════════════════════════════════════
// 辅助：获取指定谓词的全部三元组
// ═══════════════════════════════════════════════════════════════

interface TripleLite {
  subjectId: number;
  objectId: number;
  confidence: number;
}

/**
 * 查询指定谓词的全部非推理三元组（排除 source='inferred' 避免推理结果再推理）。
 * 直接操作 KnowledgeGraph 的内部 DB，保持低耦合。
 */
function getAllTriplesForPredicate(_kg: KnowledgeGraph, predicate: string): TripleLite[] {
  try {
    const db = getDatabase();
    const results = db.exec(
      "SELECT subjectId, objectId, confidence FROM relations WHERE predicate = ? AND source != 'inferred'",
      [predicate],
    );
    if (!results.length || !results[0].values.length) return [];
    return results[0].values.map((row: unknown[]) => ({
      subjectId: row[0] as number,
      objectId: row[1] as number,
      confidence: row[2] as number,
    }));
  } catch {
    return [];
  }
}
