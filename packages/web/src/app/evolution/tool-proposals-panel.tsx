"use client";

/**
 * P1-2 / P1-3: 工具提案 + 自进化模块激活状态面板（独立组件）
 *
 * - 工具提案：进化引擎在能力缺口达阈值时自动生成的候选工具（骨架 + LLM 填充），
 *   状态 pending_review → approved / rejected。人工审核后才由动态加载器纳入（需重启）。
 * - 激活状态：按 SUPER_AGENT_EVOLUTION_STAGE 分阶段激活的自进化模块拓扑。
 *
 * 调用：GET /api/evolution/tool-proposals、/api/evolution/activation，
 *      POST /api/evolution/tool-proposals/:id/approve|reject。
 */

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import { Wrench, RefreshCw, CheckCircle, XCircle, ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";

interface ToolProposal {
  id: string;
  tool_name: string;
  category: string;
  description: string;
  gap_id?: string;
  source_code: string;
  status: string;
  review_note?: string;
  created_at?: string;
}

interface ActivationStep {
  module: string;
  phase: number;
  dependencies: string[];
  activated: boolean;
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending_review: { label: "待审核", cls: "bg-amber-600/20 text-amber-300" },
  approved: { label: "已批准", cls: "bg-emerald-600/20 text-emerald-300" },
  rejected: { label: "已拒绝", cls: "bg-red-600/20 text-red-300" },
};

export function ToolProposalsPanel() {
  const [proposals, setProposals] = useState<ToolProposal[]>([]);
  const [steps, setSteps] = useState<ActivationStep[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [p, a] = await Promise.all([
        apiFetch<{ proposals: ToolProposal[] }>("/api/evolution/tool-proposals").catch(() => ({ proposals: [] as ToolProposal[] })),
        apiFetch<{ steps: ActivationStep[] }>("/api/evolution/activation").catch(() => ({ steps: [] as ActivationStep[] })),
      ]);
      setProposals(p.proposals ?? []);
      setSteps(a.steps ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const act = async (id: string, action: "approve" | "reject") => {
    setBusy((prev) => new Set(prev).add(id));
    try {
      await apiFetch(`/api/evolution/tool-proposals/${id}/${action}`, { method: "POST", body: JSON.stringify({}) });
      await fetchAll();
    } catch { /* apiFetch 内部已 showToast */ }
    finally {
      setBusy((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  };

  return (
    <div className="space-y-6">
      {/* 激活状态 */}
      <div>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">自进化模块激活状态</h3>
            <p className="text-sm text-zinc-400">
              由 <code className="text-zinc-300">SUPER_AGENT_EVOLUTION_STAGE</code> 分阶段激活（0=关/1=检测/2=+生成/3=+自主，默认 0 全关）
            </p>
          </div>
          <button
            onClick={fetchAll}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> 刷新
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {steps.length === 0 ? (
            <span className="text-sm text-zinc-500">未获取到激活状态</span>
          ) : steps.map((s) => (
            <span
              key={s.module}
              className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs ${s.activated ? "bg-emerald-600/15 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}
              title={s.dependencies.length ? `依赖：${s.dependencies.join(", ")}` : "无依赖"}
            >
              {s.activated && <ShieldCheck className="h-3 w-3" />}
              {s.module} <span className="opacity-60">S{s.phase}</span>
            </span>
          ))}
        </div>
      </div>

      {/* 工具提案 */}
      <div>
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-zinc-400" />
          <h3 className="text-lg font-semibold text-white">工具骨架提案</h3>
        </div>
        <p className="mt-1 text-sm text-zinc-400">
          缺口达阈值时自动生成候选工具（默认关闭，需 <code className="text-zinc-300">SUPER_AGENT_EVOLUTION_TOOLGEN=true</code> 或 STAGE≥2）。批准前会做静态校验 + 安全扫描，绝不自动热加载。
        </p>

        {proposals.length === 0 ? (
          <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
            <Wrench className="mx-auto h-8 w-8 text-zinc-600" />
            <p className="mt-2 text-sm text-zinc-500">暂无工具提案。当系统反复遇到同类能力缺口且开启生成开关时，会在此生成待审核的候选工具。</p>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {proposals.map((p) => {
              const badge = STATUS_BADGE[p.status] ?? { label: p.status, cls: "bg-zinc-700 text-zinc-300" };
              const isOpen = expanded.has(p.id);
              const isBusy = busy.has(p.id);
              return (
                <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm text-white">{p.tool_name}</span>
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{p.category}</span>
                        <span className={`rounded px-1.5 py-0.5 text-xs ${badge.cls}`}>{badge.label}</span>
                      </div>
                      <p className="mt-2 text-sm text-zinc-300">{p.description}</p>
                      {p.review_note && <p className="mt-1 text-xs text-zinc-500">审核备注：{p.review_note}</p>}
                    </div>
                    {p.status === "pending_review" && (
                      <div className="flex shrink-0 gap-2">
                        <button
                          onClick={() => act(p.id, "approve")}
                          disabled={isBusy}
                          className="flex items-center gap-1 rounded-lg bg-emerald-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                        >
                          <CheckCircle className="h-3.5 w-3.5" /> 批准
                        </button>
                        <button
                          onClick={() => act(p.id, "reject")}
                          disabled={isBusy}
                          className="flex items-center gap-1 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
                        >
                          <XCircle className="h-3.5 w-3.5" /> 拒绝
                        </button>
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => toggle(p.id)}
                    className="mt-3 flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
                  >
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    {isOpen ? "收起候选代码" : "查看候选代码"}
                  </button>
                  {isOpen && (
                    <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-zinc-800 bg-black/40 p-3 text-xs text-zinc-300">
                      <code>{p.source_code}</code>
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
