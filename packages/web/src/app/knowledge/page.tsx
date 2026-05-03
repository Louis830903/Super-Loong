"use client";

/**
 * 知识库页面（知识库 Spec §8.2 / T8）。
 *
 * 四大区域：
 *   1. 统计面板：文档总数 / 已索引 / 失败 / 总字节 / 总分块
 *   2. 上传区：文件选择 → base64 编码 → POST /api/kb/documents
 *   3. 搜索区：query + topK → POST /api/kb/search → 片段列表
 *   4. 文档列表：filename + status 徽章 + 字节 + 时间 + 删除
 *
 * 隔离策略：v1 阶段前端仅显示当前用户（或全局）的文档，
 * agentId/userId 传 undefined（后端返回全部）。后续可扩展 Agent 选择器。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookMarked,
  Upload,
  Search,
  Trash2,
  FileText,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  Hash,
} from "lucide-react";

import { apiFetch, showToast } from "@/lib/utils";
import { GuidedEmptyState } from "@/components/ui/guided-empty-state";
import { FeatureBanner } from "@/components/ui/feature-banner";

// ─── API 类型（与后端对齐，前端拷贝一份避免跨包耦合）────

type KBDocStatus = "pending" | "parsing" | "chunking" | "embedding" | "indexed" | "failed";

interface KBDocument {
  id: string;
  agentId: string | null;
  userId: string | null;
  filename: string;
  mime: string | null;
  size: number;
  contentHash: string;
  sourcePath: string | null;
  status: KBDocStatus;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

interface KBChunkHit {
  chunk: {
    id: string;
    docId: string;
    chunkIndex: number;
    content: string;
    tokenCount: number;
  };
  score: number;
  vectorScore?: number;
  bm25Score?: number;
  document: {
    id: string;
    filename: string;
  };
}

interface Stats {
  documentCount: number;
  indexedCount: number;
  failedCount: number;
  totalBytes: number;
  totalChunks: number;
}

// ─── 辅助：读取 File → base64 ──────────────────────────

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  // 浏览器环境没有 Buffer，走手工分块避免 call stack 爆栈
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ─── 辅助：字节格式化 ────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ─── Status 徽章 ────────────────────────────────────

function StatusBadge({ status }: { status: KBDocStatus }) {
  const map: Record<KBDocStatus, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
    pending: { label: "待处理", cls: "bg-zinc-700/40 text-zinc-300", Icon: Clock },
    parsing: { label: "解析中", cls: "bg-blue-500/20 text-blue-300", Icon: Loader2 },
    chunking: { label: "分块中", cls: "bg-blue-500/20 text-blue-300", Icon: Loader2 },
    embedding: { label: "向量化", cls: "bg-blue-500/20 text-blue-300", Icon: Loader2 },
    indexed: { label: "已索引", cls: "bg-emerald-500/20 text-emerald-300", Icon: CheckCircle2 },
    failed: { label: "失败", cls: "bg-red-500/20 text-red-300", Icon: AlertCircle },
  };
  const { label, cls, Icon } = map[status];
  const animate = status === "parsing" || status === "chunking" || status === "embedding";
  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${cls}`}>
      <Icon size={12} className={animate ? "animate-spin" : ""} />
      {label}
    </span>
  );
}

// ─── 主组件 ─────────────────────────────────────────

export default function KnowledgeBasePage() {
  const [docs, setDocs] = useState<KBDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchTopK, setSearchTopK] = useState(5);
  const [hits, setHits] = useState<KBChunkHit[]>([]);
  const [searching, setSearching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── 拉列表 / 统计 ────────────────────────────

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [list, st] = await Promise.all([
        apiFetch<{ documents: KBDocument[]; total: number }>(
          "/api/kb/documents?limit=100",
        ),
        apiFetch<Stats>("/api/kb/stats"),
      ]);
      setDocs(list.documents ?? []);
      setTotal(list.total ?? 0);
      setStats(st);
    } catch {
      /* apiFetch 已 toast */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // ── 上传 ────────────────────────────────────

  const handleUpload = async (file: File) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      showToast("文件过大（最大 20MB）", "error");
      return;
    }
    setUploading(true);
    try {
      const data = await fileToBase64(file);
      const resp = await apiFetch<{
        document: KBDocument;
        duplicated: boolean;
        skipped: boolean;
        chunkCount: number;
      }>("/api/kb/documents", {
        method: "POST",
        body: JSON.stringify({
          filename: file.name,
          data,
          mime: file.type || undefined,
        }),
      });
      if (resp.duplicated) {
        showToast(`已存在同内容文档（跳过，共 ${resp.chunkCount} 块）`, "info");
      } else {
        showToast(
          `上传成功：${resp.document.filename}（${resp.chunkCount} 块）`,
          "success",
        );
      }
      await fetchAll();
    } catch {
      /* apiFetch 已 toast */
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // ── 删除 ────────────────────────────────────

  const handleDelete = async (doc: KBDocument) => {
    if (!confirm(`确认删除「${doc.filename}」？此操作将连同所有分块一起删除。`)) {
      return;
    }
    try {
      await apiFetch<{ deleted: boolean }>(`/api/kb/documents/${doc.id}`, {
        method: "DELETE",
      });
      showToast("已删除", "success");
      await fetchAll();
    } catch {
      /* apiFetch 已 toast */
    }
  };

  // ── 搜索 ────────────────────────────────────

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      showToast("请输入查询内容", "info");
      return;
    }
    setSearching(true);
    try {
      const resp = await apiFetch<{ hits: KBChunkHit[]; count: number }>(
        "/api/kb/search",
        {
          method: "POST",
          body: JSON.stringify({
            query: searchQuery.trim(),
            topK: searchTopK,
          }),
        },
      );
      setHits(resp.hits ?? []);
      if ((resp.count ?? 0) === 0) {
        showToast("未命中任何片段", "info");
      }
    } catch {
      /* apiFetch 已 toast */
    } finally {
      setSearching(false);
    }
  };

  // ─── 渲染 ─────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BookMarked className="text-emerald-400" size={28} />
          <div>
            <h1 className="text-2xl font-bold">知识库</h1>
            <p className="text-sm text-zinc-400">
              上传文档后 Agent 会自动引用相关内容回答问题
            </p>
          </div>
        </div>
        <button
          onClick={fetchAll}
          className="flex items-center gap-2 rounded-lg bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700"
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          刷新
        </button>
      </div>

      <FeatureBanner
        pageId="knowledge"
        icon={BookMarked}
        title="知识库"
        description="上传文档后，系统会自动解析、分块、向量化。Agent 在回答问题时自动检索知识库中最相关的内容引用到回答中，就像给 AI 装上了「资料库」。"
        useCases={[
          "合同分析：上传合同文档，向 Agent 提问条款细节",
          "论文研读：上传多篇论文 PDF，跨文档对比和总结",
          "项目文档问答：将项目所有文档上传，随时提问技术细节",
        ]}
        tips={[
          "支持 md / txt / html / pdf / docx / xlsx / pptx，单文件最大 20MB",
          "重复上传相同内容的文档会自动跳过，不会浪费存储空间",
        ]}
      />

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatCard label="文档总数" value={stats?.documentCount ?? 0} />
        <StatCard
          label="已索引"
          value={stats?.indexedCount ?? 0}
          accent="text-emerald-400"
        />
        <StatCard
          label="失败"
          value={stats?.failedCount ?? 0}
          accent={stats && stats.failedCount > 0 ? "text-red-400" : undefined}
        />
        <StatCard label="总分块" value={stats?.totalChunks ?? 0} />
        <StatCard
          label="总字节"
          value={stats ? formatBytes(stats.totalBytes) : "—"}
        />
      </div>

      {/* 上传区 */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Upload size={18} className="text-blue-400" />
          <h2 className="text-lg font-semibold">上传文档</h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".md,.txt,.html,.htm,.pdf,.docx,.xlsx,.xls,.pptx"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUpload(f);
            }}
            className="block text-sm file:mr-3 file:rounded file:border-0 file:bg-emerald-600 file:px-3 file:py-1.5 file:text-white hover:file:bg-emerald-500 disabled:opacity-50"
          />
          {uploading && (
            <span className="inline-flex items-center gap-2 text-sm text-blue-400">
              <Loader2 size={14} className="animate-spin" />
              上传中...
            </span>
          )}
          <span className="text-xs text-zinc-500">
            支持 md / txt / html / pdf / docx / xlsx / pptx，最大 20MB
          </span>
        </div>
      </section>

      {/* 搜索区 */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Search size={18} className="text-purple-400" />
          <h2 className="text-lg font-semibold">混合检索</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            placeholder="输入查询内容（支持语义 + 关键词混合检索）"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSearch();
            }}
            className="flex-1 min-w-[300px] rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
          />
          <select
            value={searchTopK}
            onChange={(e) => setSearchTopK(parseInt(e.target.value, 10))}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
          >
            <option value={3}>Top 3</option>
            <option value={5}>Top 5</option>
            <option value={10}>Top 10</option>
          </select>
          <button
            onClick={handleSearch}
            disabled={searching}
            className="flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50"
          >
            {searching ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Search size={14} />
            )}
            搜索
          </button>
        </div>

        {hits.length > 0 && (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-zinc-400">共命中 {hits.length} 个片段</p>
            {hits.map((h) => (
              <div
                key={h.chunk.id}
                className="rounded border border-zinc-800 bg-zinc-900/60 p-3"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm">
                    <FileText size={14} className="text-blue-400" />
                    <span className="font-medium">{h.document.filename}</span>
                    <span className="text-xs text-zinc-500">
                      #{h.chunk.chunkIndex}
                    </span>
                  </div>
                  <span className="rounded bg-purple-500/20 px-2 py-0.5 text-xs text-purple-300">
                    score {h.score.toFixed(3)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
                  {h.chunk.content.length > 400
                    ? h.chunk.content.slice(0, 400) + "..."
                    : h.chunk.content}
                </p>
                <div className="mt-2 flex gap-3 text-xs text-zinc-500">
                  {h.vectorScore !== undefined && (
                    <span>向量 {h.vectorScore.toFixed(3)}</span>
                  )}
                  {h.bm25Score !== undefined && (
                    <span>BM25 {h.bm25Score.toFixed(3)}</span>
                  )}
                  <span className="inline-flex items-center gap-1">
                    <Hash size={10} />
                    {h.chunk.tokenCount} tokens
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 文档列表 */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">文档列表（{total}）</h2>
        </div>
        {loading ? (
          <p className="py-8 text-center text-sm text-zinc-500">加载中...</p>
        ) : docs.length === 0 ? (
          <GuidedEmptyState
            icon={BookMarked}
            title="还没有上传文档"
            description="知识库让 Agent 能够引用你的文档来回答问题。上传文档后，系统会自动分块、向量化，Agent 在对话中检索相关内容进行回答。"
            steps={[
              "上传文档：支持 md / txt / html / pdf / docx / xlsx / pptx",
              "自动处理：系统会自动解析、分块并生成向量索引",
              "自由提问：在对话中 Agent 会自动检索知识库中的相关内容",
            ]}
            action={{ label: "开始上传", onClick: () => fileRef.current?.click() }}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-zinc-500">
                <tr className="border-b border-zinc-800">
                  <th className="px-3 py-2">文件名</th>
                  <th className="px-3 py-2">状态</th>
                  <th className="px-3 py-2">大小</th>
                  <th className="px-3 py-2">Agent / User</th>
                  <th className="px-3 py-2">创建时间</th>
                  <th className="px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr
                    key={d.id}
                    className="border-b border-zinc-800/60 hover:bg-zinc-900/60"
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <FileText size={14} className="text-blue-400" />
                        <span className="font-medium">{d.filename}</span>
                      </div>
                      {d.status === "failed" && d.error && (
                        <p className="mt-1 text-xs text-red-400">
                          {d.error}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={d.status} />
                    </td>
                    <td className="px-3 py-2 text-zinc-400">
                      {formatBytes(d.size)}
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-500">
                      {d.agentId ? `agent:${d.agentId.slice(0, 8)}` : "-"}
                      {" / "}
                      {d.userId ? `user:${d.userId.slice(0, 8)}` : "-"}
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-500">
                      {formatTime(d.createdAt)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => handleDelete(d)}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
                      >
                        <Trash2 size={12} />
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ─── 统计卡片子组件 ────────────────────────────

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${accent ?? "text-white"}`}>
        {value}
      </p>
    </div>
  );
}
