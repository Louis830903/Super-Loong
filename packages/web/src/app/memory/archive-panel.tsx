"use client";

/**
 * P0-4: 知识库归档面板（独立组件）
 *
 * 从 memory 页以 tab 形式引入，展示 KnowledgeArchiver 归档的知识条目。
 * 独立成组件，避免在 460+ 行的 memory/page.tsx 大文件里插入大段 JSX。
 */

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import { Archive, Search, RefreshCw } from "lucide-react";
import { GuidedEmptyState } from "@/components/ui/guided-empty-state";

interface ArchiveItem {
  id: string;
  content: string;
  score: number;
}

interface ArchiveStats {
  total: number;
  byCategory: Record<string, number>;
}

export function ArchivePanel({ agentId }: { agentId: string }) {
  const [items, setItems] = useState<ArchiveItem[]>([]);
  const [stats, setStats] = useState<ArchiveStats>({ total: 0, byCategory: {} });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const fetchArchive = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    try {
      const q = query.trim() || "*";
      const listData = await apiFetch<{ results: ArchiveItem[] }>(
        `/api/memory/archive/search?q=${encodeURIComponent(q)}&agentId=${encodeURIComponent(agentId)}`,
      ).catch(() => ({ results: [] as ArchiveItem[] }));
      const statsData = await apiFetch<ArchiveStats>(
        `/api/memory/archive/stats?agentId=${encodeURIComponent(agentId)}`,
      ).catch(() => ({ total: 0, byCategory: {} }));
      setItems(listData.results ?? []);
      setStats({ total: statsData?.total ?? 0, byCategory: statsData?.byCategory ?? {} });
    } finally {
      setLoading(false);
    }
  }, [agentId, query]);

  useEffect(() => {
    fetchArchive();
  }, [fetchArchive]);

  const categories = Object.entries(stats.byCategory ?? {});

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-sm text-zinc-400">归档条目总数</p>
          <p className="text-2xl font-bold text-white">{stats.total}</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-sm text-zinc-400">知识分类数</p>
          <p className="text-2xl font-bold text-emerald-400">{categories.length}</p>
        </div>
      </div>

      {categories.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {categories.map(([cat, count]) => (
            <span key={cat} className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-300">
              {cat} · {count}
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchArchive()}
            placeholder="搜索归档知识..."
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-9 pr-3 py-2 text-white focus:outline-none"
          />
        </div>
        <button
          onClick={fetchArchive}
          disabled={loading}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} 搜索
        </button>
      </div>

      {loading ? (
        <div className="py-12 text-center text-zinc-500">加载中...</div>
      ) : items.length === 0 ? (
        <GuidedEmptyState
          icon={Archive}
          title="暂无知识归档"
          description="知识归档会把有价值的对话经 LLM 提炼为结构化知识条目（标题+要点+标签），沉淀为你的个人知识库。"
          steps={[
            "在对话中积累有价值的问答",
            "调用归档接口把会话归档为知识",
            "在此搜索、回顾已沉淀的知识条目",
          ]}
          variant="default"
        />
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <pre className="whitespace-pre-wrap break-words text-sm text-zinc-200 font-sans">{item.content}</pre>
              <p className="mt-2 text-xs text-zinc-600">相关度 {item.score.toFixed(2)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
