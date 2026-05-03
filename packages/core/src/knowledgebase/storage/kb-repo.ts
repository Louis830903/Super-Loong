/**
 * 知识库持久化仓储（知识库 Spec §5.1 / T1）。
 *
 * 承载 kb_documents / kb_chunks 的 CRUD，不涉及解析/向量化/检索业务。
 *
 * 隔离模型（决策 #2）：
 *   - agentId / userId 均 nullable
 *   - 过滤时 undefined = 不限；null = 严格匹配 NULL（用 IS NULL）；string = 等值匹配
 *
 * 向量序列化（与 memory-backend.ts F-2 一致）：
 *   - embedding_type='hrr'     → Float64Array BLOB
 *   - embedding_type 其他值    → Float32Array BLOB
 *
 * 去重（决策 #3）：同 user 内 content_hash UNIQUE（靠 v17 的部分唯一索引）；
 *   insertDocument 捕获 UNIQUE 冲突并抛业务可识别的错误。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getDatabase, scheduleSave } from "../../persistence/sqlite/client.js";
import type {
  KBDocument,
  KBChunk,
  KBDocStatus,
  KBEmbeddingType,
  KBDocumentFilter,
  KBPageOptions,
} from "../types.js";

// ─── 内部工具：行反序列化 ──────────────────────────────────

/** 文档行反序列化 */
function rowToDocument(cols: string[], vals: unknown[]): KBDocument {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < cols.length; i++) obj[cols[i]] = vals[i];
  return {
    id: obj.id as string,
    agentId: (obj.agent_id as string | null) ?? null,
    userId: (obj.user_id as string | null) ?? null,
    filename: obj.filename as string,
    mime: (obj.mime as string | null) ?? null,
    size: (obj.size as number) ?? 0,
    contentHash: obj.content_hash as string,
    sourcePath: (obj.source_path as string | null) ?? null,
    status: obj.status as KBDocStatus,
    error: (obj.error as string | null) ?? null,
    metadata: (() => { try { return JSON.parse((obj.metadata as string) || "{}"); } catch { return {}; } })(),
    createdAt: (obj.created_at as number) ?? 0,
    updatedAt: (obj.updated_at as number) ?? 0,
  };
}

/** 分块行反序列化（embedding BLOB → number[]，按 embedding_type 决定精度） */
function rowToChunk(cols: string[], vals: unknown[]): KBChunk {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < cols.length; i++) obj[cols[i]] = vals[i];

  const embType = ((obj.embedding_type as string) || "simple") as KBEmbeddingType;
  let embedding: number[] | undefined;
  const rawEmb = obj.embedding;
  if (rawEmb && rawEmb instanceof Uint8Array) {
    // F-2 对齐拷贝：直接 new Float32Array(rawEmb.buffer) 可能触发对齐错误
    const aligned = new ArrayBuffer(rawEmb.byteLength);
    new Uint8Array(aligned).set(rawEmb);
    if (embType === "hrr") {
      embedding = Array.from(new Float64Array(aligned));
    } else {
      embedding = Array.from(new Float32Array(aligned));
    }
  }

  return {
    id: obj.id as string,
    docId: obj.doc_id as string,
    chunkIndex: (obj.chunk_index as number) ?? 0,
    content: obj.content as string,
    embedding,
    embeddingType: embType,
    tokenCount: (obj.token_count as number) ?? 0,
    metadata: (() => { try { return JSON.parse((obj.metadata as string) || "{}"); } catch { return {}; } })(),
    createdAt: (obj.created_at as number) ?? 0,
  };
}

/** embedding number[] → Buffer（按 embedding_type 决定精度） */
function embeddingToBlob(embedding: number[] | undefined, type: KBEmbeddingType): Buffer | null {
  if (!embedding || embedding.length === 0) return null;
  if (type === "hrr") {
    return Buffer.from(new Float64Array(embedding).buffer);
  }
  return Buffer.from(new Float32Array(embedding).buffer);
}

/** 构建隔离过滤 WHERE 子句 */
function buildDocWhere(filter: KBDocumentFilter): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  // agentId：undefined=不限；null=IS NULL；string=等值
  if (filter.agentId !== undefined) {
    if (filter.agentId === null) {
      conditions.push("agent_id IS NULL");
    } else {
      conditions.push("agent_id = ?");
      params.push(filter.agentId);
    }
  }
  if (filter.userId !== undefined) {
    if (filter.userId === null) {
      conditions.push("user_id IS NULL");
    } else {
      conditions.push("user_id = ?");
      params.push(filter.userId);
    }
  }
  if (filter.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }

  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  return { where, params };
}

// ─── kb_documents CRUD ────────────────────────────────────

/**
 * 插入或覆盖文档（id 冲突则覆盖；同 user 内 content_hash 冲突抛错）
 *
 * 注意 INSERT OR REPLACE 的语义：冲突时会先 DELETE 旧行再 INSERT 新行，
 * 这导致 UNIQUE(user_id, content_hash) 约束不会触发（旧行被先删除）。
 * 所以我们先手工查一次「同 user 下已有 content_hash 但 id 不同」，有则抛业务错。
 *
 * @throws Error("KB_DUPLICATE_HASH")：同 user 下 content_hash 已存在于其他文档
 */
export function insertDocument(doc: KBDocument): void {
  const db = getDatabase();

  // 决策 #3：同 user 内 content_hash 去重（全局库 user_id=NULL 不约束，业务层如需可补）
  // 用 id != ? 排除「同一文档覆盖写」场景
  if (doc.userId !== null) {
    const dupRes = db.exec(
      "SELECT id FROM kb_documents WHERE user_id = ? AND content_hash = ? AND id != ?",
      [doc.userId, doc.contentHash, doc.id],
    );
    if (dupRes.length && dupRes[0].values.length) {
      throw new Error("KB_DUPLICATE_HASH");
    }
  }

  try {
    db.run(
      `INSERT OR REPLACE INTO kb_documents (
        id, agent_id, user_id, filename, mime, size, content_hash, source_path,
        status, error, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        doc.id,
        doc.agentId,
        doc.userId,
        doc.filename,
        doc.mime,
        doc.size,
        doc.contentHash,
        doc.sourcePath,
        doc.status,
        doc.error,
        JSON.stringify(doc.metadata ?? {}),
        doc.createdAt,
        doc.updatedAt,
      ],
    );
    scheduleSave();
  } catch (e: any) {
    // 兜底：极端竞态下仍可能触发部分唯一索引（并发写同 user 同 hash）
    const msg = String(e?.message ?? "");
    if (msg.includes("UNIQUE") && msg.includes("uq_kb_docs_user_hash")) {
      throw new Error("KB_DUPLICATE_HASH");
    }
    throw e;
  }
}

/** 部分更新文档字段（键名走 snake_case 列名映射） */
export function updateDocument(id: string, patch: Partial<KBDocument>): void {
  // 字段 → 列名映射表
  const colMap: Record<string, string> = {
    agentId: "agent_id",
    userId: "user_id",
    filename: "filename",
    mime: "mime",
    size: "size",
    contentHash: "content_hash",
    sourcePath: "source_path",
    status: "status",
    error: "error",
    metadata: "metadata",
    createdAt: "created_at",
    updatedAt: "updated_at",
  };
  const keys = Object.keys(patch).filter((k) => k !== "id" && k in colMap);
  if (keys.length === 0) return;

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const k of keys) {
    sets.push(`${colMap[k]} = ?`);
    const v = (patch as Record<string, unknown>)[k];
    if (k === "metadata") {
      params.push(JSON.stringify(v ?? {}));
    } else {
      params.push(v === undefined ? null : (v as string | number | null));
    }
  }
  params.push(id);
  const db = getDatabase();
  db.run(`UPDATE kb_documents SET ${sets.join(", ")} WHERE id = ?`, params);
  scheduleSave();
}

/** 按 ID 获取文档；不存在返回 null */
export function getDocument(id: string): KBDocument | null {
  const db = getDatabase();
  const res = db.exec("SELECT * FROM kb_documents WHERE id = ?", [id]);
  if (!res.length || !res[0].values.length) return null;
  return rowToDocument(res[0].columns, res[0].values[0]);
}

/** 按 content_hash 在同一 user 下查询（去重预检查用；全局库 user_id=NULL 视情况） */
export function findDocumentByHash(
  contentHash: string,
  userId: string | null,
): KBDocument | null {
  const db = getDatabase();
  let sql = "SELECT * FROM kb_documents WHERE content_hash = ?";
  const params: unknown[] = [contentHash];
  if (userId === null) {
    sql += " AND user_id IS NULL";
  } else {
    sql += " AND user_id = ?";
    params.push(userId);
  }
  sql += " LIMIT 1";
  const res = db.exec(sql, params);
  if (!res.length || !res[0].values.length) return null;
  return rowToDocument(res[0].columns, res[0].values[0]);
}

/** 列表查询（支持隔离过滤 + 状态过滤 + 分页，按 created_at DESC） */
export function listDocuments(
  filter: KBDocumentFilter = {},
  page: KBPageOptions = {},
): KBDocument[] {
  const { where, params } = buildDocWhere(filter);
  const { limit = 50, offset = 0 } = page;
  const sql = `SELECT * FROM kb_documents${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  const db = getDatabase();
  const res = db.exec(sql, [...params, limit, offset]);
  if (!res.length) return [];
  return res[0].values.map((row: unknown[]) => rowToDocument(res[0].columns, row));
}

/** 统计匹配过滤器的文档数 */
export function countDocuments(filter: KBDocumentFilter = {}): number {
  const { where, params } = buildDocWhere(filter);
  const db = getDatabase();
  const res = db.exec(`SELECT COUNT(*) FROM kb_documents${where}`, params);
  if (!res.length || !res[0].values.length) return 0;
  return res[0].values[0][0] as number;
}

/**
 * 删除文档 + 其所有分块（CASCADE 依赖 foreign_keys=ON；保险起见手动级联）。
 * 返回是否真的删除了一条。
 */
export function deleteDocument(id: string): boolean {
  const existing = getDocument(id);
  if (!existing) return false;
  const db = getDatabase();
  // 手动级联（sql.js 默认 foreign_keys=OFF）
  db.run("DELETE FROM kb_chunks WHERE doc_id = ?", [id]);
  db.run("DELETE FROM kb_documents WHERE id = ?", [id]);
  scheduleSave();
  return true;
}

// ─── kb_chunks CRUD ───────────────────────────────────────

/** 批量插入分块（事务内执行，成功后一次 scheduleSave） */
export function insertChunks(chunks: KBChunk[]): void {
  if (chunks.length === 0) return;
  const db = getDatabase();
  db.run("BEGIN TRANSACTION");
  try {
    for (const c of chunks) {
      const blob = embeddingToBlob(c.embedding, c.embeddingType);
      db.run(
        `INSERT OR REPLACE INTO kb_chunks (
          id, doc_id, chunk_index, content, embedding, embedding_type,
          token_count, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          c.id,
          c.docId,
          c.chunkIndex,
          c.content,
          blob,
          c.embeddingType,
          c.tokenCount,
          JSON.stringify(c.metadata ?? {}),
          c.createdAt,
        ],
      );
    }
    db.run("COMMIT");
    scheduleSave();
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}

/** 按 docId 获取该文档的全部分块（chunk_index ASC） */
export function listChunksByDoc(docId: string): KBChunk[] {
  const db = getDatabase();
  const res = db.exec(
    "SELECT * FROM kb_chunks WHERE doc_id = ? ORDER BY chunk_index ASC",
    [docId],
  );
  if (!res.length) return [];
  return res[0].values.map((row: unknown[]) => rowToChunk(res[0].columns, row));
}

/** 按 ID 批量获取分块（保持传入顺序） */
export function getChunksByIds(ids: string[]): KBChunk[] {
  if (ids.length === 0) return [];
  const db = getDatabase();
  const placeholders = ids.map(() => "?").join(",");
  const res = db.exec(`SELECT * FROM kb_chunks WHERE id IN (${placeholders})`, ids);
  if (!res.length) return [];
  const indexed = new Map<string, KBChunk>();
  for (const row of res[0].values) {
    const chunk = rowToChunk(res[0].columns, row);
    indexed.set(chunk.id, chunk);
  }
  // 按输入顺序还原
  return ids.map((id) => indexed.get(id)).filter((c): c is KBChunk => c !== undefined);
}

/** 更新分块向量（embedding 与 embedding_type 同步写入） */
export function updateChunkEmbedding(
  chunkId: string,
  embedding: number[],
  embeddingType: KBEmbeddingType,
): void {
  const blob = embeddingToBlob(embedding, embeddingType);
  const db = getDatabase();
  db.run(
    "UPDATE kb_chunks SET embedding = ?, embedding_type = ? WHERE id = ?",
    [blob, embeddingType, chunkId],
  );
  scheduleSave();
}

/** 删除某文档的全部分块（deleteDocument 内部已级联，单独保留供手工调用） */
export function deleteChunksByDoc(docId: string): number {
  const db = getDatabase();
  const countRes = db.exec("SELECT COUNT(*) FROM kb_chunks WHERE doc_id = ?", [docId]);
  const n = countRes.length ? (countRes[0].values[0][0] as number) : 0;
  db.run("DELETE FROM kb_chunks WHERE doc_id = ?", [docId]);
  scheduleSave();
  return n;
}

/**
 * 扫描同一隔离空间下的全部带向量分块（向量检索主扫描方法）。
 * 受限制：O(N) 全表扫描，N 大时需上 HNSW；v1 阶段接受。
 * SELECT c.* 与 JOIN kb_documents d 存在列重名风险，两表列名需定期对齐；未来考虑显式列名。
 *
 * @param filter 文档级过滤（agentId / userId / status=indexed 建议必传）
 * @returns 每个分块 + 所属文档的最小元数据（避免上层再查一次）
 */
export function scanIndexedChunks(
  filter: KBDocumentFilter = {},
): Array<{ chunk: KBChunk; docFilename: string; docAgentId: string | null; docUserId: string | null }> {
  // 直接构造 JOIN 后的 WHERE（用 d.xxx 前缀，避免列名冲突）
  const conds: string[] = ["c.embedding IS NOT NULL"];
  const params: unknown[] = [];
  if (filter.agentId !== undefined) {
    if (filter.agentId === null) conds.push("d.agent_id IS NULL");
    else { conds.push("d.agent_id = ?"); params.push(filter.agentId); }
  }
  if (filter.userId !== undefined) {
    if (filter.userId === null) conds.push("d.user_id IS NULL");
    else { conds.push("d.user_id = ?"); params.push(filter.userId); }
  }
  if (filter.status) {
    conds.push("d.status = ?");
    params.push(filter.status);
  }

  // V1 启发式安全阀：优先最新文档，硬上限防止 OOM。非正确解，≥10000 chunk 的 KB 必须上 HNSW
  const sql = `
    SELECT c.*, d.filename AS _doc_filename, d.agent_id AS _doc_agent_id, d.user_id AS _doc_user_id
    FROM kb_chunks c
    JOIN kb_documents d ON d.id = c.doc_id
    WHERE ${conds.join(" AND ")}
    ORDER BY d.created_at DESC
    LIMIT 10000
  `;

  const db = getDatabase();
  const res = db.exec(sql, params);
  if (!res.length) return [];

  const out: Array<{ chunk: KBChunk; docFilename: string; docAgentId: string | null; docUserId: string | null }> = [];
  // 预先分离出属于 kb_chunks 的列（用于 rowToChunk 反序列化）
  const allCols: string[] = res[0].columns;
  const chunkCols: string[] = allCols.filter((c: string) => !c.startsWith("_doc_"));
  const chunkColIdx: number[] = chunkCols.map((c: string) => allCols.indexOf(c));
  const docFilenameIdx = allCols.indexOf("_doc_filename");
  const docAgentIdx = allCols.indexOf("_doc_agent_id");
  const docUserIdx = allCols.indexOf("_doc_user_id");

  for (const row of res[0].values) {
    const chunkVals = chunkColIdx.map((i: number) => (row as unknown[])[i]);
    const chunk = rowToChunk(chunkCols, chunkVals);
    out.push({
      chunk,
      docFilename: ((row as unknown[])[docFilenameIdx] as string) ?? "",
      docAgentId: ((row as unknown[])[docAgentIdx] as string | null) ?? null,
      docUserId: ((row as unknown[])[docUserIdx] as string | null) ?? null,
    });
  }
  return out;
}
