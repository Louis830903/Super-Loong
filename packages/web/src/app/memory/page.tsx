"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import { Brain, Search, Trash2, Clock } from "lucide-react";

interface MemoryEntry {
  id: string;
  content: string;
  type: string;
  agentId: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export default function MemoryPage() {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<{ total: number; byType: Record<string, number> }>({ total: 0, byType: {} });

  const fetchMemories = useCallback(() => {
    setLoading(true);
    apiFetch<{ memories: MemoryEntry[] }>("/api/memory")
      .then((data) => setMemories(data.memories ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const fetchStats = useCallback(() => {
    apiFetch<{ total: number; byType: Record<string, number> }>("/api/memory/stats")
      .then((data) => setStats({ total: data?.total ?? 0, byType: data?.byType ?? {} }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchMemories();
    fetchStats();
  }, [fetchMemories, fetchStats]);

  const handleSearch = async () => {
    if (!search.trim()) {
      fetchMemories();
      return;
    }
    setLoading(true);
    apiFetch<{ results: Array<{ entry: MemoryEntry; score: number }> }>(
      `/api/memory/search?query=${encodeURIComponent(search)}`
    )
      .then((data) => setMemories((data.results ?? []).map((r) => r.entry)))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const handleDelete = async (id: string) => {
    await apiFetch(`/api/memory/${id}`, { method: "DELETE" });
    fetchMemories();
    fetchStats();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">记忆管理</h1>
          <p className="mt-1 text-zinc-400">查看和管理 Agent 的持久记忆数据</p>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="搜索记忆（回车搜索）..."
          className="w-full rounded-xl border border-zinc-800 bg-zinc-900 py-3 pl-10 pr-4 text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
        />
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-sm text-zinc-400">总记忆数</p>
          <p className="text-2xl font-bold text-white">{stats.total}</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-sm text-zinc-400">记忆分类</p>
          <p className="text-2xl font-bold text-white">
            {Object.keys(stats.byType ?? {}).length}
          </p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-sm text-zinc-400">存储后端</p>
          <p className="text-2xl font-bold text-emerald-400">SQLite + HRR</p>
        </div>
      </div>

      {/* Memory List */}
      {loading ? (
        <div className="py-12 text-center text-zinc-500">加载中...</div>
      ) : memories.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 p-12 text-center">
          <Brain className="mx-auto h-12 w-12 text-zinc-600" />
          <p className="mt-4 text-zinc-400">暂无记忆数据</p>
          <p className="mt-2 text-sm text-zinc-600">
            Agent 对话时会通过 remember/recall 工具自动存储记忆
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {memories.map((mem) => (
              <div
                key={mem.id}
                className="group rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <p className="text-sm text-white">{mem.content}</p>
                    <div className="mt-2 flex items-center gap-3">
                      <span className="rounded bg-purple-600/10 px-2 py-0.5 text-xs text-purple-400">
                        {mem.type}
                      </span>
                      <span className="flex items-center gap-1 text-xs text-zinc-500">
                        <Clock className="h-3 w-3" />
                        {new Date(mem.createdAt).toLocaleString("zh-CN")}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(mem.id)}
                    className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-red-400 opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
