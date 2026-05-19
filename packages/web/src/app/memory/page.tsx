"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import { useAgents } from "@/hooks/useAgents";
import {
  Brain, Search, Trash2, Clock, Plus, Pencil, Save,
  AlertTriangle, RefreshCw, X, BookOpen, Zap,
} from "lucide-react";
import { GuidedEmptyState } from "@/components/ui/guided-empty-state";

import type { MemoryEntry } from "@/types/api-types";

interface CoreBlock {
  label: string;
  value: string;
  limit?: number;
}

interface ContradictionPair {
  a: MemoryEntry;
  b: MemoryEntry;
  reason: string;
}

/** ISSUE-8: 信任分三色阈值常量化，避免前端硬编码 */
const TRUST_THRESHOLDS = { HIGH: 0.7, LOW: 0.4 } as const;

export default function MemoryPage() {
  const { agents } = useAgents();
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [search, setSearch] = useState("");
  const [searchMode, setSearchMode] = useState<"semantic" | "fts">("semantic");
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<{ total: number; byType: Record<string, number> }>({ total: 0, byType: {} });
  const [tab, setTab] = useState<"list" | "core" | "contradictions">("list");

  // 创建/编辑状态
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ content: "", type: "observation", agentId: "" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  // 核心记忆状态
  const [coreBlocks, setCoreBlocks] = useState<CoreBlock[]>([]);
  const [coreAgentId, setCoreAgentId] = useState("");
  const [editingCore, setEditingCore] = useState<string | null>(null);
  const [coreEditValue, setCoreEditValue] = useState("");

  // 矛盾检测
  const [contradictions, setContradictions] = useState<ContradictionPair[]>([]);
  const [contradLoading, setContradLoading] = useState(false);

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

  // 初始化 agent 选择
  useEffect(() => {
    if (agents.length > 0 && !coreAgentId) {
      setCoreAgentId(agents[0].id);
      setCreateForm((f) => ({ ...f, agentId: f.agentId || agents[0].id }));
    }
  }, [agents, coreAgentId]);

  const handleSearch = async () => {
    if (!search.trim()) { fetchMemories(); return; }
    setLoading(true);
    try {
      if (searchMode === "fts") {
        const data = await apiFetch<{ results: MemoryEntry[] }>(
          `/api/memory/fts?q=${encodeURIComponent(search)}`
        );
        setMemories(data.results ?? []);
      } else {
        const data = await apiFetch<{ results: Array<{ entry: MemoryEntry; score: number }> }>(
          `/api/memory/search?query=${encodeURIComponent(search)}`
        );
        setMemories((data.results ?? []).map((r) => ({ ...r.entry, _score: r.score })));
      }
    } catch (err) {
      // [v3 Task 5] 记忆检索失败不中断 UI，保持上次结果
      console.debug("[memory] search failed", err);
    }
    setLoading(false);
  };

  const handleCreate = async () => {
    if (!createForm.content.trim()) return;
    try {
      await apiFetch("/api/memory", {
        method: "POST",
        body: JSON.stringify(createForm),
      });
      setShowCreate(false);
      setCreateForm({ content: "", type: "observation", agentId: createForm.agentId });
      fetchMemories();
      fetchStats();
    } catch { /* apiFetch 内部已 showToast */ }
  };

  const handleEdit = async (id: string) => {
    if (!editContent.trim()) return;
    try {
      await apiFetch(`/api/memory/${id}`, {
        method: "PUT",
        body: JSON.stringify({ content: editContent }),
      });
      setEditingId(null);
      fetchMemories();
    } catch { /* apiFetch 内部已 showToast */ }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除该记忆？")) return;
    try {
      await apiFetch(`/api/memory/${id}`, { method: "DELETE" });
      fetchMemories();
      fetchStats();
    } catch { /* apiFetch 内部已 showToast */ }
  };

  // 核心记忆
  const fetchCoreBlocks = useCallback(async () => {
    if (!coreAgentId) return;
    try {
      const data = await apiFetch<{ blocks: CoreBlock[] }>(`/api/memory/core/${coreAgentId}`);
      setCoreBlocks(data.blocks ?? []);
    } catch { setCoreBlocks([]); }
  }, [coreAgentId]);

  useEffect(() => {
    if (tab === "core" && coreAgentId) fetchCoreBlocks();
  }, [tab, coreAgentId, fetchCoreBlocks]);

  const handleSaveCore = async (label: string) => {
    try {
      await apiFetch(`/api/memory/core/${coreAgentId}/${label}`, {
        method: "PUT",
        body: JSON.stringify({ value: coreEditValue }),
      });
      setEditingCore(null);
      fetchCoreBlocks();
    } catch { /* apiFetch 内部已 showToast */ }
  };

  // 矛盾检测
  const runContradictionCheck = async () => {
    setContradLoading(true);
    try {
      const data = await apiFetch<{ contradictions: ContradictionPair[] }>("/api/memory/contradictions");
      setContradictions(data.contradictions ?? []);
    } catch { setContradictions([]); }
    setContradLoading(false);
  };

  useEffect(() => {
    if (tab === "contradictions") runContradictionCheck();
  }, [tab]);

  const tabs = [
    { id: "list" as const, label: "记忆列表", icon: Brain },
    { id: "core" as const, label: "核心记忆", icon: BookOpen },
    { id: "contradictions" as const, label: "矛盾检测", icon: AlertTriangle },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">记忆管理</h1>
          <p className="mt-1 text-zinc-400">查看和管理 Agent 的持久记忆数据</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          <Plus className="h-4 w-4" /> 创建记忆
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg bg-zinc-900 p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"
            }`}
          >
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-sm text-zinc-400">总记忆数</p>
          <p className="text-2xl font-bold text-white">{stats.total}</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-sm text-zinc-400">记忆分类</p>
          <p className="text-2xl font-bold text-white">{Object.keys(stats.byType ?? {}).length}</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-sm text-zinc-400">存储后端</p>
          <p className="text-2xl font-bold text-emerald-400">SQLite + HRR</p>
        </div>
      </div>

      {tab === "list" ? (
        <>
          {/* Search with mode toggle */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                placeholder="搜索记忆（回车搜索）..."
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900 py-3 pl-10 pr-4 text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <select
              value={searchMode}
              onChange={(e) => setSearchMode(e.target.value as "semantic" | "fts")}
              className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
            >
              <option value="semantic">语义搜索</option>
              <option value="fts">全文搜索</option>
            </select>
          </div>

          {/* Memory List */}
          {loading ? (
            <div className="py-12 text-center text-zinc-500">加载中...</div>
          ) : memories.length === 0 ? (
            <GuidedEmptyState
              icon={Brain}
              title="还没有记忆数据"
              description="Agent 的记忆系统可以持久化保存对话中的重要信息，让 Agent 在后续对话中回忆起之前的上下文，实现跨会话的智能交互。"
              steps={[
                "创建记忆：手动添加关键信息，或让 Agent 在对话中自动记录",
                "语义搜索：用自然语言搜索记忆，Agent 会自动匹配相关内容",
                "管理核心记忆：为 Agent 设定必须记住的关键信息块",
              ]}
              action={{ label: "创建记忆", onClick: () => setShowCreate(true) }}
            />
          ) : (
            <div className="space-y-3">
              {memories.map((mem) => (
                <div key={mem.id} className="group rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      {editingId === mem.id ? (
                        <div className="flex gap-2">
                          <textarea
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:outline-none"
                            rows={3}
                          />
                          <div className="flex flex-col gap-1">
                            <button onClick={() => handleEdit(mem.id)} className="rounded p-1.5 text-emerald-400 hover:bg-emerald-900/30">
                              <Save className="h-4 w-4" />
                            </button>
                            <button onClick={() => setEditingId(null)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800">
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm text-white">{mem.content}</p>
                      )}
                      <div className="mt-2 flex items-center gap-3 flex-wrap">
                        <span className="rounded bg-purple-600/10 px-2 py-0.5 text-xs text-purple-400">{mem.type}</span>
                        {/* 信任分 — 列表和搜索都展示 */}
                        {mem.trustScore != null && (
                          <span className={`rounded px-2 py-0.5 text-xs ${
                            mem.trustScore >= TRUST_THRESHOLDS.HIGH ? "bg-emerald-600/10 text-emerald-400"
                            : mem.trustScore >= TRUST_THRESHOLDS.LOW ? "bg-amber-600/10 text-amber-400"
                            : "bg-red-600/10 text-red-400"
                          }`}>
                            信任 {(mem.trustScore * 100).toFixed(0)}%
                          </span>
                        )}
                        {/* 搜索相关性分数 — 仅语义搜索结果展示 */}
                        {mem._score != null && (
                          <span className="rounded bg-blue-600/10 px-2 py-0.5 text-xs text-blue-400">
                            匹配 {(mem._score * 100).toFixed(1)}%
                          </span>
                        )}
                        <span className="flex items-center gap-1 text-xs text-zinc-500">
                          <Clock className="h-3 w-3" />
                          {new Date(mem.createdAt).toLocaleString("zh-CN")}
                        </span>
                      </div>
                    </div>
                    {editingId !== mem.id && (
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100">
                        <button onClick={() => { setEditingId(mem.id); setEditContent(mem.content); }} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white">
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button onClick={() => handleDelete(mem.id)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-red-400">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : tab === "core" ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <label className="text-sm text-zinc-400">Agent:</label>
            <select value={coreAgentId} onChange={(e) => setCoreAgentId(e.target.value)} className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white focus:outline-none">
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <button onClick={fetchCoreBlocks} className="flex items-center gap-1 text-sm text-zinc-400 hover:text-white">
              <RefreshCw className="h-4 w-4" /> 刷新
            </button>
          </div>
          {coreBlocks.length === 0 ? (
            <GuidedEmptyState
              icon={BookOpen}
              title="还没有核心记忆块"
              description="核心记忆块是 Agent 必须记住的关键信息，类似于 Agent 的「长期信念」。Agent 在每次对话中都会优先参考这些信息。"
              steps={[
                "选择一个 Agent，查看其当前的核心记忆块",
                "编辑核心记忆块，设定 Agent 必须遵循的规则或记住的事实",
                "例如：「用户偏好用中文回复」、「项目使用 React + TypeScript 技术栈」",
              ]}
            />
          ) : (
            <div className="space-y-3">
              {coreBlocks.map((block) => (
                <div key={block.label} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-medium text-white">{block.label}</h4>
                    <button onClick={() => { setEditingCore(block.label); setCoreEditValue(block.value); }} className="text-xs text-zinc-400 hover:text-white">
                      <Pencil className="h-4 w-4" />
                    </button>
                  </div>
                  {editingCore === block.label ? (
                    <div className="space-y-2">
                      <textarea value={coreEditValue} onChange={(e) => setCoreEditValue(e.target.value)} className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:outline-none" rows={4} />
                      <div className="flex gap-2">
                        <button onClick={() => handleSaveCore(block.label)} className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"><Save className="h-3.5 w-3.5" /> 保存</button>
                        <button onClick={() => setEditingCore(null)} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800">取消</button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-zinc-300 whitespace-pre-wrap">{block.value || "(空)"}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button onClick={runContradictionCheck} disabled={contradLoading} className="flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50">
              {contradLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />} 重新检测
            </button>
          </div>
          {contradLoading ? (
            <div className="py-12 text-center text-zinc-500">检测中...</div>
          ) : contradictions.length === 0 ? (
            <GuidedEmptyState
              icon={AlertTriangle}
              title="未检测到矛盾记忆"
              description="矛盾检测会扫描 Agent 的记忆库，找出逻辑上互相冲突的记忆条目（如「用户喜欢咖啡」和「用户不喝咖啡」），帮助你维护记忆的一致性。"
              steps={[
                "点击「重新检测」按钮开始扫描",
                "系统会对比所有记忆条目，标记存在逻辑冲突的记忆对",
                "对有矛盾的记忆进行编辑或删除，保持记忆库的一致性和准确性",
              ]}
              variant="success"
            />
          ) : (
            <div className="space-y-4">
              {contradictions.map((pair, i) => (
                <div key={i} className="rounded-xl border border-amber-800/30 bg-amber-900/10 p-5 space-y-3">
                  <p className="text-sm font-medium text-amber-300">{pair.reason}</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg bg-zinc-900 p-3">
                      <p className="text-xs text-zinc-500 mb-1">记忆 A</p>
                      <p className="text-sm text-white">{pair.a.content}</p>
                    </div>
                    <div className="rounded-lg bg-zinc-900 p-3">
                      <p className="text-xs text-zinc-500 mb-1">记忆 B</p>
                      <p className="text-sm text-white">{pair.b.content}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 创建记忆模态 */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowCreate(false)}>
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-white mb-4">创建记忆</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Agent</label>
                <select value={createForm.agentId} onChange={(e) => setCreateForm({ ...createForm, agentId: e.target.value })} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:outline-none">
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">类型</label>
                <select value={createForm.type} onChange={(e) => setCreateForm({ ...createForm, type: e.target.value })} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:outline-none">
                  <option value="observation">observation</option>
                  <option value="reflection">reflection</option>
                  <option value="fact">fact</option>
                  <option value="preference">preference</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">内容</label>
                <textarea value={createForm.content} onChange={(e) => setCreateForm({ ...createForm, content: e.target.value })} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:outline-none" rows={4} placeholder="输入记忆内容..." required />
              </div>
              <div className="flex justify-end gap-3">
                <button onClick={() => setShowCreate(false)} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-900">取消</button>
                <button onClick={handleCreate} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">创建</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
