/**
 * T1.5 知识库仓储层单测（知识库 Spec §5.1）
 *
 * 覆盖点：
 *   1. migrateV17 幂等：schema_version >= 17
 *   2. kb_documents CRUD（insert / get / update / list / count / delete）
 *   3. findDocumentByHash：同 user 查得到；不同 user 查不到；user=NULL 独立命名空间
 *   4. UNIQUE(user_id, content_hash) WHERE user_id IS NOT NULL：
 *      - 同 user 重复 hash → 抛 KB_DUPLICATE_HASH
 *      - 不同 user 重复 hash → OK
 *      - user=NULL 重复 hash → OK（部分索引不生效）
 *   5. kb_chunks CRUD + embedding Float32Array 序列化往返
 *   6. deleteDocument 级联删 chunks
 *   7. scanIndexedChunks：隔离过滤 + 只返回带 embedding 的
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  initDatabase,
  closeDatabase,
} from "../persistence/sqlite.js";
import {
  insertDocument,
  updateDocument,
  getDocument,
  findDocumentByHash,
  listDocuments,
  countDocuments,
  deleteDocument,
  insertChunks,
  listChunksByDoc,
  getChunksByIds,
  updateChunkEmbedding,
  deleteChunksByDoc,
  scanIndexedChunks,
} from "../knowledgebase/index.js";
import type { KBDocument, KBChunk } from "../knowledgebase/index.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let dbPath: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-kb-repo-"));
  dbPath = path.join(tmpDir, "test.db");
  await initDatabase(dbPath);
});

afterAll(async () => {
  await closeDatabase();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

/** 测试用文档构造器 */
function makeDoc(overrides: Partial<KBDocument> = {}): KBDocument {
  const now = Date.now();
  return {
    id: `doc-${Math.random().toString(36).slice(2, 10)}`,
    agentId: null,
    userId: null,
    filename: "test.md",
    mime: "text/markdown",
    size: 100,
    contentHash: "hash-default",
    sourcePath: null,
    status: "pending",
    error: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** 测试用分块构造器 */
function makeChunk(docId: string, idx: number, overrides: Partial<KBChunk> = {}): KBChunk {
  return {
    id: `chunk-${docId}-${idx}`,
    docId,
    chunkIndex: idx,
    content: `chunk content ${idx}`,
    embedding: undefined,
    embeddingType: "simple",
    tokenCount: 10,
    metadata: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

// ─── 1. 迁移幂等 ─────────────────────────────────────────

describe("Migration v17 幂等", () => {
  it("初始化后 kb_documents 表应可用", () => {
    const docs = listDocuments();
    expect(Array.isArray(docs)).toBe(true);
  });

  it("初始化后 kb_chunks 表应可用（按空 docId 查询不报错）", () => {
    const chunks = listChunksByDoc("nonexistent-doc");
    expect(chunks).toEqual([]);
  });
});

// ─── 2. kb_documents CRUD ────────────────────────────────

describe("kb_documents CRUD", () => {
  it("insert → get 应正确读写", () => {
    const doc = makeDoc({ id: "crud-1", contentHash: "crud-hash-1", userId: "u1" });
    insertDocument(doc);
    const got = getDocument("crud-1");
    expect(got).not.toBeNull();
    expect(got!.id).toBe("crud-1");
    expect(got!.userId).toBe("u1");
    expect(got!.contentHash).toBe("crud-hash-1");
    expect(got!.status).toBe("pending");
  });

  it("update 应部分更新字段", () => {
    const doc = makeDoc({ id: "crud-2", contentHash: "crud-hash-2", userId: "u1" });
    insertDocument(doc);
    updateDocument("crud-2", { status: "indexed", error: null, metadata: { foo: "bar" } });
    const got = getDocument("crud-2");
    expect(got!.status).toBe("indexed");
    expect(got!.metadata).toEqual({ foo: "bar" });
  });

  it("list + count 应支持隔离过滤", () => {
    // 插入 3 条：agent=A 2 条，agent=B 1 条
    insertDocument(makeDoc({ id: "iso-a1", contentHash: "iso-a1", agentId: "A", userId: "u-iso" }));
    insertDocument(makeDoc({ id: "iso-a2", contentHash: "iso-a2", agentId: "A", userId: "u-iso" }));
    insertDocument(makeDoc({ id: "iso-b1", contentHash: "iso-b1", agentId: "B", userId: "u-iso" }));

    const aDocs = listDocuments({ agentId: "A", userId: "u-iso" });
    expect(aDocs.length).toBe(2);
    expect(aDocs.every((d) => d.agentId === "A")).toBe(true);

    const countA = countDocuments({ agentId: "A", userId: "u-iso" });
    expect(countA).toBe(2);

    const countB = countDocuments({ agentId: "B", userId: "u-iso" });
    expect(countB).toBe(1);
  });

  it("list 支持 status 过滤 + 分页", () => {
    const pending = listDocuments({ status: "pending" }, { limit: 100 });
    expect(pending.every((d) => d.status === "pending")).toBe(true);

    const page1 = listDocuments({}, { limit: 1, offset: 0 });
    expect(page1.length).toBeLessThanOrEqual(1);
  });

  it("getDocument 不存在应返回 null", () => {
    expect(getDocument("nonexistent-id-99")).toBeNull();
  });
});

// ─── 3. findDocumentByHash ──────────────────────────────

describe("findDocumentByHash 隔离语义", () => {
  beforeAll(() => {
    insertDocument(makeDoc({ id: "hash-u1", contentHash: "H", userId: "u1" }));
    insertDocument(makeDoc({ id: "hash-u2", contentHash: "H", userId: "u2" }));
    insertDocument(makeDoc({ id: "hash-global", contentHash: "H", userId: null }));
  });

  it("同 user 同 hash 查得到", () => {
    const got = findDocumentByHash("H", "u1");
    expect(got?.id).toBe("hash-u1");
  });

  it("不同 user 同 hash 独立命名空间", () => {
    const got = findDocumentByHash("H", "u2");
    expect(got?.id).toBe("hash-u2");
  });

  it("userId=null 独立于所有具名 user", () => {
    const got = findDocumentByHash("H", null);
    expect(got?.id).toBe("hash-global");
  });

  it("不存在的 hash 返回 null", () => {
    expect(findDocumentByHash("nonexistent-hash", "u1")).toBeNull();
  });
});

// ─── 4. UNIQUE 约束 ─────────────────────────────────────

describe("UNIQUE(user_id, content_hash) WHERE user_id IS NOT NULL", () => {
  it("同 user 重复 hash → 抛 KB_DUPLICATE_HASH", () => {
    insertDocument(makeDoc({ id: "dup-1", contentHash: "dup-hash", userId: "dup-user" }));
    expect(() => {
      insertDocument(makeDoc({ id: "dup-2", contentHash: "dup-hash", userId: "dup-user" }));
    }).toThrow("KB_DUPLICATE_HASH");
  });

  it("不同 user 重复 hash → OK", () => {
    insertDocument(makeDoc({ id: "dup-x-u1", contentHash: "dup-hash-x", userId: "user-x1" }));
    // 不应抛
    insertDocument(makeDoc({ id: "dup-x-u2", contentHash: "dup-hash-x", userId: "user-x2" }));
    expect(getDocument("dup-x-u2")).not.toBeNull();
  });

  it("userId=NULL 重复 hash → OK（部分索引不生效）", () => {
    insertDocument(makeDoc({ id: "null-dup-1", contentHash: "null-hash", userId: null }));
    // 不应抛
    insertDocument(makeDoc({ id: "null-dup-2", contentHash: "null-hash", userId: null }));
    expect(getDocument("null-dup-2")).not.toBeNull();
  });
});

// ─── 5. kb_chunks CRUD + embedding 序列化 ───────────────

describe("kb_chunks CRUD + embedding 序列化", () => {
  const docId = "chunks-doc-1";

  beforeAll(() => {
    insertDocument(makeDoc({ id: docId, contentHash: "chunks-doc-hash", userId: "chunks-u" }));
  });

  it("insertChunks 批量插入 → listChunksByDoc 按 chunk_index ASC 返回", () => {
    insertChunks([
      makeChunk(docId, 2, { content: "c2" }),
      makeChunk(docId, 0, { content: "c0" }),
      makeChunk(docId, 1, { content: "c1" }),
    ]);
    const chunks = listChunksByDoc(docId);
    expect(chunks.length).toBe(3);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    expect(chunks.map((c) => c.content)).toEqual(["c0", "c1", "c2"]);
  });

  it("embedding Float32Array 序列化往返（simple 类型）", () => {
    const emb = [0.1, 0.2, 0.3, 0.4, 0.5];
    const chunkId = `emb-chunk-${Date.now()}`;
    insertChunks([
      makeChunk(docId, 10, { id: chunkId, embedding: emb, embeddingType: "simple" }),
    ]);
    const got = listChunksByDoc(docId).find((c) => c.id === chunkId);
    expect(got).toBeDefined();
    expect(got!.embedding).toBeDefined();
    expect(got!.embedding!.length).toBe(5);
    // Float32 精度损失容忍 1e-6
    for (let i = 0; i < 5; i++) {
      expect(got!.embedding![i]).toBeCloseTo(emb[i], 5);
    }
  });

  it("getChunksByIds 按传入顺序返回", () => {
    const chunks = listChunksByDoc(docId);
    expect(chunks.length).toBeGreaterThan(0);
    const ids = chunks.map((c) => c.id).reverse();
    const got = getChunksByIds(ids);
    expect(got.map((c) => c.id)).toEqual(ids);
  });

  it("updateChunkEmbedding 更新后可反序列化", () => {
    const chunks = listChunksByDoc(docId);
    const first = chunks[0];
    const newEmb = [0.9, 0.8, 0.7];
    updateChunkEmbedding(first.id, newEmb, "simple");
    const updated = getChunksByIds([first.id])[0];
    expect(updated.embedding!.length).toBe(3);
    expect(updated.embedding![0]).toBeCloseTo(0.9, 5);
  });
});

// ─── 6. deleteDocument 级联删 chunks ───────────────────

describe("deleteDocument 级联", () => {
  it("删除文档同时删除其全部分块", () => {
    const docId = "cascade-doc";
    insertDocument(makeDoc({ id: docId, contentHash: "cascade-hash", userId: "cascade-u" }));
    insertChunks([makeChunk(docId, 0), makeChunk(docId, 1), makeChunk(docId, 2)]);
    expect(listChunksByDoc(docId).length).toBe(3);

    const deleted = deleteDocument(docId);
    expect(deleted).toBe(true);
    expect(getDocument(docId)).toBeNull();
    expect(listChunksByDoc(docId).length).toBe(0);
  });

  it("deleteChunksByDoc 只删分块保留文档", () => {
    const docId = "chunks-only-del";
    insertDocument(makeDoc({ id: docId, contentHash: "chunks-only-hash", userId: "chunks-only-u" }));
    insertChunks([makeChunk(docId, 0), makeChunk(docId, 1)]);
    const n = deleteChunksByDoc(docId);
    expect(n).toBe(2);
    expect(getDocument(docId)).not.toBeNull();
    expect(listChunksByDoc(docId).length).toBe(0);
  });

  it("删除不存在的文档返回 false", () => {
    expect(deleteDocument("nonexistent-99")).toBe(false);
  });
});

// ─── 7. scanIndexedChunks 隔离过滤 ─────────────────────

describe("scanIndexedChunks 隔离过滤", () => {
  it("仅返回带 embedding 且通过隔离过滤的分块", () => {
    const docA = "scan-doc-a";
    const docB = "scan-doc-b";
    insertDocument(makeDoc({
      id: docA, contentHash: "scan-hash-a", agentId: "scan-A", userId: "scan-u", status: "indexed",
    }));
    insertDocument(makeDoc({
      id: docB, contentHash: "scan-hash-b", agentId: "scan-B", userId: "scan-u", status: "indexed",
    }));

    // docA 插 2 个带 embedding + 1 个无 embedding
    insertChunks([
      makeChunk(docA, 0, { id: "scan-a-0", embedding: [0.1, 0.2], embeddingType: "simple" }),
      makeChunk(docA, 1, { id: "scan-a-1", embedding: [0.3, 0.4], embeddingType: "simple" }),
      makeChunk(docA, 2, { id: "scan-a-2" }), // 无 embedding
    ]);
    // docB 插 1 个带 embedding
    insertChunks([
      makeChunk(docB, 0, { id: "scan-b-0", embedding: [0.5, 0.6], embeddingType: "simple" }),
    ]);

    // 扫 agent=A 应只拿到 2 条（a-0 / a-1），排除无 embedding 的 a-2 和 agent=B 的 b-0
    const scannedA = scanIndexedChunks({ agentId: "scan-A", userId: "scan-u" });
    const ids = scannedA.map((s) => s.chunk.id).sort();
    expect(ids).toEqual(["scan-a-0", "scan-a-1"]);
    expect(scannedA.every((s) => s.docAgentId === "scan-A")).toBe(true);

    // 扫 agent=B 应只拿到 1 条
    const scannedB = scanIndexedChunks({ agentId: "scan-B", userId: "scan-u" });
    expect(scannedB.length).toBe(1);
    expect(scannedB[0].chunk.id).toBe("scan-b-0");
  });
});
