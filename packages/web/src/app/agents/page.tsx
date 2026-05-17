"use client";

import { useEffect, useState, useCallback, useMemo, useDeferredValue } from "react";
import { apiFetch } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { useAgents, type AgentInfo } from "@/hooks/useAgents";
import { Bot, Plus, Trash2, Edit2, MoreVertical, Copy, Search, GitFork } from "lucide-react";

/**
 * P2-6: 严格 hex 校验的颜色解析
 * - 只允许 #RRGGBB 格式通过
 * - CSS 颜色名通过映射表兜底（兼容旧数据）
 * - 其他格式返回默认灰色
 */
const CSS_COLOR_MAP: Record<string, string> = {
  purple: "#8B5CF6", green: "#10B981", teal: "#14B8A6",
  blue: "#3B82F6", orange: "#F97316", violet: "#8B5CF6",
  red: "#EF4444", pink: "#EC4899", yellow: "#EAB308",
  indigo: "#6366F1", cyan: "#06B6D4",
};
function resolveColor(color: string | null): string {
  if (!color) return "#6B7280";
  // P2-6: 严格校验，只允许标准 hex
  if (/^#[0-9A-Fa-f]{6}$/.test(color)) return color;
  return CSS_COLOR_MAP[color.toLowerCase()] || "#6B7280";
}

// P1-4: 移除硬编码 DEPT_LABELS，改为从 Agent 列表的 departmentLabel 字段动态聚合

/** 模型目录中的单个模型定义 */
interface ModelDef {
  id: string;
  name: string;
  contextWindow?: number;
  supportsReasoning?: boolean;
}

/** 从 /api/models/providers 返回的 Provider 信息 */
interface ProviderInfo {
  id: string;
  name: string;
  keyStatus: "configured" | "missing";
  isEnabled: boolean;
  selectedModel: string;
  models: ModelDef[];
}

export default function AgentsPage() {
  const { agents, loading, error, refresh: fetchAgents } = useAgents();
  const [showCreate, setShowCreate] = useState(false);
  const [editAgent, setEditAgent] = useState<AgentInfo | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  // 搜索与筛选状态
  const [searchTerm, setSearchTerm] = useState("");
  const [activeDept, setActiveDept] = useState("all"); // "all" | "mine" | 具体部门
  const [form, setForm] = useState({
    name: "",
    description: "",
    model: "",
    provider: "",
    systemPrompt: "You are a helpful assistant.",
  });

  /** P1-4: 从 Agent 列表动态聚合部门标签映射 */
  const deptLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const a of agents) {
      if (a.isBuiltin && a.department && a.departmentLabel) {
        labels[a.department] = a.departmentLabel;
      }
    }
    return labels;
  }, [agents]);

  // P3-5: 搜索防抖 — 使用 useDeferredValue 避免每次按键触发重计算
  const deferredSearchTerm = useDeferredValue(searchTerm);

  /** 计算部门 Tab 列表（带数量角标） */
  const deptTabs = useMemo(() => {
    const myCount = agents.filter(a => !a.isBuiltin).length;
    const tabs: Array<{ key: string; label: string; count: number }> = [
      { key: "all", label: "全部", count: agents.length },
      { key: "mine", label: "我的 Agent", count: myCount },
    ];
    // P3-2: 只展示有 Agent 的部门，搜索时更新数量
    const deptCounts = new Map<string, number>();
    const searchFiltered = deferredSearchTerm
      ? agents.filter(a => {
          const q = deferredSearchTerm.toLowerCase();
          return a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q);
        })
      : agents;
    for (const a of searchFiltered) {
      if (a.isBuiltin && a.department) {
        deptCounts.set(a.department, (deptCounts.get(a.department) || 0) + 1);
      }
    }
    for (const [dept, count] of deptCounts) {
      // P1-4: 动态聚合部门标签
      tabs.push({ key: dept, label: deptLabels[dept] || dept, count });
    }
    return tabs;
  }, [agents, deptLabels, deferredSearchTerm]);

  /** 筛选后的 Agent 列表 */
  const filteredAgents = useMemo(() => {
    let list = agents;
    // 部门筛选
    if (activeDept === "mine") list = list.filter(a => !a.isBuiltin);
    else if (activeDept !== "all") list = list.filter(a => a.department === activeDept);
    // P3-5: 搜索过滤使用 deferred 值
    if (deferredSearchTerm) {
      const q = deferredSearchTerm.toLowerCase();
      list = list.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
      );
    }
    return list;
  }, [agents, activeDept, deferredSearchTerm]);

  /** 从后端获取已配置的 Provider 及其模型列表 */
  const fetchProviders = useCallback(async () => {
    try {
      const data = await apiFetch("/api/models/providers") as { providers?: ProviderInfo[] };
      const list: ProviderInfo[] = data.providers ?? [];
      setProviders(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    fetchAgents();
    fetchProviders();
  }, [fetchAgents, fetchProviders]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // 构建嵌套结构，对齐后端 AgentConfig 格式
    // 关键契约（后端 AgentConfigSchema）：llmProvider.type 仅接受
    //   "openai" | "anthropic" | "ollama" | "custom"
    // 国产厂商（moonshot/zhipu/qwen/deepseek/minimax/...）统一走 OpenAI 兼容协议，
    // 用 type="openai" + providerId=<厂商id> 区分，由后端按 providerId 合并 apiKey/baseUrl。
    const OFFICIAL_TYPES = ["openai", "anthropic", "ollama", "custom"] as const;
    const isOfficial = (OFFICIAL_TYPES as readonly string[]).includes(form.provider);
    const llmProvider: Record<string, unknown> = isOfficial
      ? { type: form.provider, model: form.model }
      : { type: "openai", providerId: form.provider, model: form.model };
    const payload = {
      name: form.name,
      description: form.description,
      systemPrompt: form.systemPrompt,
      llmProvider,
    };
    try {
      if (editAgent) {
        await apiFetch(`/api/agents/${editAgent.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch("/api/agents", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      setShowCreate(false);
      setEditAgent(null);
      setForm({ name: "", description: "", model: "", provider: providers[0]?.id || "", systemPrompt: "You are a helpful assistant." });
      fetchAgents();
    } catch {}
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定要删除这个 Agent 吗？")) return;
    try {
      await apiFetch(`/api/agents/${id}`, { method: "DELETE" });
    } catch (err: any) {
      alert(err?.message || "删除失败");
    }
    fetchAgents();
  };

  /** Fork 内置 Agent 为自定义副本 */
  const handleFork = async (id: string) => {
    try {
      await apiFetch(`/api/agents/${id}/fork`, { method: "POST" });
      fetchAgents();
    } catch {
      alert("Fork 失败");
    }
  };

  const openEdit = (agent: AgentInfo) => {
    setEditAgent(agent);
    setForm({
      name: agent.name,
      description: agent.description,
      model: agent.model,
      provider: agent.provider,
      systemPrompt: agent.systemPrompt,
    });
    setShowCreate(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Agent 管理</h1>
          <p className="mt-1 text-zinc-400">创建和管理你的 AI Agent，浏览 {agents.filter(a => a.isBuiltin).length} 个内置专家</p>
        </div>
        <button
          onClick={() => {
            setEditAgent(null);
            const defaultProv = providers.find(p => p.keyStatus === "configured") || providers[0];
            const defaultModel = defaultProv?.selectedModel || defaultProv?.models?.[0]?.id || "";
            setForm({ name: "", description: "", model: defaultModel, provider: defaultProv?.id || "", systemPrompt: "You are a helpful assistant." });
            setShowCreate(true);
          }}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" /> 创建 Agent
        </button>
      </div>

      {/* 搜索栏 */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="搜索 Agent 名称或描述..."
          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-10 pr-4 py-2.5 text-sm text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
        />
      </div>

      {/* 部门 Tab 筛选 */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
        {deptTabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveDept(tab.key)}
            className={cn(
              "flex-shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
              activeDept === tab.key
                ? "bg-blue-600 text-white"
                : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
            )}
          >
            {tab.label}
            <span className="ml-1.5 rounded-full bg-black/20 px-1.5 py-0.5 text-xs">{tab.count}</span>
          </button>
        ))}
      </div>

      {/* Agent List */}
      {loading ? (
        <div className="text-center text-zinc-500 py-12">加载中...</div>
      ) : error ? (
        /* P1-1: 展示加载错误，提供重试按钮 */
        <div className="rounded-xl border border-dashed border-red-700/50 p-12 text-center">
          <Bot className="mx-auto h-12 w-12 text-red-500/50" />
          <p className="mt-4 text-red-400">{error}</p>
          <button
            onClick={() => fetchAgents()}
            className="mt-3 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-700"
          >
            重试
          </button>
        </div>
      ) : filteredAgents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 p-12 text-center">
          <Bot className="mx-auto h-12 w-12 text-zinc-600" />
          <p className="mt-4 text-zinc-400">
            {searchTerm ? "没有找到匹配的 Agent" : "还没有 Agent，点击上方按钮创建"}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredAgents.map((agent) => {
            const color = resolveColor(agent.color);
            return (
              <div
                key={agent.id}
                data-testid={`agent-card-${agent.id}`}
                className="group relative rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 transition-colors hover:border-zinc-700"
              >
                {/* 内置标记 */}
                {agent.isBuiltin && (
                  <span
                    className="absolute top-3 right-3 rounded-full px-2 py-0.5 text-xs font-medium text-white"
                    style={{ backgroundColor: color }}
                  >
                    内置
                  </span>
                )}

                <div className="flex items-start gap-3">
                  <div className="rounded-lg p-2" style={{ backgroundColor: `${color}20` }}>
                    <Bot className="h-5 w-5" style={{ color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-white truncate">{agent.name}</h3>
                    <p className="text-xs text-zinc-500">
                      {agent.isBuiltin
                        ? agent.departmentLabel || agent.department
                        : `${agent.provider}/${agent.model}`}
                    </p>
                  </div>
                </div>

                <p className="mt-3 text-sm text-zinc-400 line-clamp-3">{agent.description || "无描述"}</p>

                {/* P2-2: 内置 Agent 展示原始工具标签 */}
                {agent.isBuiltin && agent.originalTools.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {agent.originalTools.slice(0, 3).map(tool => (
                      <span key={tool} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
                        {tool}
                      </span>
                    ))}
                    {agent.originalTools.length > 3 && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-500">
                        +{agent.originalTools.length - 3}
                      </span>
                    )}
                  </div>
                )}

                <div className="mt-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {/* P2-5: 根据 Agent 类型显示不同状态标签 */}
                    {agent.isBuiltin ? (
                      <span className="inline-flex items-center rounded-full bg-blue-600/10 px-2 py-0.5 text-xs text-blue-400">
                        待命
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-green-600/10 px-2 py-0.5 text-xs text-green-400">
                        运行中
                      </span>
                    )}
                    <span className="text-xs text-zinc-600">
                      ID: {agent.id.slice(0, 8)}
                    </span>
                  </div>

                  {/* 操作按钮 */}
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {agent.isBuiltin ? (
                      // 内置 Agent：只能 Fork
                      <button
                        onClick={() => handleFork(agent.id)}
                        className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-blue-400"
                        title="Fork 为自定义副本"
                      >
                        <GitFork className="h-4 w-4" />
                      </button>
                    ) : (
                      // 用户自建 Agent：可编辑、可删除
                      <>
                        <button onClick={() => openEdit(agent)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white" title="编辑">
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button onClick={() => handleDelete(agent.id)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-red-400" title="删除">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create/Edit Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowCreate(false)}>
          <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-white mb-4">
              {editAgent ? "编辑 Agent" : "创建 Agent"}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm text-zinc-400 mb-1">名称</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">描述</label>
                <input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-zinc-400 mb-1">Provider</label>
                  <select
                    value={form.provider}
                    onChange={(e) => {
                      const pid = e.target.value;
                      const prov = providers.find(p => p.id === pid);
                      // 切换 Provider 时自动选中其默认模型
                      const defaultModel = prov?.selectedModel || prov?.models?.[0]?.id || "";
                      setForm({ ...form, provider: pid, model: defaultModel });
                    }}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                  >
                    {providers.length === 0 && <option value="">加载中...</option>}
                    {providers.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name}{p.keyStatus === "missing" ? " (未配置Key)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-zinc-400 mb-1">模型</label>
                  <select
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                  >
                    {(() => {
                      const prov = providers.find(p => p.id === form.provider);
                      const models = prov?.models ?? [];
                      if (models.length === 0) return <option value="">无可用模型</option>;
                      return models.map(m => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ));
                    })()}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">系统提示词</label>
                {/* P3-3: 动态调整 textarea 高度，适配内置 Agent 超长 systemPrompt */}
                <textarea
                  value={form.systemPrompt}
                  onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                  rows={4}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none resize-y min-h-[100px] max-h-[400px]"
                  style={{ height: Math.min(400, Math.max(100, (form.systemPrompt.split("\n").length + 1) * 20)) }}
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowCreate(false)} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-900">
                  取消
                </button>
                <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                  {editAgent ? "保存" : "创建"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
