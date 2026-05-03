/**
 * 知识库模块核心类型定义（知识库 Spec §5）。
 *
 * 三大核心类型：
 *   - KBDocument：文档元数据（对应 kb_documents 行）
 *   - KBChunk   ：分块 + 向量（对应 kb_chunks 行）
 *   - RetrievedChunk：检索结果（chunk + score + doc 元数据）
 *
 * 隔离模型（决策 #2）：agentId + userId 双 nullable，AND 过滤
 *   - agentId=NULL 且 userId=NULL：全局共享库
 *   - agentId=X    且 userId=NULL：Agent 范围库
 *   - agentId=NULL 且 userId=U   ：用户个人库
 *   - agentId=X    且 userId=U   ：特定 Agent 下的用户库
 */

/** 文档处理状态机 */
export type KBDocStatus = "pending" | "parsing" | "chunking" | "embedding" | "indexed" | "failed";

/** 嵌入向量类型（与 memories 共用同一枚举，兼容 F-2 序列化） */
export type KBEmbeddingType = "qwen" | "simple" | "hrr";

/** 文档元数据（对应 kb_documents 行） */
export interface KBDocument {
  /** UUID */
  id: string;
  /** 所属 Agent；NULL = 非 Agent 隔离 */
  agentId: string | null;
  /** 所属用户；NULL = 全局库 */
  userId: string | null;
  /** 原始文件名 */
  filename: string;
  /** MIME 类型（可选） */
  mime: string | null;
  /** 文件字节数 */
  size: number;
  /** 内容 SHA-256 hex（用于同 user 去重） */
  contentHash: string;
  /** 原始文件落盘路径（可选） */
  sourcePath: string | null;
  /** 处理状态 */
  status: KBDocStatus;
  /** 失败原因（status=failed 时填充） */
  error: string | null;
  /** 自定义元数据（JSON） */
  metadata: Record<string, unknown>;
  /** 创建时间（epoch ms） */
  createdAt: number;
  /** 更新时间（epoch ms） */
  updatedAt: number;
}

/** 分块 + 向量（对应 kb_chunks 行） */
export interface KBChunk {
  /** UUID */
  id: string;
  /** 所属文档 ID */
  docId: string;
  /** 分块索引（0-based，doc 内有序） */
  chunkIndex: number;
  /** 分块文本内容 */
  content: string;
  /** 向量（number[]；undefined 表示尚未向量化） */
  embedding?: number[];
  /** 向量类型（决定 BLOB 存储精度） */
  embeddingType: KBEmbeddingType;
  /** 预估 token 数 */
  tokenCount: number;
  /** 自定义元数据（JSON） */
  metadata: Record<string, unknown>;
  /** 创建时间（epoch ms） */
  createdAt: number;
}

/** 检索结果（chunk + 相关性分数 + 所属文档关键元数据） */
export interface RetrievedChunk {
  /** 分块 */
  chunk: KBChunk;
  /** 综合相关性分数（0~1，越大越相关） */
  score: number;
  /** 向量相似度分量（0~1；可选，仅混合检索返回） */
  vectorScore?: number;
  /** BM25 分量（原始 rank 或归一化后值；可选） */
  bm25Score?: number;
  /** 所属文档的关键元数据（避免调用方再查一次） */
  document: Pick<KBDocument, "id" | "filename" | "agentId" | "userId">;
}

/** 查询过滤器（隔离过滤 + 状态过滤） */
export interface KBDocumentFilter {
  agentId?: string | null;
  userId?: string | null;
  status?: KBDocStatus;
  /** 是否严格匹配 NULL（默认 false：undefined 表示不限） */
  strictNullMatch?: boolean;
}

/** 分页选项 */
export interface KBPageOptions {
  limit?: number;
  offset?: number;
}
