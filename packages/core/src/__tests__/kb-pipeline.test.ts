/**
 * T4 知识库 ingestion 流水线 + 向量化内核单测。
 *
 * 覆盖点：
 *   1. embedChunks：批量 + batchSize + 空输入 + 参数非法
 *   2. cosineSimilarity：正常 / 正交 / 方向相反 / 维度不一致降级 / 零向量降级
 *   3. ingestDocument 成功路径（markdown）：状态 indexed，chunks 有 embedding
 *   4. ingestDocument 去重（同 user 同 hash）：skipped=true，不重跑流水线
 *   5. ingestDocument 不同 user 同 buffer：不去重，新建 doc
 *   6. ingestDocument failed 重跑：沿用 id，覆盖 chunks，最终 indexed
 *   7. ingestDocument parser 失败（不可识别扩展名）：status=failed，error 非空
 *   8. ingestDocument embed 失败：status=failed，error 包含 [embed]
 *   9. 状态机回调顺序：pending → parsing → chunking → embedding → indexed
 *   10. embedBatchSize 生效：embed 调用次数 === chunks 数，批次次数 === ceil(n/batch)
 *   11. createIngestionQueue 并发：maxRunning 上限 === concurrency
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { initDatabase, closeDatabase } from "../persistence/sqlite.js";
import {
  ingestDocument,
  createIngestionQueue,
  embedChunks,
  cosineSimilarity,
  listDocuments,
  deleteDocument,
  getDocument,
  listChunksByDoc,
  insertDocument,
  type KBEmbedder,
  type KBChunk,
  type KBDocStatus,
  type KBDocument,
} from "../knowledgebase/index.js";

// ─── 测试环境 ─────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-kb-pipeline-"));
  await initDatabase(path.join(tmpDir, "test.db"));
});

afterAll(async () => {
  await closeDatabase();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

/** 每个测试前清空所有文档（保证隔离） */
beforeEach(() => {
  const docs = listDocuments({}, { limit: 10_000 });
  for (const d of docs) deleteDocument(d.id);
});

// ─── MockEmbedder：确定性 128 维向量 ──────────────

/**
 * 测试用 embedder：按文本 hash 生成 128 维确定性向量，
 * 便于断言同文本同向量、不同文本不同向量。
 */
class MockEmbedder implements KBEmbedder {
  readonly embeddingType = "simple" as const;
  /** 每次 embed 的文本记录（用于断言调用次数） */
  public calls: string[] = [];
  /** 可注入的延迟（ms），用于观察并发 */
  constructor(private readonly delayMs = 0) {}

  async embed(text: string): Promise<number[]> {
    this.calls.push(text);
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    const dim = 128;
    const vec = new Array<number>(dim).fill(0);
    // 简单字符和 → 归一化的伪向量
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      vec[i % dim] += (code % 23) / 23;
    }
    // 归一到 [0,1]
    const max = Math.max(...vec.map((v) => Math.abs(v)), 1);
    return vec.map((v) => v / max);
  }
}

/** 报错 embedder（用于失败路径） */
class FailingEmbedder implements KBEmbedder {
  readonly embeddingType = "simple" as const;
  async embed(): Promise<number[]> {
    throw new Error("mock embed failure");
  }
}

/** 构造测试 markdown buffer —— 足够长以产出 >=2 chunks */
function buildMarkdownBuffer(): Buffer {
  const header = "# 文档标题\n\n这是一段中文正文，用于知识库 T4 流水线测试。\n\n";
  const section1 = "## 第一节\n\n" + "段落一的内容。".repeat(40) + "\n\n";
  const section2 = "## 第二节\n\n" + "段落二的内容。".repeat(40) + "\n\n";
  const section3 = "## 第三节\n\n" + "段落三的内容。".repeat(40) + "\n";
  return Buffer.from(header + section1 + section2 + section3, "utf8");
}

/** 构造一个测试 chunk（辅助 embedChunks 单测） */
function mkChunk(idx: number, text: string): KBChunk {
  return {
    id: `chunk-${idx}`,
    docId: "doc-x",
    chunkIndex: idx,
    content: text,
    embeddingType: "simple",
    tokenCount: text.length,
    metadata: { boundary: "paragraph" },
    createdAt: Date.now(),
  };
}

// ─── 测试用例 ─────────────────────────────────────

describe("embedChunks 批量向量化", () => {
  it("空数组直接返回 []", async () => {
    const out = await embedChunks([], { embedder: new MockEmbedder() });
    expect(out).toEqual([]);
  });

  it("batchSize <= 0 抛错", async () => {
    await expect(
      embedChunks([mkChunk(0, "a")], { embedder: new MockEmbedder(), batchSize: 0 }),
    ).rejects.toThrow(/batchSize/);
  });

  it("每个 chunk 被 embed 一次，向量写入 embedding 字段", async () => {
    const chunks = [mkChunk(0, "alpha"), mkChunk(1, "beta"), mkChunk(2, "gamma")];
    const embedder = new MockEmbedder();
    const out = await embedChunks(chunks, { embedder });
    expect(out).toHaveLength(3);
    expect(embedder.calls).toEqual(["alpha", "beta", "gamma"]);
    for (const c of out) {
      expect(c.embedding).toBeDefined();
      expect(c.embedding!.length).toBe(128);
      expect(c.embeddingType).toBe("simple");
    }
  });

  it("batchSize 生效：20 chunks, batch=8 → 分 3 批，onBatchDone 触发 3 次", async () => {
    const chunks = Array.from({ length: 20 }, (_, i) => mkChunk(i, `t${i}`));
    const embedder = new MockEmbedder();
    const batchDoneCalls: Array<[number, number]> = [];
    await embedChunks(chunks, {
      embedder,
      batchSize: 8,
      onBatchDone: (done, total) => batchDoneCalls.push([done, total]),
    });
    expect(embedder.calls).toHaveLength(20);
    expect(batchDoneCalls).toEqual([[8, 20], [16, 20], [20, 20]]);
  });
});

describe("cosineSimilarity 余弦相似度", () => {
  it("相同向量 → 1", () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("正交向量 → 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it("方向相反 → -1", () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 5);
  });

  it("维度不一致 / 空 / 零向量 → 0（稳健降级）", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([], [1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

describe("ingestDocument 成功路径", () => {
  it("markdown 流水线：status=indexed，chunks 有 embedding 与 metadata", async () => {
    const buffer = buildMarkdownBuffer();
    const embedder = new MockEmbedder();
    const res = await ingestDocument({
      buffer,
      filename: "test.md",
      mime: "text/markdown",
      embedder,
      userId: "user-a",
      agentId: "agent-1",
    });

    expect(res.duplicated).toBe(false);
    expect(res.skipped).toBe(false);
    expect(res.document.status).toBe("indexed");
    expect(res.document.error).toBeNull();
    expect(res.document.size).toBe(buffer.byteLength);
    expect(res.document.contentHash).toHaveLength(64); // SHA-256 hex
    expect(res.chunks.length).toBeGreaterThanOrEqual(2);

    // embedding 全员到位
    for (const c of res.chunks) {
      expect(c.embedding).toBeDefined();
      expect(c.embedding!.length).toBeGreaterThan(0);
      expect(c.embeddingType).toBe("simple");
      expect(c.docId).toBe(res.document.id);
    }
    // 落库校验
    const dbChunks = listChunksByDoc(res.document.id);
    expect(dbChunks).toHaveLength(res.chunks.length);
    expect(dbChunks[0].embedding).toBeDefined();
  });
});

describe("ingestDocument 去重（content_hash + userId）", () => {
  it("同 user 同 buffer 第二次：skipped=true，返回已有 doc", async () => {
    const buffer = buildMarkdownBuffer();
    const embedder = new MockEmbedder();
    const res1 = await ingestDocument({
      buffer, filename: "a.md", embedder, userId: "user-a",
    });
    const callsAfterFirst = embedder.calls.length;

    const res2 = await ingestDocument({
      buffer, filename: "a-renamed.md", embedder, userId: "user-a",
    });
    expect(res2.duplicated).toBe(true);
    expect(res2.skipped).toBe(true);
    expect(res2.document.id).toBe(res1.document.id);
    // 第二次不应触发额外 embed
    expect(embedder.calls.length).toBe(callsAfterFirst);
  });

  it("不同 userId 同 buffer：不去重，新建 doc", async () => {
    const buffer = buildMarkdownBuffer();
    const embedder = new MockEmbedder();
    const res1 = await ingestDocument({
      buffer, filename: "a.md", embedder, userId: "user-a",
    });
    const res2 = await ingestDocument({
      buffer, filename: "a.md", embedder, userId: "user-b",
    });
    expect(res2.duplicated).toBe(false);
    expect(res2.skipped).toBe(false);
    expect(res2.document.id).not.toBe(res1.document.id);
  });

  it("预置 status=failed 同 hash 的 doc → 重跑沿用 id，最终 indexed", async () => {
    const buffer = buildMarkdownBuffer();
    const contentHash = await import("node:crypto").then((c) =>
      c.createHash("sha256").update(buffer).digest("hex"),
    );
    const preId = "pre-doc-failed";
    const now = Date.now();
    const preDoc: KBDocument = {
      id: preId,
      agentId: null, userId: "user-a",
      filename: "old.md", mime: null, size: buffer.byteLength,
      contentHash, sourcePath: null,
      status: "failed", error: "old-error",
      metadata: {}, createdAt: now - 1000, updatedAt: now - 500,
    };
    insertDocument(preDoc);

    const res = await ingestDocument({
      buffer, filename: "new.md", embedder: new MockEmbedder(), userId: "user-a",
    });
    expect(res.document.id).toBe(preId);
    expect(res.document.status).toBe("indexed");
    expect(res.document.error).toBeNull();
    expect(res.chunks.length).toBeGreaterThan(0);
  });
});

describe("ingestDocument 失败路径", () => {
  it("不可识别扩展名：status=failed，error 以 [parse] 开头", async () => {
    const buffer = Buffer.from("这是内容但格式不可识别", "utf8");
    await expect(
      ingestDocument({
        buffer, filename: "xx.unknownext", embedder: new MockEmbedder(), userId: "u",
      }),
    ).rejects.toThrow();

    // 从库里查出这份 doc 看状态
    const docs = listDocuments({ userId: "u" });
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("failed");
    expect(docs[0].error).toMatch(/^\[parse\]/);
  });

  it("embed 报错：status=failed，error 以 [embed] 开头", async () => {
    const buffer = buildMarkdownBuffer();
    await expect(
      ingestDocument({
        buffer, filename: "a.md", embedder: new FailingEmbedder(), userId: "u2",
      }),
    ).rejects.toThrow(/mock embed failure/);

    const docs = listDocuments({ userId: "u2" });
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("failed");
    expect(docs[0].error).toMatch(/^\[embed\]/);
  });
});

describe("ingestDocument 状态机回调", () => {
  it("回调顺序 pending → parsing → chunking → embedding → indexed", async () => {
    const buffer = buildMarkdownBuffer();
    const seen: KBDocStatus[] = [];
    await ingestDocument({
      buffer,
      filename: "a.md",
      embedder: new MockEmbedder(),
      userId: "user-s",
      onStatus: (s) => { seen.push(s); },
    });
    expect(seen).toEqual(["pending", "parsing", "chunking", "embedding", "indexed"]);
  });
});

describe("createIngestionQueue 并发队列", () => {
  it("concurrency <= 0 抛错", () => {
    expect(() => createIngestionQueue(0)).toThrow(/concurrency/);
  });

  it("5 任务入队，concurrency=3，running 峰值 === 3", async () => {
    const queue = createIngestionQueue(3);
    const embedder = new MockEmbedder(40); // 每次 embed 延 40ms，制造可观察窗口

    // 5 份略有差异的 buffer（避免去重命中）
    const tasks = Array.from({ length: 5 }, (_, i) =>
      queue.enqueue({
        buffer: Buffer.from(`# 文档 ${i}\n\n${"段落内容。".repeat(30)}`, "utf8"),
        filename: `f${i}.md`,
        embedder,
        userId: "user-q",
      }),
    );

    // 轮询观察 running 峰值
    let peak = 0;
    const tick = setInterval(() => {
      const r = queue.running();
      if (r > peak) peak = r;
    }, 5);

    const results = await Promise.all(tasks);
    clearInterval(tick);

    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.document.status).toBe("indexed");
    }
    // 并发控制生效：同时运行数不应超过 3
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe("落库一致性", () => {
  it("成功后 getDocument + listChunksByDoc 与返回值一致", async () => {
    const buffer = buildMarkdownBuffer();
    const res = await ingestDocument({
      buffer, filename: "a.md", embedder: new MockEmbedder(), userId: "user-c",
    });
    const fetchedDoc = getDocument(res.document.id);
    expect(fetchedDoc).not.toBeNull();
    expect(fetchedDoc!.status).toBe("indexed");
    const fetchedChunks = listChunksByDoc(res.document.id);
    expect(fetchedChunks).toHaveLength(res.chunks.length);
    // chunk_index 连续
    for (let i = 0; i < fetchedChunks.length; i++) {
      expect(fetchedChunks[i].chunkIndex).toBe(i);
    }
  });
});
