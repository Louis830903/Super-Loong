/**
 * T6 知识库 Provider 单测（Spec §T6）。
 *
 * 覆盖点：
 *   A. formatKbPrefetch 纯函数
 *   B. 生命周期 initialize / shutdown
 *   C. systemPromptBlock
 *   D. prefetch
 *      1. 未初始化容错
 *      2. 空 query
 *      3. 命中后 Markdown 格式正确
 *      4. 无命中返回空串
 *   E. syncTurn no-op
 *   F. getToolSchemas（kb_search + kb_list，schema 结构）
 *   G. handleToolCall 路由
 *      1. kb_search 正常查询
 *      2. kb_search 空 query 返回 error
 *      3. kb_list 返回文档清单
 *      4. 未知工具返回 error
 *   H. 隔离作用域：Provider agentId/userId 限制工具访问
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

import { initDatabase, closeDatabase } from "../persistence/sqlite.js";
import {
  KnowledgeBaseProvider,
  formatKbPrefetch,
  createKbSearchTool,
  createKbListTool,
  // 仓储直接构造测试数据
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
import type { ToolContext } from "../types/index.js";

// ─── 测试环境 ─────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-kb-provider-"));
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
  const docs = listDocuments({}, { limit: 10_000 });
  for (const d of docs) deleteDocument(d.id);
});

// ─── 测试工具 ─────────────────────────────────────

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

async function seedDoc(
  fixture: {
    docId: string;
    agentId: string | null;
    userId: string | null;
    filename: string;
    chunks: Array<{ content: string }>;
  },
  embedder: KBEmbedder,
): Promise<void> {
  const now = Date.now();
  const doc: KBDocument = {
    id: fixture.docId,
    agentId: fixture.agentId,
    userId: fixture.userId,
    filename: fixture.filename,
    mime: "text/markdown",
    size: fixture.chunks.reduce((n, c) => n + c.content.length, 0),
    contentHash: randomUUID(),
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
    chunks.push({
      id: `${fixture.docId}-chunk-${i}`,
      docId: fixture.docId,
      chunkIndex: i,
      content,
      embedding: await embedder.embed(content),
      embeddingType: embedder.embeddingType,
      tokenCount: Math.ceil(content.length / 3),
      metadata: {},
      createdAt: now,
    });
  }
  insertChunks(chunks);
}

/** 构造一个测试上下文 */
const mkCtx = (agentId = "agent-1", sessionId = "session-1", userId?: string): ToolContext => ({
  agentId,
  sessionId,
  userId,
});

// ─── A. formatKbPrefetch 纯函数 ─────────────────────

describe("formatKbPrefetch", () => {
  function mkHit(filename: string, content: string): RetrievedChunk {
    return {
      chunk: {
        id: `c-${filename}`,
        docId: `d-${filename}`,
        chunkIndex: 0,
        content,
        embeddingType: "simple",
        tokenCount: 10,
        metadata: {},
        createdAt: 0,
      },
      score: 0.8,
      document: { id: `d-${filename}`, filename, agentId: null, userId: null },
    };
  }

  it("空命中返回空串（不注入 header）", () => {
    expect(formatKbPrefetch([])).toBe("");
  });

  it("单命中：header + filename + content，无尾部 ---", () => {
    const out = formatKbPrefetch([mkHit("foo.md", "  hello kb\n")]);
    expect(out).toContain("## 知识库参考资料");
    expect(out).toContain("### foo.md");
    expect(out).toContain("hello kb");
    expect(out.endsWith("---")).toBe(false);
  });

  it("多命中：两条之间有分隔符，末尾不带", () => {
    const out = formatKbPrefetch([
      mkHit("a.md", "content A"),
      mkHit("b.md", "content B"),
    ]);
    // 两个 filename 都出现
    expect(out).toContain("### a.md");
    expect(out).toContain("### b.md");
    // 中间必有 ---
    expect(out.split("---").length).toBe(2); // 1 个 --- → split 出 2 段
    expect(out.endsWith("---")).toBe(false);
  });
});

// ─── B. 生命周期 ────────────────────────────────────

describe("KnowledgeBaseProvider lifecycle", () => {
  it("name 固定 'knowledge-base'（非 builtin）", () => {
    const p = new KnowledgeBaseProvider({ embedder: new KeywordEmbedder(["x"]) });
    expect(p.name).toBe("knowledge-base");
  });

  it("构造时缺 embedder 抛错", () => {
    expect(
      () => new KnowledgeBaseProvider({ embedder: null as unknown as KBEmbedder }),
    ).toThrow(/embedder is required/);
  });

  it("构造后工具列表即就绪，不再依赖 initialize", async () => {
    const p = new KnowledgeBaseProvider({ embedder: new KeywordEmbedder(["x"]) });
    // 工具在构造时创建（支持全局注册模式）
    expect(p.getToolSchemas()).toHaveLength(2);
    await p.initialize({ sessionId: "s1", agentId: "a1" });
    expect(p.getToolSchemas()).toHaveLength(2);
    await p.shutdown();
    // shutdown 不重置工具（构造时创建，生命周期内始终可用）
    expect(p.getToolSchemas()).toHaveLength(2);
  });
});

// ─── C. systemPromptBlock ───────────────────────────

describe("KnowledgeBaseProvider.systemPromptBlock", () => {
  it("默认返回空串（不占 prompt 预算）", () => {
    const p = new KnowledgeBaseProvider({ embedder: new KeywordEmbedder(["x"]) });
    expect(p.systemPromptBlock()).toBe("");
  });

  it("自定义 hint 透传", () => {
    const p = new KnowledgeBaseProvider({
      embedder: new KeywordEmbedder(["x"]),
      systemPromptHint: "你有一个知识库可以使用",
    });
    expect(p.systemPromptBlock()).toBe("你有一个知识库可以使用");
  });
});

// ─── D. prefetch ─────────────────────────────────────

describe("KnowledgeBaseProvider.prefetch", () => {
  it("未初始化返回空串（容错）", async () => {
    const p = new KnowledgeBaseProvider({ embedder: new KeywordEmbedder(["x"]) });
    expect(await p.prefetch("hello")).toBe("");
  });

  it("空 query 返回空串", async () => {
    const emb = new KeywordEmbedder(["hello"]);
    const p = new KnowledgeBaseProvider({ embedder: emb });
    await p.initialize({ sessionId: "s1", agentId: "a1" });
    expect(await p.prefetch("")).toBe("");
    expect(await p.prefetch("   ")).toBe("");
  });

  it("命中后格式化为 Markdown（含 header + filename + content）", async () => {
    const emb = new KeywordEmbedder(["机器学习", "深度学习"]);
    await seedDoc(
      {
        docId: "doc-a",
        agentId: "a1",
        userId: null,
        filename: "ml-intro.md",
        chunks: [{ content: "这是一篇关于 机器学习 的入门文档。" }],
      },
      emb,
    );
    const p = new KnowledgeBaseProvider({
      embedder: emb,
      prefetchTopK: 3,
    });
    await p.initialize({ sessionId: "s1", agentId: "a1" });
    const out = await p.prefetch("机器学习");
    expect(out).toContain("## 知识库参考资料");
    expect(out).toContain("### ml-intro.md");
    expect(out).toContain("机器学习");
  });

  it("无命中返回空串", async () => {
    const emb = new KeywordEmbedder(["a", "b"]);
    const p = new KnowledgeBaseProvider({ embedder: emb });
    await p.initialize({ sessionId: "s1", agentId: "a1" });
    // 没种文档 → 无命中
    expect(await p.prefetch("a")).toBe("");
  });
});

// ─── E. syncTurn no-op ──────────────────────────────

describe("KnowledgeBaseProvider.syncTurn", () => {
  it("syncTurn 不抛错且不改变状态", async () => {
    const p = new KnowledgeBaseProvider({ embedder: new KeywordEmbedder(["x"]) });
    await p.initialize({ sessionId: "s1", agentId: "a1" });
    await expect(p.syncTurn("user msg", "asst msg")).resolves.toBeUndefined();
  });
});

// ─── F. getToolSchemas ─────────────────────────────

describe("KnowledgeBaseProvider.getToolSchemas", () => {
  it("返回 kb_search + kb_list，parameters 为 ZodType", async () => {
    const p = new KnowledgeBaseProvider({ embedder: new KeywordEmbedder(["x"]) });
    await p.initialize({ sessionId: "s1", agentId: "a1" });
    const tools = p.getToolSchemas();
    expect(tools.map((t) => t.name).sort()).toEqual(["kb_list", "kb_search"]);
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.parameters).toBeDefined();
      expect(typeof t.execute).toBe("function");
    }
  });

  it("kb_search.parameters 校验 query 必填 / docIds 可选数组", async () => {
    const p = new KnowledgeBaseProvider({ embedder: new KeywordEmbedder(["x"]) });
    await p.initialize({ sessionId: "s1", agentId: "a1" });
    const kbSearch = p.getToolSchemas().find((t) => t.name === "kb_search")!;
    // Zod 直接 parse 验证
    expect(() => (kbSearch.parameters as import("zod").ZodType).parse({ query: "hi" })).not.toThrow();
    expect(() => (kbSearch.parameters as import("zod").ZodType).parse({})).toThrow();
    expect(() =>
      (kbSearch.parameters as import("zod").ZodType).parse({ query: "hi", docIds: ["d1"] }),
    ).not.toThrow();
  });
});

// ─── G. handleToolCall 路由 ────────────────────────

describe("KnowledgeBaseProvider.handleToolCall", () => {
  it("kb_search 命中：返回 success + JSON hits", async () => {
    const emb = new KeywordEmbedder(["机器学习", "深度学习"]);
    await seedDoc(
      {
        docId: "doc-a",
        agentId: "a1",
        userId: null,
        filename: "ml.md",
        chunks: [{ content: "机器学习 入门" }],
      },
      emb,
    );
    const p = new KnowledgeBaseProvider({ embedder: emb });
    await p.initialize({ sessionId: "s1", agentId: "a1" });
    // 工具从 ctx 读取隔离信息（全局工具模式），必须传入匹配的 agentId
    const res = await p.handleToolCall("kb_search", { query: "机器学习" }, mkCtx("a1"));
    expect(res.success).toBe(true);
    expect(res.data).toBeDefined();
    const data = res.data as { count: number; hits: Array<{ filename: string }> };
    expect(data.count).toBeGreaterThan(0);
    expect(data.hits[0].filename).toBe("ml.md");
  });

  it("kb_search 空 query：返回 error", async () => {
    const p = new KnowledgeBaseProvider({ embedder: new KeywordEmbedder(["x"]) });
    await p.initialize({ sessionId: "s1", agentId: "a1" });
    const res = await p.handleToolCall("kb_search", { query: "" }, mkCtx());
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();
  });

  it("kb_list 返回当前 scope 下的文档", async () => {
    const emb = new KeywordEmbedder(["x"]);
    await seedDoc(
      {
        docId: "doc-1",
        agentId: "a1",
        userId: null,
        filename: "d1.md",
        chunks: [{ content: "x" }],
      },
      emb,
    );
    await seedDoc(
      {
        docId: "doc-2",
        agentId: "a1",
        userId: null,
        filename: "d2.md",
        chunks: [{ content: "x" }],
      },
      emb,
    );
    const p = new KnowledgeBaseProvider({ embedder: emb });
    await p.initialize({ sessionId: "s1", agentId: "a1" });
    // 工具从 ctx 读取隔离信息（全局工具模式），必须传入匹配的 agentId
    const res = await p.handleToolCall("kb_list", {}, mkCtx("a1"));
    expect(res.success).toBe(true);
    const data = res.data as { count: number; docs: Array<{ filename: string }> };
    expect(data.count).toBe(2);
    expect(data.docs.map((d) => d.filename).sort()).toEqual(["d1.md", "d2.md"]);
  });

  it("未知工具名：返回 unknown_tool error", async () => {
    const p = new KnowledgeBaseProvider({ embedder: new KeywordEmbedder(["x"]) });
    await p.initialize({ sessionId: "s1", agentId: "a1" });
    const res = await p.handleToolCall("not_exist", {}, mkCtx());
    expect(res.success).toBe(false);
    expect(res.error).toBe("unknown_tool");
  });

  it("kb_search 参数校验失败：返回 error（非 throw）", async () => {
    const p = new KnowledgeBaseProvider({ embedder: new KeywordEmbedder(["x"]) });
    await p.initialize({ sessionId: "s1", agentId: "a1" });
    const res = await p.handleToolCall("kb_search", { foo: "bar" }, mkCtx());
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();
  });
});

// ─── H. 隔离作用域 ──────────────────────────────────

describe("KnowledgeBaseProvider isolation", () => {
  it("Provider 绑定 agentId-A 不应看到 agentId-B 的文档", async () => {
    const emb = new KeywordEmbedder(["机密"]);
    await seedDoc(
      {
        docId: "doc-A",
        agentId: "agent-A",
        userId: null,
        filename: "only-A.md",
        chunks: [{ content: "这是 机密 文档 A" }],
      },
      emb,
    );
    await seedDoc(
      {
        docId: "doc-B",
        agentId: "agent-B",
        userId: null,
        filename: "only-B.md",
        chunks: [{ content: "这是 机密 文档 B" }],
      },
      emb,
    );

    const pA = new KnowledgeBaseProvider({ embedder: emb });
    await pA.initialize({ sessionId: "s1", agentId: "agent-A" });

    // kb_list 只看到 A 的文档
    const listRes = await pA.handleToolCall("kb_list", {}, mkCtx("agent-A"));
    const listData = listRes.data as { docs: Array<{ filename: string }> };
    expect(listData.docs).toHaveLength(1);
    expect(listData.docs[0].filename).toBe("only-A.md");

    // kb_search 也只看到 A 的文档
    const searchRes = await pA.handleToolCall(
      "kb_search",
      { query: "机密" },
      mkCtx("agent-A"),
    );
    const searchData = searchRes.data as { hits: Array<{ filename: string }> };
    expect(searchData.hits.every((h) => h.filename === "only-A.md")).toBe(true);
  });
});

// ─── I. 工厂函数独立测试 ─────────────────────────────

describe("createKbSearchTool / createKbListTool (factory)", () => {
  it("工厂函数返回合法的 ToolDefinition", () => {
    const emb = new KeywordEmbedder(["x"]);
    const search = createKbSearchTool({
      embedder: emb,
      agentId: "a1",
      userId: null,
    });
    const list = createKbListTool({
      embedder: emb,
      agentId: "a1",
      userId: null,
    });
    expect(search.name).toBe("kb_search");
    expect(list.name).toBe("kb_list");
    expect(typeof search.execute).toBe("function");
    expect(typeof list.execute).toBe("function");
  });
});
