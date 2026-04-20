"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import { Shield, Key, Plus, Trash2, Eye, EyeOff, FileText, RefreshCw } from "lucide-react";

interface Credential {
  name: string;
  createdAt: string;
}

interface AuditEntry {
  id: string;
  action: string;
  resource: string;
  result: string;
  timestamp: string;
  details?: string;
}

interface SecurityPolicy {
  defaultSandbox: string;
  defaultPermission: string;
  maxConcurrentSandboxes: number;
}

export default function SecurityPage() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [policies, setPolicies] = useState<SecurityPolicy[]>([]);
  const [selectedPolicyIdx, setSelectedPolicyIdx] = useState(0);
  const policy = policies[selectedPolicyIdx] ?? null;
  const [loading, setLoading] = useState(true);
  const [showAddCred, setShowAddCred] = useState(false);
  const [credForm, setCredForm] = useState({ name: "", value: "" });
  const [showValues, setShowValues] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<"credentials" | "audit" | "policy">("credentials");

  const fetchData = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch<{ credentials: Credential[] }>("/api/security/credentials").catch(() => ({ credentials: [] })),
      apiFetch<{ entries: AuditEntry[] }>("/api/security/audit").catch(() => ({ entries: [] })),
      apiFetch<SecurityPolicy[]>("/api/security/policies").catch(() => []),
    ]).then(([c, a, p]) => {
      setCredentials(c.credentials ?? []);
      setAuditLog(a.entries ?? []);
      if (p && p.length > 0) setPolicies(p);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleAddCred = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch("/api/security/credentials", {
      method: "POST",
      body: JSON.stringify(credForm),
    });
    setShowAddCred(false);
    setCredForm({ name: "", value: "" });
    fetchData();
  };

  const handleDeleteCred = async (name: string) => {
    if (!confirm(`确定删除凭证 "${name}"？`)) return;
    await apiFetch(`/api/security/credentials/${name}`, { method: "DELETE" });
    fetchData();
  };

  const tabs = [
    { id: "credentials" as const, label: "凭证管理", icon: Key },
    { id: "audit" as const, label: "审计日志", icon: FileText },
    { id: "policy" as const, label: "安全策略", icon: Shield },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">安全管理</h1>
        <p className="mt-1 text-zinc-400">凭证保管、安全策略和审计日志</p>
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

      {loading ? (
        <div className="py-12 text-center text-zinc-500">加载中...</div>
      ) : tab === "credentials" ? (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button onClick={() => setShowAddCred(true)} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700">
              <Plus className="h-4 w-4" /> 添加凭证
            </button>
          </div>
          {credentials.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-700 p-8 text-center">
              <Key className="mx-auto h-10 w-10 text-zinc-600" />
              <p className="mt-3 text-zinc-400">暂无存储的凭证</p>
            </div>
          ) : (
            <div className="space-y-2">
              {credentials.map((cred) => (
                <div key={cred.name} className="group flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <div className="flex items-center gap-4">
                    <Key className="h-5 w-5 text-amber-400" />
                    <div>
                      <h4 className="font-medium text-white">{cred.name}</h4>
                      <span className="text-xs text-zinc-500">{new Date(cred.createdAt).toLocaleString("zh-CN")}</span>
                    </div>
                  </div>
                  <button onClick={() => handleDeleteCred(cred.name)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-red-400 opacity-0 group-hover:opacity-100">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {showAddCred && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowAddCred(false)}>
              <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-6" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-bold text-white mb-4">添加凭证</h3>
                <form onSubmit={handleAddCred} className="space-y-4">
                  <div>
                    <label className="block text-sm text-zinc-400 mb-1">名称</label>
                    <input value={credForm.name} onChange={(e) => setCredForm({ ...credForm, name: e.target.value })} placeholder="例: OPENAI_API_KEY" className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white font-mono focus:border-blue-500 focus:outline-none" required />
                  </div>
                  <div>
                    <label className="block text-sm text-zinc-400 mb-1">值</label>
                    <input type="password" value={credForm.value} onChange={(e) => setCredForm({ ...credForm, value: e.target.value })} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none" required />
                  </div>
                  <div className="flex justify-end gap-3">
                    <button type="button" onClick={() => setShowAddCred(false)} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-900">取消</button>
                    <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">保存</button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      ) : tab === "audit" ? (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button onClick={fetchData} className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800">
              <RefreshCw className="h-4 w-4" /> 刷新
            </button>
          </div>
          {auditLog.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-700 p-8 text-center">
              <FileText className="mx-auto h-10 w-10 text-zinc-600" />
              <p className="mt-3 text-zinc-400">暂无审计日志</p>
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-900/50">
                    <th className="px-4 py-3 text-left text-zinc-400 font-medium">时间</th>
                    <th className="px-4 py-3 text-left text-zinc-400 font-medium">操作</th>
                    <th className="px-4 py-3 text-left text-zinc-400 font-medium">资源</th>
                    <th className="px-4 py-3 text-left text-zinc-400 font-medium">结果</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLog.map((entry) => (
                    <tr key={entry.id} className="border-b border-zinc-800/50 hover:bg-zinc-900/30">
                      <td className="px-4 py-3 text-zinc-400">{new Date(entry.timestamp).toLocaleString("zh-CN")}</td>
                      <td className="px-4 py-3 text-white">{entry.action}</td>
                      <td className="px-4 py-3 text-zinc-300 font-mono text-xs">{entry.resource}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded px-1.5 py-0.5 text-xs ${entry.result === "allowed" ? "bg-green-600/10 text-green-400" : "bg-red-600/10 text-red-400"}`}>
                          {entry.result}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Policy selector when multiple policies exist */}
          {policies.length > 1 && (
            <div className="flex items-center gap-3">
              <label className="text-sm text-zinc-400">选择策略:</label>
              <select
                value={selectedPolicyIdx}
                onChange={(e) => setSelectedPolicyIdx(Number(e.target.value))}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
              >
                {policies.map((p, i) => (
                  <option key={p.defaultSandbox + i} value={i}>{p.defaultSandbox} — {p.defaultPermission}</option>
                ))}
              </select>
            </div>
          )}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
            <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
              <Shield className="h-5 w-5 text-blue-400" /> 沙箱配置
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm text-zinc-400 mb-1">沙箱级别</label>
                <select className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none" value={policy?.defaultSandbox ?? "process"} disabled>
                  <option value="none">无沙箱</option>
                  <option value="process">进程隔离</option>
                  <option value="docker">Docker 容器</option>
                  <option value="ssh">SSH 远程</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">最大并发沙箱</label>
                <input type="number" className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none" value={policy?.maxConcurrentSandboxes ?? 5} disabled />
              </div>
            </div>
          </div>
          <p className="text-sm text-zinc-500">安全策略修改需通过 API 或配置文件设置</p>
        </div>
      )}
    </div>
  );
}
