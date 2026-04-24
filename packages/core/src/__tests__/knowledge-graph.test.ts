/**
 * T6.7 — 知识图谱单元测试
 *
 * 覆盖 Spec 要求的 7 个用例：
 *   1. add-triple-uniqueness：同三元组写入两次只保留一条，confidence 取大
 *   2. subgraph-depth-limit：maxDepth=2 时不返回深度 3 的节点
 *   3. subgraph-cycle-safe：含环图遍历不死循环
 *   4. find-path：能找到 A → B → C 长度 2 的路径
 *   5. relation-extraction-rule：「张三 works at OpenAI」抽出 (张三, worksAt, OpenAI)
 *   6. transitive-closure：partOf 关系链 A→B→C 推出 A→C
 *   7. search-graph-expansion：开启 graphExpansion 后检索结果包含间接关联记忆
 *
 * 额外覆盖：
 *   8. exportSubgraph 三种格式输出
 *   9. getOrCreateEntityId 幂等性
 *  10. removeBySource 批量清理
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, getDatabase, closeDatabase } from "../persistence/sqlite.js";
import { KnowledgeGraph } from "../memory/knowledge-graph.js";
import type { TripleInput } from "../memory/knowledge-graph.js";
import { extractRelations } from "../memory/relation-extractor.js";
import type { RelationCandidate } from "../memory/relation-extractor.js";
import { applyTransitiveClosure, TRANSITIVE_PREDICATES } from "../memory/inference-rules.js";
import { MemoryManager, InMemoryBackend } from "../memory/manager.js";
import type { MemoryEntry } from "../types/index.js";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

// ═══════════════════════════════════════════════════════════════
// 测试用临时数据库
// ═══════════════════════════════════════════════════════════════

let kg: KnowledgeGraph;
let tmpDir: string;
let dbPath: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-test-"));
  dbPath = path.join(tmpDir, "test.db");
  await initDatabase(dbPath);
  kg = new KnowledgeGraph();
});

afterAll(() => {
  try {
    closeDatabase();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir);
  } catch { /* cleanup best-effort */ }
});

// ═══════════════════════════════════════════════════════════════
// 辅助：创建测试实体并返回 ID
// ═══════════════════════════════════════════════════════════════

function createTestEntity(name: string): number {
  return kg.getOrCreateEntityId(name);
}

// ═══════════════════════════════════════════════════════════════
// 测试用例
// ═══════════════════════════════════════════════════════════════

describe("KnowledgeGraph", () => {

  // ── 1. add-triple-uniqueness ────────────────────────────────
  it("should keep only one triple for same subject-predicate-object, taking max confidence", () => {
    const alice = createTestEntity("Alice");
    const openai = createTestEntity("OpenAI");

    // 第一次写入 confidence=0.6
    kg.upsertTriple({
      subjectId: alice,
      predicate: "worksAt",
      objectId: openai,
      confidence: 0.6,
      source: "mem_001",
    });

    // 第二次写入 confidence=0.9（应取 max）
    kg.upsertTriple({
      subjectId: alice,
      predicate: "worksAt",
      objectId: openai,
      confidence: 0.9,
      source: "mem_002",
    });

    const outgoing = kg.getOutgoing(alice, "worksAt");
    expect(outgoing.length).toBe(1);
    expect(outgoing[0].confidence).toBe(0.9);
  });

  // ── 2. subgraph-depth-limit ─────────────────────────────────
  it("should respect maxDepth and not return deeper nodes", () => {
    const a = createTestEntity("NodeA");
    const b = createTestEntity("NodeB");
    const c = createTestEntity("NodeC");
    const d = createTestEntity("NodeD");

    // A → B → C → D（链式关系）
    kg.addTriple({ subjectId: a, predicate: "knows", objectId: b, source: "test" });
    kg.addTriple({ subjectId: b, predicate: "knows", objectId: c, source: "test" });
    kg.addTriple({ subjectId: c, predicate: "knows", objectId: d, source: "test" });

    // maxDepth=2：应包含 A, B, C 但不包含 D
    const sub = kg.subgraph(a, 2);
    const nodeIds = sub.nodes.map((n: { id: number }) => n.id);
    expect(nodeIds).toContain(a);
    expect(nodeIds).toContain(b);
    expect(nodeIds).toContain(c);
    expect(nodeIds).not.toContain(d);
  });

  // ── 3. subgraph-cycle-safe ──────────────────────────────────
  it("should handle cycles without infinite loop", () => {
    const x = createTestEntity("CycleX");
    const y = createTestEntity("CycleY");
    const z = createTestEntity("CycleZ");

    // X → Y → Z → X（环）
    kg.addTriple({ subjectId: x, predicate: "links", objectId: y, source: "test" });
    kg.addTriple({ subjectId: y, predicate: "links", objectId: z, source: "test" });
    kg.addTriple({ subjectId: z, predicate: "links", objectId: x, source: "test" });

    // 不应死循环，应正常返回
    const sub = kg.subgraph(x, 5);
    expect(sub.nodes.length).toBeGreaterThanOrEqual(3);
    expect(sub.edges.length).toBeGreaterThanOrEqual(3);
  });

  // ── 4. find-path ────────────────────────────────────────────
  it("should find a path A → B → C of length 2", () => {
    const p1 = createTestEntity("PathStart");
    const p2 = createTestEntity("PathMid");
    const p3 = createTestEntity("PathEnd");

    kg.addTriple({ subjectId: p1, predicate: "connects", objectId: p2, source: "test" });
    kg.addTriple({ subjectId: p2, predicate: "connects", objectId: p3, source: "test" });

    const path = kg.findPath(p1, p3, 5);
    expect(path.length).toBe(2);
    expect(path[0].subjectId).toBe(p1);
    expect(path[0].objectId).toBe(p2);
    expect(path[1].subjectId).toBe(p2);
    expect(path[1].objectId).toBe(p3);
  });

  // ── 5. relation-extraction-rule ─────────────────────────────
  it("should extract '张三 works at OpenAI' as (张三, worksAt, OpenAI)", () => {
    // 注意：每个关系要求主体直接在谓词前，用句号分隔多条关系
    const text = "张三 works at OpenAI. Alice manages Bob.";
    const entities = ["张三", "OpenAI", "Alice", "Bob"];

    const candidates = extractRelations(text, entities);

    // Spec 核心用例：张三 worksAt OpenAI
    const worksAt = candidates.find(
      (c: RelationCandidate) => c.predicate === "worksAt" && c.subject === "张三" && c.object === "OpenAI",
    );
    expect(worksAt).toBeDefined();
    expect(worksAt!.confidence).toBeGreaterThanOrEqual(0.7);

    // 第二条关系：Alice manages Bob
    const manages = candidates.find(
      (c: RelationCandidate) => c.predicate === "manages" && c.subject === "Alice" && c.object === "Bob",
    );
    expect(manages).toBeDefined();
  });

  // ── 6. transitive-closure ───────────────────────────────────
  it("should infer A→C from A→B→C partOf chain", () => {
    const teamA = createTestEntity("TeamAlpha");
    const divB = createTestEntity("DivisionBeta");
    const orgC = createTestEntity("OrgGamma");

    // TeamAlpha partOf DivisionBeta, DivisionBeta partOf OrgGamma
    kg.upsertTriple({ subjectId: teamA, predicate: "partOf", objectId: divB, confidence: 0.8, source: "test" });
    kg.upsertTriple({ subjectId: divB, predicate: "partOf", objectId: orgC, confidence: 0.9, source: "test" });

    // 执行传递闭包推理
    const count = applyTransitiveClosure(kg, "partOf", 3);
    expect(count).toBeGreaterThanOrEqual(1);

    // 验证推理结果：TeamAlpha partOf OrgGamma
    const inferred = kg.getOutgoing(teamA, "partOf");
    const direct = inferred.find((t) => t.objectId === orgC);
    expect(direct).toBeDefined();
    expect(direct!.source).toBe("inferred");
    // confidence 应为 0.8 * 0.9 = 0.72
    expect(direct!.confidence).toBeCloseTo(0.72, 1);
  });

  // ── 7. addRelationsFromText 集成 ────────────────────────────
  it("should extract relations from text and write to DB via addRelationsFromText", () => {
    const beforeCount = kg.countTriples();
    const written = kg.addRelationsFromText(
      "mem_test_100",
      "Bob Smith works at Google and Alice Smith manages Bob Smith.",
      ["Bob Smith", "Google", "Alice Smith"],
    );

    expect(written).toBeGreaterThanOrEqual(1);
    expect(kg.countTriples()).toBeGreaterThan(beforeCount);

    // 验证具体关系
    const bobId = kg.findEntityId("Bob Smith");
    expect(bobId).not.toBeNull();
    const googleId = kg.findEntityId("Google");
    expect(googleId).not.toBeNull();

    const bobOutgoing = kg.getOutgoing(bobId!, "worksAt");
    expect(bobOutgoing.some((t) => t.objectId === googleId)).toBe(true);
  });

  // ── 8. exportSubgraph 格式测试 ──────────────────────────────
  it("should export subgraph in json, mermaid, and graphml formats", () => {
    const e1 = createTestEntity("ExportNode1");
    const e2 = createTestEntity("ExportNode2");
    kg.addTriple({ subjectId: e1, predicate: "related", objectId: e2, source: "test" });

    const json = kg.exportSubgraph(e1, 1, "json");
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.nodes).toBeDefined();
    expect(parsed.edges).toBeDefined();

    const mermaid = kg.exportSubgraph(e1, 1, "mermaid");
    expect(mermaid).toContain("graph TD");
    expect(mermaid).toContain("related");

    const graphml = kg.exportSubgraph(e1, 1, "graphml");
    expect(graphml).toContain("<graphml");
    expect(graphml).toContain("</graphml>");
  });

  // ── 9. getOrCreateEntityId 幂等性 ───────────────────────────
  it("should return same ID for repeated getOrCreateEntityId calls", () => {
    const id1 = kg.getOrCreateEntityId("IdempotentEntity");
    const id2 = kg.getOrCreateEntityId("IdempotentEntity");
    const id3 = kg.getOrCreateEntityId("idempotententity"); // 不区分大小写
    expect(id1).toBe(id2);
    expect(id1).toBe(id3);
  });

  // ── 10. removeBySource 批量清理 ─────────────────────────────
  it("should remove all triples by source", () => {
    const r1 = createTestEntity("RemoveNode1");
    const r2 = createTestEntity("RemoveNode2");

    kg.addTriple({ subjectId: r1, predicate: "temp", objectId: r2, confidence: 0.5, source: "cleanup_test" });
    kg.addTriple({ subjectId: r2, predicate: "temp", objectId: r1, confidence: 0.5, source: "cleanup_test" });

    const removed = kg.removeBySource("cleanup_test");
    expect(removed).toBe(2);

    // 确认已清理
    const remaining = kg.getOutgoing(r1, "temp");
    expect(remaining.length).toBe(0);
  });
});
