"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import {
  Sparkles, CheckCircle, XCircle, Clock, ThumbsUp, ThumbsDown,
  BarChart3, Lightbulb, Play, Trash2, RefreshCw, Camera,
  Settings2, Save, Loader2, Shield, AlertTriangle, Wrench, Plus, Minus, Brain,
} from "lucide-react";

import type { SkillProposal, EvolutionStats, Snapshot, NudgeConfig } from "@/types/api-types";
import { FeatureBanner } from "@/components/ui/feature-banner";

export default function EvolutionPage() {
  const [proposals, setProposals] = useState<SkillProposal[]>([]);
  const [stats, setStats] = useState<EvolutionStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedProposal, setSelectedProposal] = useState<SkillProposal | null>(null);
  const [tab, setTab] = useState<"proposals" | "snapshots" | "nudge">("proposals");

  // 快照状态
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [creatingSnapshot, setCreatingSnapshot] = useState(false);
  const [snapshotLabel, setSnapshotLabel] = useState("");

  // Nudge 配置状态
  const [nudgeConfig, setNudgeConfig] = useState<NudgeConfig | null>(null);
  const [nudgeSaving, setNudgeSaving] = useState(false);
  const [nudgeEditing, setNudgeEditing] = useState<NudgeConfig | null>(null);

  // [审查 P1-4/P1-5/P2-7]: 分析器 LLM 配置（Provider+Model 选择，纯 LLM 分析不走 Agent）
  const [providers, setProviders] = useState<Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>>([]);
  const [analyzerProviderId, setAnalyzerProviderId] = useState<string | null>(null);
  const [analyzerModelId, setAnalyzerModelId] = useState<string | null>(null);
  const [analyzerSaving, setAnalyzerSaving] = useState(false);
  const [originalCode, setOriginalCode] = useState<string | null>(null);
  const [fetchingOriginalCode, setFetchingOriginalCode] = useState(false);
  const [approvingCode, setApprovingCode] = useState<Set<string>>(new Set());

  const fetchData = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch<{ proposals: SkillProposal[] }>("/api/evolution/proposals").catch(() => ({ proposals: [] })),
      apiFetch<EvolutionStats>("/api/evolution/stats").catch(() => null),
    ]).then(([p, s]) => {
      setProposals(p.proposals ?? []);
      if (s) setStats(s);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleApprove = async (id: string) => {
    try {
      await apiFetch(`/api/evolution/proposals/${id}/approve`, { method: "POST" });
      fetchData();
    } catch { /* apiFetch 内部已 showToast */ }
  };

  const handleReject = async (id: string) => {
    try {
      await apiFetch(`/api/evolution/proposals/${id}/reject`, { method: "POST" });
      fetchData();
    } catch { /* apiFetch 内部已 showToast */ }
  };

  // 应用提议到 Agent
  const handleApply = async (id: string) => {
    try {
      await apiFetch(`/api/evolution/proposals/${id}/apply`, { method: "POST" });
      fetchData();
    } catch { /* apiFetch 内部已 showToast */ }
  };

  // Flush 会话
  const handleFlush = async () => {
    try {
      await apiFetch("/api/evolution/flush", { method: "POST", body: JSON.stringify({}) });
      fetchData();
    } catch { /* apiFetch 内部已 showToast */ }
  };

  // 触发评审
  const handleReview = async () => {
    try {
      await apiFetch("/api/evolution/review", { method: "POST", body: JSON.stringify({ reviewMemory: true, reviewSkills: true }) });
      fetchData();
    } catch { /* apiFetch 内部已 showToast */ }
  };

  // 快照操作
  const fetchSnapshots = useCallback(async () => {
    setSnapshotLoading(true);
    try {
      const data = await apiFetch<{ snapshots: Snapshot[] }>("/api/evolution/snapshots");
      setSnapshots(data.snapshots ?? []);
    } catch { setSnapshots([]); }
    setSnapshotLoading(false);
  }, []);

  const handleCreateSnapshot = async () => {
    if (!snapshotLabel.trim()) return;
    setCreatingSnapshot(true);
    try {
      await apiFetch("/api/evolution/snapshots", {
        method: "POST",
        body: JSON.stringify({ label: snapshotLabel }),
      });
      setSnapshotLabel("");
      fetchSnapshots();
    } catch { /* apiFetch 内部已 showToast */ }
    setCreatingSnapshot(false);
  };

  const handleDeleteSnapshot = async (id: string) => {
    if (!confirm("确定删除该快照？")) return;
    try {
      await apiFetch(`/api/evolution/snapshots/${id}`, { method: "DELETE" });
      fetchSnapshots();
    } catch { /* apiFetch 内部已 showToast */ }
  };

  // Nudge 配置
  const fetchNudgeConfig = useCallback(async () => {
    try {
      const data = await apiFetch<NudgeConfig>("/api/evolution/nudge/config");
      setNudgeConfig(data);
      setNudgeEditing(data);
    } catch { /* ignore */ }
  }, []);

  const handleSaveNudge = async () => {
    if (!nudgeEditing) return;
    setNudgeSaving(true);
    try {
      const data = await apiFetch<NudgeConfig>("/api/evolution/nudge/config", {
        method: "PUT",
        body: JSON.stringify(nudgeEditing),
      });
      setNudgeConfig(data);
      setNudgeEditing(data);
    } catch { /* ignore */ }
    setNudgeSaving(false);
  };

  // [审查 P1-4]: 获取已配置的 Provider+Model 列表 + 分析器配置
  const fetchProviders = useCallback(async () => {
    try {
      const data = await apiFetch<{ providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> }>("/api/evolution/analyzer/providers");
      setProviders(data.providers ?? []);
    } catch { /* ignore */ }
  }, []);

  const fetchAnalyzerConfig = useCallback(async () => {
    try {
      const data = await apiFetch<{ providerId: string | null; modelId: string | null }>("/api/evolution/analyzer/config");
      setAnalyzerProviderId(data.providerId ?? null);
      setAnalyzerModelId(data.modelId ?? null);
    } catch { /* ignore */ }
  }, []);

  const handleSaveAnalyzer = async () => {
    setAnalyzerSaving(true);
    try {
      const data = await apiFetch<{ providerId: string | null; modelId: string | null }>("/api/evolution/analyzer/config", {
        method: "PUT",
        body: JSON.stringify({ providerId: analyzerProviderId, modelId: analyzerModelId }),
      });
      setAnalyzerProviderId(data.providerId ?? null);
      setAnalyzerModelId(data.modelId ?? null);
    } catch { /* ignore */ }
    setAnalyzerSaving(false);
  };

  // [审查 P2-7]: 审核代码并执行（含 loading 态与错误提示）
  const handleApproveCode = async (id: string) => {
    if (!confirm("确认审核通过并执行代码修改？此操作将修改源码文件。")) return;
    setApprovingCode(prev => new Set(prev).add(id));
    try {
      const result = await apiFetch<SkillProposal>(`/api/evolution/proposals/${id}/approve-code`, { method: "POST" });
      if (result) {
        // 成功后会刷新列表
        fetchData();
      }
    } catch {
      // apiFetch 内部已 showToast，错误消息会包含沙箱验证失败的详情
    } finally {
      setApprovingCode(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // [审查 P0-2]: 选中代码提案时获取原始代码
  const fetchOriginalCode = useCallback(async (p: SkillProposal) => {
    if (!p.targetCode) {
      setOriginalCode(null);
      return;
    }
    setFetchingOriginalCode(true);
    try {
      const data = await apiFetch<{ code: string }>("/api/evolution/code/read", {
        method: "POST",
        body: JSON.stringify({ modulePath: p.targetCode.modulePath, targetName: p.targetCode.targetName }),
      });
      setOriginalCode(data.code ?? "");
    } catch {
      setOriginalCode(""); // 读取失败时显示空字符串，前端提示"无法读取原始文件"
    }
    setFetchingOriginalCode(false);
  }, []);

  // [审查 P1-4]: 页面初始化时加载 Agent 列表和分析器配置
  useEffect(() => { fetchProviders(); fetchAnalyzerConfig(); }, [fetchProviders, fetchAnalyzerConfig]);

  useEffect(() => {
    if (tab === "snapshots") fetchSnapshots();
    if (tab === "nudge") fetchNudgeConfig();
  }, [tab, fetchSnapshots, fetchNudgeConfig]);

  // [审查 P0-2]: 选中提案时自动获取原始代码用于 before/after diff
  useEffect(() => {
    if (selectedProposal) {
      fetchOriginalCode(selectedProposal);
    }
  }, [selectedProposal, fetchOriginalCode]);

  const tabs = [
    { id: "proposals" as const, label: "技能提案", icon: Lightbulb },
    { id: "snapshots" as const, label: "快照管理", icon: Camera },
    { id: "nudge" as const, label: "Nudge 配置", icon: Settings2 },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">进化引擎</h1>
          <p className="mt-1 text-zinc-400">Agent 自我进化中枢：技能提案 · 源码修改 · 失败分析 · 记忆纠偏</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleFlush} className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
            <RefreshCw className="h-4 w-4" /> Flush 会话
          </button>
          <button onClick={handleReview} className="flex items-center gap-2 rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-white hover:bg-purple-700">
            <Sparkles className="h-4 w-4" /> 触发评审
          </button>
        </div>
      </div>

      <FeatureBanner
        pageId="evolution"
        icon={Sparkles}
        title="进化引擎"
        description="进化引擎是 Agent 的自我进化中枢，横跨三大进化通道：技能进化（自动从交互中发现可复用模式并生成.md技能提案）、源码进化（LLM 分析代码缺陷后直接产出源码修改提案，含 before/after diff 对比）、记忆进化（自动检测用户偏好矛盾并生成纠偏建议）。所有提案经过风险评估后进入审核队列，支持人工审批或渐进自动化放权。"
        useCases={[
          "技能提案：Agent 检测到重复性工作后自动生成 .md 技能，支持 create/update/patch 三种操作",
          "源码修改：LLM 分析代码缺陷 → 产出 targetCode 提案 → before/after 双栏 diff → 沙箱验证后应用",
          "失败分析：自动汇聚交互失败案例，LLM 分析模式后生成改进提案（分析器支持配置 Provider+Model）",
          "记忆纠偏：检测用户偏好矛盾 → 生成 contradictions 报告 → 人工确认后修正",
          "快照管理：定期保存 Agent 进化状态（技能+记忆+配置），支持一键回滚",
          "Nudge 定时：配置记忆评审/技能评审/Flush 间隔，进化引擎后台自动触发",
        ]}
        tips={[
          "触发评审按钮会立即让分析器 LLM 分析最近的交互，生成技能或源码提案",
          "源码修改提案需人工审核后才能执行，高风险提案（requiredHumanReview）必须人工确认",
          "快照是 Agent 状态的完整备份，创建后可在快照管理中回滚",
        ]}
      />

      {/* Stats */}
      {stats && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-blue-600/20 p-2"><BarChart3 className="h-5 w-5 text-blue-400" /></div>
              <div>
                <p className="text-sm text-zinc-400">总交互数</p>
                <p className="text-2xl font-bold text-white">{stats.totalInteractions}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-purple-600/20 p-2"><Lightbulb className="h-5 w-5 text-purple-400" /></div>
              <div>
                <p className="text-sm text-zinc-400">技能提案</p>
                <p className="text-2xl font-bold text-white">{stats.totalProposals}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-green-600/20 p-2"><CheckCircle className="h-5 w-5 text-green-400" /></div>
              <div>
                <p className="text-sm text-zinc-400">已采纳</p>
                <p className="text-2xl font-bold text-white">{stats.appliedProposals}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-amber-600/20 p-2"><Sparkles className="h-5 w-5 text-amber-400" /></div>
              <div>
                <p className="text-sm text-zinc-400">Nudge 次数</p>
                <p className="text-2xl font-bold text-white">{stats.nudges.memory + stats.nudges.skill}</p>
              </div>
            </div>
          </div>
          {/* [审查 P1-5]: 待审核代码提案计数 */}
          <div
            onClick={() => setTab("proposals")}
            className={`rounded-xl border p-5 cursor-pointer transition-colors ${
              proposals.filter(p => p.requiresHumanReview).length > 0
                ? "border-orange-600/50 bg-orange-600/5 hover:bg-orange-600/10"
                : "border-zinc-800 bg-zinc-900/50"
            }`}
          >
            <div className="flex items-center gap-3">
              <div className={`rounded-lg p-2 ${proposals.filter(p => p.requiresHumanReview).length > 0 ? "bg-orange-600/20" : "bg-zinc-700/20"}`}>
                <Shield className={`h-5 w-5 ${proposals.filter(p => p.requiresHumanReview).length > 0 ? "text-orange-400" : "text-zinc-500"}`} />
              </div>
              <div>
                <p className="text-sm text-zinc-400">待审核代码</p>
                <p className={`text-2xl font-bold ${proposals.filter(p => p.requiresHumanReview).length > 0 ? "text-orange-400" : "text-white"}`}>
                  {proposals.filter(p => p.requiresHumanReview).length}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* [审查 P1-4]: 分析器 LLM 配置 — Provider+Model 二级选择器（纯 LLM 分析不走 Agent） */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className="rounded-lg bg-purple-600/20 p-2">
            <Brain className="h-5 w-5 text-purple-400" />
          </div>
          <div>
            <h3 className="font-semibold text-white">分析器配置</h3>
            <p className="text-xs text-zinc-500">用于失败分析、技能提案生成的纯 LLM，不走 Agent 系统提示词和工具</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Provider 选择器 */}
          <select
            value={analyzerProviderId ?? ""}
            onChange={(e) => { setAnalyzerProviderId(e.target.value || null); setAnalyzerModelId(null); }}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-white text-sm focus:border-purple-500 focus:outline-none"
          >
            <option value="">自动选择（首个可用 Agent 的 LLM）</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {/* Model 选择器（仅当 Provider 已选择时显示） */}
          {analyzerProviderId && (
            <select
              value={analyzerModelId ?? ""}
              onChange={(e) => setAnalyzerModelId(e.target.value || null)}
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-white text-sm focus:border-purple-500 focus:outline-none"
            >
              <option value="">选择模型</option>
              {(providers.find(p => p.id === analyzerProviderId)?.models ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          )}
          <button
            onClick={handleSaveAnalyzer}
            disabled={analyzerSaving}
            className="flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {analyzerSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} 保存
          </button>
        </div>
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

      {tab === "proposals" ? (
      <div>
        <h2 className="mb-3 text-lg font-semibold text-white">技能提案</h2>
        {loading ? (
          <div className="py-8 text-center text-zinc-500">加载中...</div>
        ) : proposals.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-700 p-8 text-center">
            <Sparkles className="mx-auto h-10 w-10 text-zinc-600" />
            <p className="mt-3 text-zinc-400">暂无技能提案</p>
            <p className="mt-1 text-sm text-zinc-600">Agent 在交互过程中发现可复用的模式后会自动生成技能提案</p>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              {proposals.map((p) => (
                <div
                  key={p.id}
                  onClick={() => setSelectedProposal(p)}
                  className={`cursor-pointer rounded-xl border p-4 transition-colors ${
                    selectedProposal?.id === p.id ? "border-blue-600 bg-blue-600/5" : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="font-medium text-white">{p.skillName}</h4>
                      <p className="mt-1 text-sm text-zinc-400 line-clamp-2">{p.description}</p>
                      <div className="mt-2 flex items-center gap-3">
                        <span className={`rounded px-1.5 py-0.5 text-xs ${
                          p.status === "approved" || p.status === "applied" ? "bg-green-600/10 text-green-400" :
                          p.status === "rejected" ? "bg-red-600/10 text-red-400" :
                          "bg-amber-600/10 text-amber-400"
                        }`}>
                          {p.status === "pending" ? "待审核" : p.status === "approved" || p.status === "applied" ? "已采纳" : "已拒绝"}
                        </span>
                        {p.qualityScore != null && (
                          <span className="text-xs text-zinc-500">质量: {p.qualityScore}分</span>
                        )}
                        <span className="text-xs text-zinc-600">{new Date(p.createdAt).toLocaleDateString("zh-CN")}</span>
                        {/* [审查 P1-5/P2-6]: targetCode 差异化 chip */}
                        {p.requiresHumanReview && (
                          <span className="rounded px-1.5 py-0.5 text-xs bg-orange-600/10 text-orange-400 flex items-center gap-1">
                            <Shield className="h-3 w-3" /> 待审核
                          </span>
                        )}
                        {p.targetCode && !p.requiresHumanReview && (
                          <span className={`rounded px-1.5 py-0.5 text-xs flex items-center gap-1 ${
                            p.targetCode.operation === "modify" ? "bg-purple-600/10 text-purple-400" :
                            p.targetCode.operation === "add" ? "bg-green-600/10 text-green-400" :
                            "bg-red-600/10 text-red-400"
                          }`}>
                            {p.targetCode.operation === "modify" ? <Wrench className="h-3 w-3" /> :
                             p.targetCode.operation === "add" ? <Plus className="h-3 w-3" /> :
                             <Minus className="h-3 w-3" />}
                            {p.targetCode.operation === "modify" ? "代码修改" :
                             p.targetCode.operation === "add" ? "代码新增" : "代码删除"}
                          </span>
                        )}
                      </div>
                    </div>
                    {p.status === "pending" && (
                      <div className="flex gap-1 ml-2">
                        <button onClick={(e) => { e.stopPropagation(); handleApply(p.id); }} className="rounded p-1.5 text-zinc-400 hover:bg-blue-600/10 hover:text-blue-400" title="应用">
                          <Play className="h-4 w-4" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); handleApprove(p.id); }} className="rounded p-1.5 text-zinc-400 hover:bg-green-600/10 hover:text-green-400" title="采纳">
                          <ThumbsUp className="h-4 w-4" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); handleReject(p.id); }} className="rounded p-1.5 text-zinc-400 hover:bg-red-600/10 hover:text-red-400" title="拒绝">
                          <ThumbsDown className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {selectedProposal && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
                <h3 className="font-semibold text-white mb-2">{selectedProposal.skillName}</h3>
                <p className="text-sm text-zinc-400 mb-4">{selectedProposal.description}</p>

                {selectedProposal.targetCode ? (
                  /* [审查 P0-2]: 代码提案 diff 面板 — before/after 双栏对比 */
                  <div className="space-y-4">
                    {/* 提案元信息 */}
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className={`rounded px-1.5 py-0.5 ${
                        selectedProposal.targetCode.operation === "modify" ? "bg-purple-600/10 text-purple-400" :
                        selectedProposal.targetCode.operation === "add" ? "bg-green-600/10 text-green-400" :
                        "bg-red-600/10 text-red-400"
                      }`}>
                        {selectedProposal.targetCode.operation === "modify" ? "修改" :
                         selectedProposal.targetCode.operation === "add" ? "新增" : "删除"}
                      </span>
                      <span className="text-zinc-500">模块:</span>
                      <code className="text-zinc-300">{selectedProposal.targetCode.modulePath}</code>
                      {selectedProposal.targetCode.targetName && (
                        <>
                          <span className="text-zinc-500">目标:</span>
                          <code className="text-zinc-300">{selectedProposal.targetCode.targetName}</code>
                        </>
                      )}
                    </div>

                    {/* 推理理由 */}
                    {selectedProposal.reasoning && (
                      <p className="text-xs text-zinc-500 bg-zinc-900 rounded-lg p-3">{selectedProposal.reasoning}</p>
                    )}

                    {/* Code Diff 双栏 */}
                    {fetchingOriginalCode ? (
                      <div className="py-8 text-center text-zinc-500">
                        <Loader2 className="mx-auto h-5 w-5 animate-spin mb-2" />
                        加载原始代码...
                      </div>
                    ) : (
                      <div className={`grid gap-3 ${
                        selectedProposal.targetCode.operation === "add" ||
                        selectedProposal.targetCode.operation === "delete"
                          ? "grid-cols-1" : "grid-cols-2"
                      }`}>
                        {/* Before 栏 — delete 和 modify 操作才显示 */}
                        {(selectedProposal.targetCode.operation === "modify" ||
                          selectedProposal.targetCode.operation === "delete") && (
                          <div>
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-xs text-zinc-500 font-medium">原始代码 (before)</span>
                            </div>
                            <pre className="max-h-[40vh] overflow-auto rounded-lg bg-zinc-950 border border-zinc-800 p-3 text-xs text-zinc-400 font-mono whitespace-pre-wrap break-all">
                              {originalCode || (originalCode === "" ? "⚠ 无法读取原始文件" : "")}
                            </pre>
                          </div>
                        )}
                        {/* After 栏 — add 和 modify 操作才显示 */}
                        {(selectedProposal.targetCode.operation === "modify" ||
                          selectedProposal.targetCode.operation === "add") && (
                          <div>
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-xs text-zinc-500 font-medium">
                                {selectedProposal.targetCode.operation === "add" ? "新增代码 (after)" : "新代码 (after)"}
                              </span>
                            </div>
                            <pre className="max-h-[40vh] overflow-auto rounded-lg bg-zinc-950 border border-emerald-600/30 p-3 text-xs text-emerald-300 font-mono whitespace-pre-wrap break-all">
                              {selectedProposal.targetCode.newCode || "暂无内容"}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}

                    {/* 审核警告 */}
                    {selectedProposal.requiresHumanReview && (
                      <div className="flex items-center gap-2 rounded-lg bg-orange-600/10 border border-orange-600/30 p-3">
                        <AlertTriangle className="h-4 w-4 text-orange-400 flex-shrink-0" />
                        <div className="flex-1">
                          <p className="text-sm text-orange-300 font-medium">需要人工审核</p>
                          {selectedProposal.reviewReason && (
                            <p className="text-xs text-orange-400/70 mt-0.5">{selectedProposal.reviewReason}</p>
                          )}
                        </div>
                      </div>
                    )}

                    {/* 操作按钮栏 */}
                    <div className="flex items-center gap-2 pt-2 border-t border-zinc-800">
                      {selectedProposal.requiresHumanReview && selectedProposal.status === "pending" ? (
                        <button
                          onClick={() => handleApproveCode(selectedProposal.id)}
                          disabled={approvingCode.has(selectedProposal.id)}
                          className="flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
                        >
                          {approvingCode.has(selectedProposal.id) ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Shield className="h-4 w-4" />
                          )}
                          审核代码并执行
                        </button>
                      ) : selectedProposal.targetCode && selectedProposal.status === "pending" ? (
                        <button
                          onClick={() => handleApproveCode(selectedProposal.id)}
                          disabled={approvingCode.has(selectedProposal.id)}
                          className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {approvingCode.has(selectedProposal.id) ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <CheckCircle className="h-4 w-4" />
                          )}
                          应用代码
                        </button>
                      ) : selectedProposal.status === "pending" && (
                        <>
                          <button
                            onClick={() => handleApprove(selectedProposal.id)}
                            className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
                          >
                            <ThumbsUp className="h-4 w-4" /> 采纳
                          </button>
                          <button
                            onClick={() => handleApply(selectedProposal.id)}
                            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                          >
                            <Play className="h-4 w-4" /> 应用
                          </button>
                        </>
                      )}
                      {selectedProposal.status === "pending" && (
                        <button
                          onClick={() => handleReject(selectedProposal.id)}
                          className="flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800"
                        >
                          <ThumbsDown className="h-4 w-4" /> 拒绝
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  /* 无 targetCode：保持现有 Markdown 渲染 */
                  <>
                    <pre className="max-h-[50vh] overflow-auto rounded-lg bg-zinc-950 p-4 text-sm text-zinc-300 font-mono">
                      {selectedProposal.content || "暂无内容"}
                    </pre>
                    {selectedProposal.status === "pending" && (
                      <div className="flex items-center gap-2 mt-4 pt-3 border-t border-zinc-800">
                        <button
                          onClick={() => handleApprove(selectedProposal.id)}
                          className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
                        >
                          <ThumbsUp className="h-4 w-4" /> 采纳
                        </button>
                        <button
                          onClick={() => handleApply(selectedProposal.id)}
                          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                        >
                          <Play className="h-4 w-4" /> 应用
                        </button>
                        <button
                          onClick={() => handleReject(selectedProposal.id)}
                          className="flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800"
                        >
                          <ThumbsDown className="h-4 w-4" /> 拒绝
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      ) : tab === "snapshots" ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <input
              value={snapshotLabel}
              onChange={(e) => setSnapshotLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateSnapshot()}
              placeholder="快照标签..."
              className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={handleCreateSnapshot}
              disabled={creatingSnapshot || !snapshotLabel.trim()}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {creatingSnapshot ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} 创建快照
            </button>
          </div>
          {snapshotLoading ? (
            <div className="py-8 text-center text-zinc-500">加载中...</div>
          ) : snapshots.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-700 p-8 text-center">
              <Camera className="mx-auto h-10 w-10 text-zinc-600" />
              <p className="mt-3 text-zinc-400">暂无快照</p>
              <p className="mt-1 text-sm text-zinc-600">创建快照以保存当前 Agent 进化状态</p>
            </div>
          ) : (
            <div className="space-y-3">
              {snapshots.map((snap) => (
                <div key={snap.id} className="group flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <div>
                    <h4 className="font-medium text-white">{snap.label || `快照 #${snap.stageIndex + 1}`}</h4>
                    <span className="text-xs text-zinc-500">{new Date(snap.timestamp).toLocaleString("zh-CN")}</span>
                  </div>
                  <button onClick={() => handleDeleteSnapshot(snap.id)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-red-400 opacity-0 group-hover:opacity-100">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {nudgeEditing ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 space-y-5">
              <h3 className="font-semibold text-white flex items-center gap-2">
                <Settings2 className="h-5 w-5 text-amber-400" /> Nudge 配置
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-sm text-zinc-400 mb-1">记忆评审间隔 (轮)</label>
                  <input
                    type="number"
                    value={nudgeEditing.memoryReviewInterval}
                    onChange={(e) => setNudgeEditing({ ...nudgeEditing, memoryReviewInterval: Number(e.target.value) })}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-zinc-600">每 N 轮对话自动触发记忆评审（0=禁用）</p>
                </div>
                <div>
                  <label className="block text-sm text-zinc-400 mb-1">技能评审间隔 (次)</label>
                  <input
                    type="number"
                    value={nudgeEditing.skillReviewInterval}
                    onChange={(e) => setNudgeEditing({ ...nudgeEditing, skillReviewInterval: Number(e.target.value) })}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-zinc-600">每 N 次工具调用自动触发技能评审（0=禁用）</p>
                </div>
                <div>
                  <label className="block text-sm text-zinc-400 mb-1">Flush 最小轮数</label>
                  <input
                    type="number"
                    value={nudgeEditing.flushMinTurns}
                    onChange={(e) => setNudgeEditing({ ...nudgeEditing, flushMinTurns: Number(e.target.value) })}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-zinc-600">对话少于此轮数时跳过 Flush（0=禁用）</p>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm text-zinc-400 mb-1">自动应用技能</label>
                    <button
                      onClick={() => setNudgeEditing({ ...nudgeEditing, autoApplySkills: !nudgeEditing.autoApplySkills })}
                      className={`rounded-lg px-4 py-2 text-sm font-medium ${
                        nudgeEditing.autoApplySkills ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400"
                      }`}
                    >
                      {nudgeEditing.autoApplySkills ? "已启用" : "已禁用"}
                    </button>
                  </div>
                  <div>
                    <label className="block text-sm text-zinc-400 mb-1">合并评审</label>
                    <button
                      onClick={() => setNudgeEditing({ ...nudgeEditing, combinedReview: !nudgeEditing.combinedReview })}
                      className={`rounded-lg px-4 py-2 text-sm font-medium ${
                        nudgeEditing.combinedReview ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400"
                      }`}
                    >
                      {nudgeEditing.combinedReview ? "已启用" : "已禁用"}
                    </button>
                  </div>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleSaveNudge}
                  disabled={nudgeSaving}
                  className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {nudgeSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} 保存配置
                </button>
              </div>
            </div>
          ) : (
            <div className="py-8 text-center text-zinc-500">加载配置中...</div>
          )}
        </div>
      )}
    </div>
  );
}
