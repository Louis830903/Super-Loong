"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import {
  Sparkles, CheckCircle, XCircle, Clock, ThumbsUp, ThumbsDown,
  BarChart3, Lightbulb, Play, Trash2, RefreshCw, Camera,
  Settings2, Save, Loader2,
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

  useEffect(() => {
    if (tab === "snapshots") fetchSnapshots();
    if (tab === "nudge") fetchNudgeConfig();
  }, [tab, fetchSnapshots, fetchNudgeConfig]);

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
          <p className="mt-1 text-zinc-400">监控 Agent 自我进化和技能提案</p>
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
        description="进化引擎让 Agent 在交互过程中自动发现可复用的行为模式，生成技能提案供你审核。你可以批准、拒绝或应用提案，让 Agent 持续进化。"
        useCases={[
          "自动发现模式：Agent 检测到重复性工作后自动生成技能提案",
          "技能提案审核：人工审核 Agent 生成的提案，批准后自动创建技能",
          "快照管理：定期保存 Agent 进化状态，可回滚到历史版本",
          "Nudge 配置：设置自动评审间隔，让进化引擎定时触发",
        ]}
        tips={[
          "触发评审按钮会立即让 Agent 分析最近的交互，生成新提案",
          "快照是 Agent 状态的完整备份，包含所有技能和记忆",
        ]}
      />

      {/* Stats */}
      {stats && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
        </div>
      )}

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
                <pre className="max-h-[50vh] overflow-auto rounded-lg bg-zinc-950 p-4 text-sm text-zinc-300 font-mono">
                  {selectedProposal.content || "暂无内容"}
                </pre>
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
