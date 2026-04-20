"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import { Sparkles, CheckCircle, XCircle, Clock, ThumbsUp, ThumbsDown, BarChart3, Lightbulb } from "lucide-react";

interface SkillProposal {
  id: string;
  name: string;
  description: string;
  content: string;
  status: "pending" | "approved" | "rejected";
  confidence: number;
  createdAt: string;
  source: string;
}

interface EvolutionStats {
  totalInteractions: number;
  skillProposals: number;
  approvedSkills: number;
  nudgeCount: number;
}

export default function EvolutionPage() {
  const [proposals, setProposals] = useState<SkillProposal[]>([]);
  const [stats, setStats] = useState<EvolutionStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedProposal, setSelectedProposal] = useState<SkillProposal | null>(null);

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
    await apiFetch(`/api/evolution/proposals/${id}/approve`, { method: "POST" });
    fetchData();
  };

  const handleReject = async (id: string) => {
    await apiFetch(`/api/evolution/proposals/${id}/reject`, { method: "POST" });
    fetchData();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">进化引擎</h1>
        <p className="mt-1 text-zinc-400">监控 Agent 自我进化和技能提案</p>
      </div>

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
                <p className="text-2xl font-bold text-white">{stats.skillProposals}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-green-600/20 p-2"><CheckCircle className="h-5 w-5 text-green-400" /></div>
              <div>
                <p className="text-sm text-zinc-400">已采纳</p>
                <p className="text-2xl font-bold text-white">{stats.approvedSkills}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-amber-600/20 p-2"><Sparkles className="h-5 w-5 text-amber-400" /></div>
              <div>
                <p className="text-sm text-zinc-400">Nudge 次数</p>
                <p className="text-2xl font-bold text-white">{stats.nudgeCount}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Proposals */}
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
                      <h4 className="font-medium text-white">{p.name}</h4>
                      <p className="mt-1 text-sm text-zinc-400 line-clamp-2">{p.description}</p>
                      <div className="mt-2 flex items-center gap-3">
                        <span className={`rounded px-1.5 py-0.5 text-xs ${
                          p.status === "approved" ? "bg-green-600/10 text-green-400" :
                          p.status === "rejected" ? "bg-red-600/10 text-red-400" :
                          "bg-amber-600/10 text-amber-400"
                        }`}>
                          {p.status === "pending" ? "待审核" : p.status === "approved" ? "已采纳" : "已拒绝"}
                        </span>
                        <span className="text-xs text-zinc-500">置信度: {Math.round(p.confidence * 100)}%</span>
                        <span className="text-xs text-zinc-600">{new Date(p.createdAt).toLocaleDateString("zh-CN")}</span>
                      </div>
                    </div>
                    {p.status === "pending" && (
                      <div className="flex gap-1 ml-2">
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
                <h3 className="font-semibold text-white mb-2">{selectedProposal.name}</h3>
                <p className="text-sm text-zinc-400 mb-4">{selectedProposal.description}</p>
                <pre className="max-h-[50vh] overflow-auto rounded-lg bg-zinc-950 p-4 text-sm text-zinc-300 font-mono">
                  {selectedProposal.content || "暂无内容"}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
