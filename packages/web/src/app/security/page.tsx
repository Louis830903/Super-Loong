"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import { Shield, Key, Plus, Trash2, Eye, EyeOff, FileText, RefreshCw, AlertTriangle, CheckCircle2, XCircle, Clock, Pencil, Save, Loader2 } from "lucide-react";

import type { Credential, AuditEntry, SecurityPolicy, ApprovalItem } from "@/types/api-types";

export default function SecurityPage() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [policies, setPolicies] = useState<SecurityPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddCred, setShowAddCred] = useState(false);
  const [credForm, setCredForm] = useState({ name: "", value: "" });
  const [showValues, setShowValues] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<"credentials" | "audit" | "policy" | "approvals">("credentials");

  // ── 待审批状态 ──
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [approvalsLoading, setApprovalsLoading] = useState(false);

  // ── 策略编辑状态 ──
  const [editingPolicyIdx, setEditingPolicyIdx] = useState<number | null>(null);
  const [policyForm, setPolicyForm] = useState<SecurityPolicy>({ id: "", name: "", defaultSandbox: "process", defaultPermission: "ask", maxConcurrentSandboxes: 5 });
  const [showCreatePolicy, setShowCreatePolicy] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);

  const fetchData = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch<{ credentials: Credential[] }>("/api/security/credentials").catch(() => ({ credentials: [] })),
      apiFetch<{ entries: AuditEntry[] }>("/api/security/audit").catch(() => ({ entries: [] })),
      apiFetch<SecurityPolicy[]>("/api/security/policies").catch(() => []),
    ]).then(([c, a, p]) => {
      setCredentials(c.credentials ?? []);
      setAuditLog(a.entries ?? []);
      if (Array.isArray(p)) setPolicies(p);
      else if (p && typeof p === "object") setPolicies([p as unknown as SecurityPolicy]);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── 审批队列 Fetch ──
  const fetchApprovals = useCallback(async () => {
    setApprovalsLoading(true);
    try {
      const data = await apiFetch<{ approvals: ApprovalItem[] }>("/api/security/approvals/pending");
      setApprovals(data.approvals ?? []);
    } catch { /* ignore */ }
    setApprovalsLoading(false);
  }, []);

  // 待审批 Tab 活跃时每 5 秒轮询
  useEffect(() => {
    if (tab === "approvals") {
      fetchApprovals();
      const timer = setInterval(fetchApprovals, 5000);
      return () => clearInterval(timer);
    }
  }, [tab, fetchApprovals]);

  const handleResolve = async (id: string, approved: boolean, scope: string = "once") => {
    try {
      await apiFetch(`/api/security/approvals/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ approved, scope }),
      });
      fetchApprovals();
    } catch { /* apiFetch 内部已 showToast */ }
  };

  // ── 策略 CRUD ──
  // 后端使用 PUT /api/security/policies/:id 进行创建/更新（upsert 语义）
  const handleCreatePolicy = async () => {
    setPolicySaving(true);
    try {
      const id = policyForm.id || `policy-${Date.now()}`;
      const name = policyForm.name || `策略-${id}`;
      await apiFetch(`/api/security/policies/${id}`, {
        method: "PUT",
        body: JSON.stringify({ ...policyForm, name }),
      });
      setShowCreatePolicy(false);
      setPolicyForm({ id: "", name: "", defaultSandbox: "process", defaultPermission: "ask", maxConcurrentSandboxes: 5 });
      fetchData();
    } catch { /* apiFetch 内部已 showToast */ }
    setPolicySaving(false);
  };

  const handleUpdatePolicy = async (policy: SecurityPolicy) => {
    setPolicySaving(true);
    try {
      await apiFetch(`/api/security/policies/${policy.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...policyForm, name: policyForm.name || policy.name }),
      });
      setEditingPolicyIdx(null);
      fetchData();
    } catch { /* apiFetch 内部已 showToast */ }
    setPolicySaving(false);
  };

  const handleDeletePolicy = async (policy: SecurityPolicy) => {
    if (!confirm(`确定删除策略 "${policy.name}"？`)) return;
    try {
      await apiFetch(`/api/security/policies/${policy.id}`, { method: "DELETE" });
      fetchData();
    } catch { /* apiFetch 内部已 showToast */ }
  };

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

  const tabs: Array<{ id: "credentials" | "audit" | "policy" | "approvals"; label: string; icon: React.ElementType; badge?: number }> = [
    { id: "credentials", label: "凭证管理", icon: Key },
    { id: "audit", label: "审计日志", icon: FileText },
    { id: "policy", label: "安全策略", icon: Shield },
    { id: "approvals", label: "待审批", icon: AlertTriangle, badge: approvals.length },
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
            {t.badge !== undefined && t.badge > 0 && (
              <span className="ml-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-bold text-white">
                {t.badge}
              </span>
            )}
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
      ) : tab === "policy" ? (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button onClick={() => { setShowCreatePolicy(true); setPolicyForm({ id: "", name: "", defaultSandbox: "process", defaultPermission: "ask", maxConcurrentSandboxes: 5 }); }} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700">
              <Plus className="h-4 w-4" /> 创建策略
            </button>
          </div>

          {policies.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-700 p-8 text-center">
              <Shield className="mx-auto h-10 w-10 text-zinc-600" />
              <p className="mt-3 text-zinc-400">暂无安全策略</p>
            </div>
          ) : (
            <div className="space-y-3">
              {policies.map((p, i) => (
                <div key={p.id || `policy-${i}`} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
                  {editingPolicyIdx === i ? (
                    <div className="space-y-4">
                      <h3 className="font-semibold text-white flex items-center gap-2">
                        <Shield className="h-5 w-5 text-blue-400" /> 编辑策略
                      </h3>
                      <div className="grid gap-4 sm:grid-cols-3">
                        <div>
                          <label className="block text-sm text-zinc-400 mb-1">沙箱级别</label>
                          <select value={policyForm.defaultSandbox} onChange={(e) => setPolicyForm({ ...policyForm, defaultSandbox: e.target.value })} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none">
                            <option value="none">无沙箱</option>
                            <option value="process">进程隔离</option>
                            <option value="docker">Docker 容器</option>
                            <option value="ssh">SSH 远程</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm text-zinc-400 mb-1">默认权限</label>
                          <select value={policyForm.defaultPermission} onChange={(e) => setPolicyForm({ ...policyForm, defaultPermission: e.target.value })} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none">
                            <option value="allow">允许</option>
                            <option value="deny">拒绝</option>
                            <option value="ask">询问</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm text-zinc-400 mb-1">最大并发沙箱</label>
                          <input type="number" value={policyForm.maxConcurrentSandboxes} onChange={(e) => setPolicyForm({ ...policyForm, maxConcurrentSandboxes: Number(e.target.value) })} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none" />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => handleUpdatePolicy(p)} disabled={policySaving} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                          {policySaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} 保存
                        </button>
                        <button onClick={() => setEditingPolicyIdx(null)} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800">取消</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-semibold text-white flex items-center gap-2">
                          <Shield className="h-5 w-5 text-blue-400" /> 沙箱配置
                        </h3>
                        <div className="mt-3 grid gap-4 sm:grid-cols-3">
                          <div><p className="text-sm text-zinc-400">沙箱级别</p><p className="text-white">{p.defaultSandbox}</p></div>
                          <div><p className="text-sm text-zinc-400">默认权限</p><p className="text-white">{p.defaultPermission}</p></div>
                          <div><p className="text-sm text-zinc-400">最大并发</p><p className="text-white">{p.maxConcurrentSandboxes}</p></div>
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <button onClick={() => { setEditingPolicyIdx(i); setPolicyForm(p); }} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white">
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button onClick={() => handleDeletePolicy(p)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-red-400">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 创建策略模态 */}
          {showCreatePolicy && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowCreatePolicy(false)}>
              <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-6" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-bold text-white mb-4">创建安全策略</h3>
                <div className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="block text-sm text-zinc-400 mb-1">沙箱级别</label>
                      <select value={policyForm.defaultSandbox} onChange={(e) => setPolicyForm({ ...policyForm, defaultSandbox: e.target.value })} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:outline-none">
                        <option value="none">无沙箱</option>
                        <option value="process">进程隔离</option>
                        <option value="docker">Docker 容器</option>
                        <option value="ssh">SSH 远程</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm text-zinc-400 mb-1">默认权限</label>
                      <select value={policyForm.defaultPermission} onChange={(e) => setPolicyForm({ ...policyForm, defaultPermission: e.target.value })} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:outline-none">
                        <option value="allow">允许</option>
                        <option value="deny">拒绝</option>
                        <option value="ask">询问</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm text-zinc-400 mb-1">最大并发沙箱</label>
                    <input type="number" value={policyForm.maxConcurrentSandboxes} onChange={(e) => setPolicyForm({ ...policyForm, maxConcurrentSandboxes: Number(e.target.value) })} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:outline-none" />
                  </div>
                  <div className="flex justify-end gap-3">
                    <button onClick={() => setShowCreatePolicy(false)} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-900">取消</button>
                    <button onClick={handleCreatePolicy} disabled={policySaving} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                      {policySaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} 创建
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : tab === "approvals" ? (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button onClick={fetchApprovals} className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800">
              <RefreshCw className="h-4 w-4" /> 刷新
            </button>
          </div>
          {approvalsLoading && approvals.length === 0 ? (
            <div className="py-12 text-center text-zinc-500">加载中...</div>
          ) : approvals.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-700 p-8 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
              <p className="mt-3 text-zinc-400">无待审批的操作</p>
            </div>
          ) : (
            <div className="space-y-3">
              {approvals.map((item) => (
                <div key={item.id} className="rounded-xl border border-amber-800/30 bg-amber-900/10 p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                        <span className="text-sm font-medium text-amber-300">
                          {item.guardResult?.level === "critical" ? "危险操作" : "需要审批"}
                        </span>
                        <span className="text-xs text-zinc-500 flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {new Date(item.createdAt).toLocaleString("zh-CN")}
                        </span>
                      </div>
                      <p className="font-mono text-sm text-white bg-zinc-900 rounded px-3 py-2 break-all">
                        {item.command}
                      </p>
                      {item.guardResult?.reason && (
                        <p className="text-xs text-zinc-500 mt-1">原因: {item.guardResult.reason}</p>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => handleResolve(item.id, true, "once")}
                        className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                      >
                        <CheckCircle2 className="h-4 w-4" /> 批准
                      </button>
                      <button
                        onClick={() => handleResolve(item.id, true, "session")}
                        className="flex items-center gap-1.5 rounded-lg border border-emerald-700 px-3 py-2 text-sm text-emerald-400 hover:bg-emerald-900/30"
                      >
                        会话内允许
                      </button>
                      <button
                        onClick={() => handleResolve(item.id, false)}
                        className="flex items-center gap-1.5 rounded-lg border border-red-700 px-3 py-2 text-sm text-red-400 hover:bg-red-900/30"
                      >
                        <XCircle className="h-4 w-4" /> 拒绝
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
