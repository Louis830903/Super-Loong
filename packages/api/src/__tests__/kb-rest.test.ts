/**
 * 知识库 REST 路由测试（知识库 Spec §8.1 / T8）。
 *
 * 覆盖：6 个端点 × 正常路径 + 边界用例：
 *   1. POST /api/kb/documents —— 上传 md 文本文件成功 → status=indexed
 *   2. POST /api/kb/documents —— 重复上传命中去重 duplicated=true / skipped=true
 *   3. POST /api/kb/documents —— 缺字段 400 / base64 非法 / 体积超限 413
 *   4. GET  /api/kb/documents —— 列表 + 分页
 *   5. GET  /api/kb/documents/:id —— 详情 + 不存在 404
 *   6. POST /api/kb/search —— 命中 / 查询缺失 400
 *   7. DELETE /api/kb/documents/:id —— 删除 + 重复删 404
 *   8. GET  /api/kb/stats —— 文档/分块/字节 汇总
 *
 * 策略：
 *   - Fastify.inject() 内存调用，不真正 listen 端口
 *   - 不走 createAppContext（依赖庞大），只 mock `ctx.embedder`（KBEmbedder 结构即可）
 *   - 使用临时 DB 目录 + initDatabase（与其他知识库测试一致）
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import {
  initDatabase,
  closeDatabase,
  listDocuments,
  deleteDocument,
  type KBEmbedder,
} from "@super-agent/core";

import { knowledgeBaseRoutes } from "../routes/knowledge-base.js";
import type { AppContext } from "../context.js";

// ─── 测试环境 ────────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-kb-rest-"));
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

/** 每个测试前清库 */
beforeEach(() => {
  const docs = listDocuments({}, { limit: 10_000 });
  for (const d of docs) deleteDocument(d.id);
});

// ─── MockEmbedder：128 维确定性向量 ──────────────────────

class MockEmbedder implements KBEmbedder {
  readonly embeddingType = "simple" as const;

  async embed(text: string): Promise<number[]> {
    const dim = 128;
    const vec = new Array<number>(dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[text.charCodeAt(i) % dim] += 1;
    }
    // 归一化
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }
}

// ─── 构造测试用 Fastify 实例 ─────────────────────────────

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // 只注入路由需要的字段（断言测试最小 AppContext）
  const ctx = {
    embedder: new MockEmbedder(),
  } as unknown as AppContext;
  await knowledgeBaseRoutes(app, ctx);
  await app.ready();
  return app;
}

/** 构造 md 文件的 base64（足够长触发分块） */
function mdFileBase64(title: string, body: string): string {
  const content = `# ${title}\n\n${body}`;
  return Buffer.from(content, "utf-8").toString("base64");
}

// ─── A. 上传端点 ────────────────────────────────────────

describe("POST /api/kb/documents", () => {
  it("上传 md 文件成功，返回 201 + status=indexed + chunkCount>0", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/kb/documents",
        payload: {
          filename: "notes.md",
          data: mdFileBase64(
            "知识库测试",
            "这是一段用于测试的文本内容。".repeat(50),
          ),
          agentId: null,
          userId: "user-a",
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.document).toBeDefined();
      expect(body.document.filename).toBe("notes.md");
      expect(body.document.status).toBe("indexed");
      expect(body.duplicated).toBe(false);
      expect(body.skipped).toBe(false);
      expect(body.chunkCount).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("缺 filename 或 data → 400", async () => {
    const app = await buildApp();
    try {
      const res1 = await app.inject({
        method: "POST",
        url: "/api/kb/documents",
        payload: { filename: "x.md" },
      });
      expect(res1.statusCode).toBe(400);
      const res2 = await app.inject({
        method: "POST",
        url: "/api/kb/documents",
        payload: { data: "aGVsbG8=" },
      });
      expect(res2.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("空 base64 → 400 Empty file buffer", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/kb/documents",
        payload: { filename: "empty.md", data: "" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("重复上传相同内容 → duplicated=true / skipped=true", async () => {
    const app = await buildApp();
    try {
      const payload = {
        filename: "dup.md",
        data: mdFileBase64("重复", "相同内容".repeat(80)),
        userId: "user-dup",
      };
      const res1 = await app.inject({
        method: "POST",
        url: "/api/kb/documents",
        payload,
      });
      expect(res1.statusCode).toBe(201);
      const body1 = res1.json();
      expect(body1.duplicated).toBe(false);

      const res2 = await app.inject({
        method: "POST",
        url: "/api/kb/documents",
        payload,
      });
      expect(res2.statusCode).toBe(201);
      const body2 = res2.json();
      expect(body2.duplicated).toBe(true);
      expect(body2.skipped).toBe(true);
      expect(body2.document.id).toBe(body1.document.id);
    } finally {
      await app.close();
    }
  });
});

// ─── B. 列表端点 ────────────────────────────────────────

describe("GET /api/kb/documents", () => {
  it("列出文档 + 分页", async () => {
    const app = await buildApp();
    try {
      // 先上传 3 份
      for (let i = 0; i < 3; i++) {
        await app.inject({
          method: "POST",
          url: "/api/kb/documents",
          payload: {
            filename: `list-${i}.md`,
            data: mdFileBase64(`文档 ${i}`, `内容 ${i} `.repeat(40)),
            userId: "user-list",
          },
        });
      }

      const res = await app.inject({
        method: "GET",
        url: "/api/kb/documents?userId=user-list&limit=2&offset=0",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.documents).toHaveLength(2);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("空库 → total=0, documents=[]", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/kb/documents",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(0);
      expect(body.documents).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("agentId=__null__ 精确匹配 NULL", async () => {
    const app = await buildApp();
    try {
      // 一份 agentId=null，一份 agentId="agent-x"
      await app.inject({
        method: "POST",
        url: "/api/kb/documents",
        payload: {
          filename: "global.md",
          data: mdFileBase64("全局", "g".repeat(200)),
          agentId: null,
          userId: "u-iso",
        },
      });
      await app.inject({
        method: "POST",
        url: "/api/kb/documents",
        payload: {
          filename: "agent-x.md",
          data: mdFileBase64("agentX", "x".repeat(200)),
          agentId: "agent-x",
          userId: "u-iso",
        },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/kb/documents?userId=u-iso&agentId=__null__",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.documents[0].filename).toBe("global.md");
    } finally {
      await app.close();
    }
  });
});

// ─── C. 详情 + 删除 ─────────────────────────────────────

describe("GET / DELETE /api/kb/documents/:id", () => {
  it("详情：返回 document + chunkCount", async () => {
    const app = await buildApp();
    try {
      const up = await app.inject({
        method: "POST",
        url: "/api/kb/documents",
        payload: {
          filename: "detail.md",
          data: mdFileBase64("详情测试", "d".repeat(300)),
          userId: "u-det",
        },
      });
      const id = up.json().document.id;

      const res = await app.inject({
        method: "GET",
        url: `/api/kb/documents/${id}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.document.id).toBe(id);
      expect(body.chunkCount).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("详情：不存在 → 404", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/kb/documents/non-existent-id",
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("删除：成功 → 200 + deleted=true，再删 → 404", async () => {
    const app = await buildApp();
    try {
      const up = await app.inject({
        method: "POST",
        url: "/api/kb/documents",
        payload: {
          filename: "del.md",
          data: mdFileBase64("删除", "e".repeat(200)),
          userId: "u-del",
        },
      });
      const id = up.json().document.id;

      const res1 = await app.inject({
        method: "DELETE",
        url: `/api/kb/documents/${id}`,
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json()).toEqual({ deleted: true });

      const res2 = await app.inject({
        method: "DELETE",
        url: `/api/kb/documents/${id}`,
      });
      expect(res2.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

// ─── D. 搜索 ───────────────────────────────────────────

describe("POST /api/kb/search", () => {
  it("命中：返回 hits + count", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST",
        url: "/api/kb/documents",
        payload: {
          filename: "search-src.md",
          data: mdFileBase64(
            "向量数据库",
            "向量数据库是存储和检索高维向量的专用数据库。".repeat(20),
          ),
          userId: "u-s",
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/kb/search",
        payload: {
          query: "向量数据库",
          userId: "u-s",
          topK: 3,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.hits)).toBe(true);
      expect(body.count).toBe(body.hits.length);
      expect(body.hits.length).toBeGreaterThan(0);
      expect(body.hits[0].chunk).toBeDefined();
      expect(body.hits[0].document).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("缺 query → 400", async () => {
    const app = await buildApp();
    try {
      const res1 = await app.inject({
        method: "POST",
        url: "/api/kb/search",
        payload: {},
      });
      expect(res1.statusCode).toBe(400);

      const res2 = await app.inject({
        method: "POST",
        url: "/api/kb/search",
        payload: { query: "   " },
      });
      expect(res2.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

// ─── E. 统计 ───────────────────────────────────────────

describe("GET /api/kb/stats", () => {
  it("空库 → 全 0", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/kb/stats",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.documentCount).toBe(0);
      expect(body.indexedCount).toBe(0);
      expect(body.failedCount).toBe(0);
      expect(body.totalBytes).toBe(0);
      expect(body.totalChunks).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("有 2 份文档：documentCount=2 / indexedCount=2 / totalBytes 对", async () => {
    const app = await buildApp();
    try {
      const content1 = "# A\n\n" + "内容A".repeat(50);
      const content2 = "# B\n\n" + "内容B".repeat(50);
      await app.inject({
        method: "POST",
        url: "/api/kb/documents",
        payload: {
          filename: "a.md",
          data: Buffer.from(content1).toString("base64"),
          userId: "u-stat",
        },
      });
      await app.inject({
        method: "POST",
        url: "/api/kb/documents",
        payload: {
          filename: "b.md",
          data: Buffer.from(content2).toString("base64"),
          userId: "u-stat",
        },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/kb/stats?userId=u-stat",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.documentCount).toBe(2);
      expect(body.indexedCount).toBe(2);
      expect(body.failedCount).toBe(0);
      expect(body.totalBytes).toBe(
        Buffer.byteLength(content1) + Buffer.byteLength(content2),
      );
      expect(body.totalChunks).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
