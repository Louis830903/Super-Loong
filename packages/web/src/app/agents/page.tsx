"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { useAgents, type AgentInfo } from "@/hooks/useAgents";
import { Bot, Plus, Trash2, Edit2, MoreVertical, Copy } from "lucide-react";

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
  const { agents, loading, refresh: fetchAgents } = useAgents();
  const [showCreate, setShowCreate] = useState(false);
  const [editAgent, setEditAgent] = useState<AgentInfo | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [form, setForm] = useState({
    name: "",
    description: "",
    model: "",
    provider: "",
    systemPrompt: "You are a helpful assistant.",
  });

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
    const payload = {
      name: form.name,
      description: form.description,
      systemPrompt: form.systemPrompt,
      llmProvider: {
        type: form.provider,
        model: form.model,
      },
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
    await apiFetch(`/api/agents/${id}`, { method: "DELETE" });
    fetchAgents();
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
          <p className="mt-1 text-zinc-400">创建和管理你的 AI Agent</p>
        </div>
        <button
          onClick={() => {
            setEditAgent(null);
            // 默认选中第一个已配置 key 的 Provider，回退到列表第一个
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

      {/* Agent List */}
      {loading ? (
        <div className="text-center text-zinc-500 py-12">加载中...</div>
      ) : agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 p-12 text-center">
          <Bot className="mx-auto h-12 w-12 text-zinc-600" />
          <p className="mt-4 text-zinc-400">还没有 Agent，点击上方按钮创建</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="group rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 transition-colors hover:border-zinc-700"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-blue-600/20 p-2">
                    <Bot className="h-5 w-5 text-blue-400" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-white">{agent.name}</h3>
                    <p className="text-xs text-zinc-500">{agent.provider}/{agent.model}</p>
                  </div>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => openEdit(agent)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white">
                    <Edit2 className="h-4 w-4" />
                  </button>
                  <button onClick={() => handleDelete(agent.id)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-red-400">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <p className="mt-3 text-sm text-zinc-400 line-clamp-2">{agent.description || "无描述"}</p>
              <div className="mt-3 flex items-center gap-2">
                <span className="inline-flex items-center rounded-full bg-green-600/10 px-2 py-0.5 text-xs text-green-400">
                  运行中
                </span>
                <span className="text-xs text-zinc-600">
                  ID: {agent.id.slice(0, 8)}
                </span>
              </div>
            </div>
          ))}
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
                <textarea
                  value={form.systemPrompt}
                  onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                  rows={4}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none resize-none"
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
