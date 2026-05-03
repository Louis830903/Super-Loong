/**
 * T5 知识库混合检索单测（Spec §5.5）。
 *
 * 覆盖点：
 *   A. reranker 纯函数：
 *      1. minMaxNormalize 常规 / 空 / 全同值
 *      2. mergeByWeight 两路并集 / 仅向量 / 仅 BM25 / 权重影响
 *      3. applyMinScore / truncateByTokens 边界
 *   B. tokenizeQuery：ASCII 切分 + 中文 2-gram + 混合
 *   C. searchByVector：命中 / docIds 过滤 / agent 隔离 / user 隔离
 *   D. searchByBM25（LIKE 降级）：关键词命中 / 不相关不命中 / docIds 过滤
 *   E. searchHybrid：两路并集合并 / minScore 过滤 / maxTokens 截断 / topK
 *   F. 关键词命中率 > 80%（Spec §T5 验收）
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

import { initDatabase, closeDatabase } from "../persistence/sqlite.js";
import {
  // T5
  searchByVector,
  searchByBM25,
  searchHybrid,
  tokenizeQuery,
  minMaxNormalize,
  mergeByWeight,
  applyMinScore,
  truncateByTokens,
  // 仓储（测试直接构造数据）
  insertDocument,
  insertChunks,
  listDocuments,
  deleteDocument,
  // 类型
  type KBEmbedder,
  type KBChunk,
  type KBDocument,
  type RetrievedChunk,
} from "../knowledgebase/index.js";

// ─── 测试环境 ─────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-kb-retrieval-"));
  await initDatabase(path.join(tmpDir, "test.db"));
});

afterAll(async () => {
  await closeDatabase();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

beforeEach(() => {
  // 清空每个用例
  const docs = listDocuments({}, { limit: 10_000 });
  for (const d of docs) deleteDocument(d.id);
});

// ─── 测试工具：关键词驱动的 Embedder（精确可验证） ─────

/**
 * 关键词驱动 Embedder：
 *   - 每个关键词占用一个维度
 *   - embed(text)：若 text 包含 kw，则该维度置 1，否则 0
 *   - 查询向量与 chunk 向量的余弦 = 共同命中关键词数 / sqrt(q命中 * c命中)
 */
class KeywordEmbedder implements KBEmbedder {
  readonly embeddingType = "simple" as const;
  private readonly kwDim: Record<string, number> = {};

  constructor(keywords: string[]) {
    keywords.forEach((kw, i) => (this.kwDim[kw] = i));
  }

  async embed(text: string): Promise<number[]> {
    const dim = Object.keys(this.kwDim).length;
    const vec = new Array<number>(dim).fill(0);
    for (const kw of Object.keys(this.kwDim)) {
      if (text.includes(kw)) vec[this.kwDim[kw]] = 1;
    }
    return vec;
  }
}

// ─── 测试工具：直接构造 indexed 文档 + chunks ─────────

interface DocFixture {
  docId: string;
  agentId: string | null;
  userId: string | null;
  filename: string;
  chunks: Array<{ content: string }>;
}

async function seedDoc(
  fixture: DocFixture,
  embedder: KBEmbedder,
): Promise<{ doc: KBDocument; chunks: KBChunk[] }> {
  const now = Date.now();
  const doc: KBDocument = {
    id: fixture.docId,
    agentId: fixture.agentId,
    userId: fixture.userId,
    filename: fixture.filename,
    mime: "text/markdown",
    size: fixture.chunks.reduce((n, c) => n + c.content.length, 0),
    contentHash: randomUUID(), // 避免触发去重
    sourcePath: null,
    status: "indexed",
    error: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
  insertDocument(doc);

  const chunks: KBChunk[] = [];
  for (let i = 0; i < fixture.chunks.length; i++) {
    const content = fixture.chunks[i].content;
    const embedding = await embedder.embed(content);
    chunks.push({
      id: `${fixture.docId}-chunk-${i}`,
      docId: fixture.docId,
      chunkIndex: i,
      content,
      embedding,
      embeddingType: embedder.embeddingType,
      tokenCount: Math.ceil(content.length / 3),
      metadata: {},
      createdAt: now,
    });
  }
  insertChunks(chunks);
  return { doc, chunks };
}

// ─── A. reranker 纯函数 ───────────────────────────

describe("reranker.minMaxNormalize", () => {
  it("空数组返回空", () => {
    expect(minMaxNormalize([])).toEqual([]);
  });

  it("常规线性映射到 [0, 1]", () => {
    const out = minMaxNormalize([0, 5, 10]);
    expect(out).toEqual([0, 0.5, 1]);
  });

  it("全同值返回全 1（避免 0 消灭权重）", () => {
    const out = minMaxNormalize([3, 3, 3]);
    expect(out).toEqual([1, 1, 1]);
  });
});

describe("reranker.mergeByWeight", () => {
  /** 构造一个 RetrievedChunk 用于纯函数测试 */
  function mkHit(id: string, score: number): RetrievedChunk {
    return {
      chunk: {
        id,
        docId: "d1",
        chunkIndex: 0,
        content: `content-${id}`,
        embeddingType: "simple",
        tokenCount: 10,
        metadata: {},
        createdAt: 0,
      },
      score,
      document: { id: "d1", filename: "f", agentId: null, userId: null },
    };
  }

  it("两路并集按权重合并：共同命中得满分", () => {
    const vec = [mkHit("c1", 0.9), mkHit("c2", 0.5)];
    const bm = [mkHit("c1", 10), mkHit("c3", 4)];
    const merged = mergeByWeight(vec, bm, 0.6, 0.4);
    // c1 同时命中：归一化后 vec=1, bm=1 → 0.6*1 + 0.4*1 = 1.0
    const c1 = merged.find((h) => h.chunk.id === "c1")!;
    expect(c1.score).toBeCloseTo(1.0, 5);
    expect(c1.vectorScore).toBeCloseTo(1.0, 5);
    expect(c1.bm25Score).toBeCloseTo(1.0, 5);
  });

  it("仅向量命中：vectorScore 有值，bm25Score=0", () => {
    const vec = [mkHit("c1", 0.9), mkHit("c2", 0.5)];
    const bm: RetrievedChunk[] = [];
    const merged = mergeByWeight(vec, bm, 0.6, 0.4);
    const c1 = merged.find((h) => h.chunk.id === "c1")!;
    // 归一化后 c1=1, c2=0；仅 vector：score = 0.6*1 = 0.6
    expect(c1.score).toBeCloseTo(0.6, 5);
    expect(c1.bm25Score).toBe(0);
  });

  it("仅 BM25 命中：bm25Score 有值，vectorScore=0", () => {
    const vec: RetrievedChunk[] = [];
    const bm = [mkHit("c3", 5)];
    const merged = mergeByWeight(vec, bm, 0.6, 0.4);
    expect(merged[0].vectorScore).toBe(0);
    expect(merged[0].bm25Score).toBeCloseTo(1.0, 5);
    // 1-value 归一化 → 1；score = 0.4
    expect(merged[0].score).toBeCloseTo(0.4, 5);
  });

  it("权重影响最终排序", () => {
    // c1 向量优 / c2 BM25 优
    const vec = [mkHit("c1", 0.9), mkHit("c2", 0.3)];
    const bm = [mkHit("c2", 10), mkHit("c1", 2)];
    // 向量主导
    const vecMerged = mergeByWeight(vec, bm, 0.9, 0.1);
    expect(vecMerged[0].chunk.id).toBe("c1");
    // BM25 主导
    const bmMerged = mergeByWeight(vec, bm, 0.1, 0.9);
    expect(bmMerged[0].chunk.id).toBe("c2");
  });
});

describe("reranker.applyMinScore / truncateByTokens", () => {
  function mkHit(id: string, score: number, tokens = 100): RetrievedChunk {
    return {
      chunk: {
        id,
        docId: "d1",
        chunkIndex: 0,
        content: id,
        embeddingType: "simple",
        tokenCount: tokens,
        metadata: {},
        createdAt: 0,
      },
      score,
      document: { id: "d1", filename: "f", agentId: null, userId: null },
    };
  }

  it("minScore 过滤低分", () => {
    const hits = [mkHit("a", 0.9), mkHit("b", 0.5), mkHit("c", 0.2)];
    expect(applyMinScore(hits, 0.4)).toHaveLength(2);
    expect(applyMinScore(hits, undefined)).toHaveLength(3);
  });

  it("truncateByTokens 按累加截断，至少保留 1 条", () => {
    const hits = [mkHit("a", 0.9, 500), mkHit("b", 0.8, 500), mkHit("c", 0.7, 500)];
    // 1200 预算 → 能装 2 条（500+500=1000 < 1200，第 3 条 1500 > 1200 → 停）
    const out = truncateByTokens(hits, 1200);
    expect(out).toHaveLength(2);
    // 首条就超限 → 至少保 1
    const out2 = truncateByTokens(hits, 100);
    expect(out2).toHaveLength(1);
    // maxTokens 未给 → 不截断
    expect(truncateByTokens(hits, undefined)).toHaveLength(3);
  });
});

// ─── B. tokenizeQuery ────────────────────────────

describe("tokenizeQuery", () => {
  it("ASCII 词按空格切分 + 小写", () => {
    expect(tokenizeQuery("Hello WORLD foo-bar")).toEqual([
      "hello",
      "world",
      "foo",
      "bar",
    ]);
  });

  it("中文 2-gram 切分", () => {
    // "机器学习" → 机器/器学/学习
    const out = tokenizeQuery("机器学习");
    expect(out).toContain("机器");
    expect(out).toContain("器学");
    expect(out).toContain("学习");
  });

  it("中英混合 + 标点", () => {
    const out = tokenizeQuery("深度学习 (Deep Learning), 神经网络。");
    expect(out).toContain("深度");
    expect(out).toContain("度学");
    expect(out).toContain("deep");
    expect(out).toContain("learning");
    expect(out).toContain("神经");
  });

  it("空字符串返回空", () => {
    expect(tokenizeQuery("")).toEqual([]);
    expect(tokenizeQuery("   ")).toEqual([]);
  });
});

// ─── C. searchByVector ───────────────────────────

describe("searchByVector", () => {
  const keywords = ["机器学习", "数据库", "前端开发"];

  it("精确命中：查询向量 ↔ chunk 向量余弦 = 1.0", async () => {
    const embedder = new KeywordEmbedder(keywords);
    await seedDoc(
      {
        docId: "doc-ml",
        agentId: null,
        userId: "u1",
        filename: "ml.md",
        chunks: [
          { content: "机器学习是人工智能的分支。" },
          { content: "监督学习需要标注数据。" }, // 不含关键词 → 向量全 0 → cos=0 → 不命中
        ],
      },
      embedder,
    );

    const hits = await searchByVector({
      query: "机器学习",
      embedder,
      userId: "u1",
      topK: 10,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeCloseTo(1.0, 5);
    expect(hits[0].chunk.content).toContain("机器学习");
  });

  it("docIds 过滤：仅返回指定文档的分块", async () => {
    const embedder = new KeywordEmbedder(keywords);
    await seedDoc(
      {
        docId: "doc-a",
        agentId: null,
        userId: "u1",
        filename: "a.md",
        chunks: [{ content: "机器学习算法" }],
      },
      embedder,
    );
    await seedDoc(
      {
        docId: "doc-b",
        agentId: null,
        userId: "u1",
        filename: "b.md",
        chunks: [{ content: "机器学习框架" }],
      },
      embedder,
    );

    const hits = await searchByVector({
      query: "机器学习",
      embedder,
      userId: "u1",
      docIds: ["doc-a"],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].chunk.docId).toBe("doc-a");
  });

  it("agent 两级隔离：agentId=A 查不到 agentId=B 的数据", async () => {
    const embedder = new KeywordEmbedder(keywords);
    await seedDoc(
      {
        docId: "doc-a",
        agentId: "agent-A",
        userId: "u1",
        filename: "a.md",
        chunks: [{ content: "机器学习 A" }],
      },
      embedder,
    );
    await seedDoc(
      {
        docId: "doc-b",
        agentId: "agent-B",
        userId: "u1",
        filename: "b.md",
        chunks: [{ content: "机器学习 B" }],
      },
      embedder,
    );

    const hitsA = await searchByVector({
      query: "机器学习",
      embedder,
      agentId: "agent-A",
      userId: "u1",
    });
    expect(hitsA).toHaveLength(1);
    expect(hitsA[0].chunk.docId).toBe("doc-a");
  });

  it("空查询返回空", async () => {
    const embedder = new KeywordEmbedder(keywords);
    const hits = await searchByVector({ query: "", embedder });
    expect(hits).toEqual([]);
  });
});

// ─── D. searchByBM25（当前 sql.js → LIKE 降级） ──

describe("searchByBM25 (LIKE 降级路径)", () => {
  const keywords = ["机器学习", "数据库"];

  it("关键词命中：LIKE 分词后匹配 content", async () => {
    const embedder = new KeywordEmbedder(keywords);
    await seedDoc(
      {
        docId: "doc-ml",
        agentId: null,
        userId: "u1",
        filename: "ml.md",
        chunks: [
          { content: "机器学习是人工智能的分支" },
          { content: "数据库技术广泛应用" },
        ],
      },
      embedder,
    );

    const hits = searchByBM25({ query: "机器学习", userId: "u1" });
    // "机器学习" 2-gram 命中 "机器学习" 所在的 chunk
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.content).toContain("机器学习");
    expect(hits[0].bm25Score).toBeGreaterThan(0);
  });

  it("不相关查询不命中", async () => {
    const embedder = new KeywordEmbedder(keywords);
    await seedDoc(
      {
        docId: "doc-ml",
        agentId: null,
        userId: "u1",
        filename: "ml.md",
        chunks: [{ content: "机器学习是人工智能的分支" }],
      },
      embedder,
    );

    const hits = searchByBM25({ query: "量子物理", userId: "u1" });
    expect(hits).toHaveLength(0);
  });

  it("ASCII 英文词命中", async () => {
    const embedder = new KeywordEmbedder([]);
    await seedDoc(
      {
        docId: "doc-en",
        agentId: null,
        userId: "u1",
        filename: "en.md",
        chunks: [{ content: "Machine learning is a subfield of AI." }],
      },
      embedder,
    );

    const hits = searchByBM25({ query: "Machine", userId: "u1" });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("docIds 过滤生效", async () => {
    const embedder = new KeywordEmbedder(keywords);
    await seedDoc(
      {
        docId: "doc-a",
        agentId: null,
        userId: "u1",
        filename: "a.md",
        chunks: [{ content: "机器学习算法 A" }],
      },
      embedder,
    );
    await seedDoc(
      {
        docId: "doc-b",
        agentId: null,
        userId: "u1",
        filename: "b.md",
        chunks: [{ content: "机器学习框架 B" }],
      },
      embedder,
    );
    const hits = searchByBM25({
      query: "机器学习",
      userId: "u1",
      docIds: ["doc-b"],
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.chunk.docId).toBe("doc-b");
  });
});

// ─── E. searchHybrid ────────────────────────────

describe("searchHybrid", () => {
  const keywords = ["机器学习", "数据库", "前端开发"];

  it("两路并集合并：向量 + BM25 同时命中得最高分", async () => {
    const embedder = new KeywordEmbedder(keywords);
    await seedDoc(
      {
        docId: "doc-ml",
        agentId: null,
        userId: "u1",
        filename: "ml.md",
        chunks: [
          { content: "机器学习是人工智能的分支，包含监督学习与无监督学习。" },
        ],
      },
      embedder,
    );
    await seedDoc(
      {
        docId: "doc-db",
        agentId: null,
        userId: "u1",
        filename: "db.md",
        chunks: [{ content: "数据库技术广泛应用于企业系统。" }],
      },
      embedder,
    );

    const hits = await searchHybrid({
      query: "机器学习",
      embedder,
      userId: "u1",
      topK: 5,
    });

    expect(hits.length).toBeGreaterThan(0);
    // 两路都命中的 chunk 在最前
    expect(hits[0].chunk.content).toContain("机器学习");
    expect(hits[0].vectorScore).toBeGreaterThan(0);
    expect(hits[0].bm25Score).toBeGreaterThan(0);
  });

  it("minScore 过滤低分项", async () => {
    const embedder = new KeywordEmbedder(keywords);
    await seedDoc(
      {
        docId: "doc-x",
        agentId: null,
        userId: "u1",
        filename: "x.md",
        chunks: [
          { content: "机器学习领域覆盖广。" },
          { content: "数据库与机器学习有时结合。" },
        ],
      },
      embedder,
    );
    // 全部要求 score >= 0.99：基本不会被过滤掉的必须是最匹配项
    const hits = await searchHybrid({
      query: "机器学习",
      embedder,
      userId: "u1",
      minScore: 0.99,
      topK: 10,
    });
    // minScore 0.99 → 过滤掉非最匹配项（两个 chunk 都含关键词但归一化后只有最高分=1.0）
    for (const h of hits) expect(h.score).toBeGreaterThanOrEqual(0.99);
  });

  it("maxTokens 累加截断", async () => {
    const embedder = new KeywordEmbedder(keywords);
    // 构造 3 个大 chunk，每个 tokenCount ~= 500
    const bigContent = "机器学习 ".repeat(300); // 长文本
    await seedDoc(
      {
        docId: "doc-big",
        agentId: null,
        userId: "u1",
        filename: "big.md",
        chunks: [
          { content: bigContent },
          { content: bigContent },
          { content: bigContent },
        ],
      },
      embedder,
    );
    const hits = await searchHybrid({
      query: "机器学习",
      embedder,
      userId: "u1",
      topK: 10,
      maxTokens: 600, // 只够装 1 条（每条 ~500 tokens）
    });
    expect(hits).toHaveLength(1);
  });

  it("topK 限制返回条数", async () => {
    const embedder = new KeywordEmbedder(keywords);
    const chunks = Array.from({ length: 10 }, (_, i) => ({
      content: `机器学习主题 ${i}`,
    }));
    await seedDoc(
      {
        docId: "doc-many",
        agentId: null,
        userId: "u1",
        filename: "many.md",
        chunks,
      },
      embedder,
    );
    const hits = await searchHybrid({
      query: "机器学习",
      embedder,
      userId: "u1",
      topK: 3,
    });
    expect(hits).toHaveLength(3);
  });
});

// ─── F. 关键词命中率 > 80%（Spec §T5 验收） ──────

describe("T5 验收：关键词命中率 > 80%", () => {
  it("10 个主题查询中至少 8 个能在 topK=3 里命中目标文档", async () => {
    const topics = [
      { kw: "机器学习", doc: "ml" },
      { kw: "数据库", doc: "db" },
      { kw: "前端开发", doc: "fe" },
      { kw: "网络安全", doc: "sec" },
      { kw: "操作系统", doc: "os" },
      { kw: "分布式系统", doc: "dist" },
      { kw: "人工智能", doc: "ai" },
      { kw: "数据结构", doc: "ds" },
      { kw: "云计算", doc: "cloud" },
      { kw: "编译原理", doc: "compiler" },
    ];
    const embedder = new KeywordEmbedder(topics.map((t) => t.kw));

    for (const t of topics) {
      await seedDoc(
        {
          docId: `doc-${t.doc}`,
          agentId: null,
          userId: "u1",
          filename: `${t.doc}.md`,
          chunks: [
            // 目标文档必然包含目标关键词
            { content: `${t.kw}的基础概念与应用场景。` },
            { content: `${t.kw}相关的进阶内容。` },
          ],
        },
        embedder,
      );
    }

    let hitCount = 0;
    for (const t of topics) {
      const hits = await searchHybrid({
        query: t.kw,
        embedder,
        userId: "u1",
        topK: 3,
      });
      if (hits.some((h) => h.chunk.docId === `doc-${t.doc}`)) {
        hitCount++;
      }
    }
    const rate = hitCount / topics.length;
    expect(rate).toBeGreaterThanOrEqual(0.8);
  });
});
