"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/utils";
import { Puzzle, Plus, Trash2, FileText, Code, Search, Download, Store, Loader2, ExternalLink } from "lucide-react";

interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  triggers: string[];
  content: string;
}

interface MarketSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  downloads: number;
  rating?: number;
  tags?: string[];
  source: string;
  sourceName: string;
  sourceUrl?: string;
  url?: string;
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Skill | null>(null);
  const [tab, setTab] = useState<"local" | "marketplace">("local");

  // Marketplace state
  const [marketQuery, setMarketQuery] = useState("");
  const [marketResults, setMarketResults] = useState<MarketSkill[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);

  const fetchSkills = () => {
    apiFetch<{ skills: Skill[] }>("/api/skills")
      .then((data) => setSkills(data.skills ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchSkills(); }, []);

  // P1-3: Listen for cross-page skill install events from chat page
  useEffect(() => {
    const ch = new BroadcastChannel("skill-sync");
    ch.onmessage = (e) => {
      if (e.data?.type === "skill-installed") fetchSkills();
    };
    return () => ch.close();
  }, []);

  const toggleSkill = async (skill: Skill) => {
    await apiFetch(`/api/skills/${skill.id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: !skill.enabled }),
    });
    fetchSkills();
  };

  const handleUninstall = async (id: string) => {
    if (!confirm("确定卸载该技能？")) return;
    await apiFetch(`/api/skills/${id}/uninstall`, { method: "POST" });
    fetchSkills();
  };

  const searchMarketplace = async () => {
    if (!marketQuery.trim()) return;
    setMarketLoading(true);
    try {
      const data = await apiFetch<{ results: MarketSkill[] }>(
        `/api/skills/marketplace/search?q=${encodeURIComponent(marketQuery)}`
      );
      setMarketResults(data.results ?? []);
    } catch {
      setMarketResults([]);
    }
    setMarketLoading(false);
  };

  const installSkill = async (skill: MarketSkill) => {
    setInstalling(skill.id);
    try {
      await apiFetch(`/api/skills/marketplace/install`, {
        method: "POST",
        body: JSON.stringify({
          sourceUrl: skill.sourceUrl || skill.url,
          sourceName: skill.sourceName || skill.source,
        }),
      });
      fetchSkills();
    } catch {}
    setInstalling(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">技能市场</h1>
          <p className="mt-1 text-zinc-400">管理本地技能和从远程市场安装</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg bg-zinc-900 p-1">
        <button
          onClick={() => setTab("local")}
          className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            tab === "local" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"
          }`}
        >
          <Puzzle className="h-4 w-4" /> 已安装 ({skills.length})
        </button>
        <button
          onClick={() => setTab("marketplace")}
          className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            tab === "marketplace" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"
          }`}
        >
          <Store className="h-4 w-4" /> 远程市场
        </button>
      </div>

      {tab === "local" ? (
        /* Local Skills */
        <>
          {loading ? (
            <div className="py-12 text-center text-zinc-500">加载中...</div>
          ) : skills.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-700 p-12 text-center">
              <Puzzle className="mx-auto h-12 w-12 text-zinc-600" />
              <p className="mt-4 text-zinc-400">暂无技能，在 skills/ 目录添加 .md 文件或从市场安装</p>
              <p className="mt-2 text-sm text-zinc-600">兼容 OpenClaw / Hermes / Super Agent 格式</p>
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3">
                {skills.map((skill) => (
                  <div
                    key={skill.id}
                    onClick={() => setSelected(skill)}
                    className={`cursor-pointer rounded-xl border p-4 transition-colors ${
                      selected?.id === skill.id
                        ? "border-blue-600 bg-blue-600/5"
                        : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Puzzle className="h-5 w-5 text-purple-400" />
                        <div>
                          <h3 className="font-medium text-white">{skill.name}</h3>
                          <p className="text-xs text-zinc-500">{skill.description}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-zinc-600">v{skill.version}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleSkill(skill); }}
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            skill.enabled ? "bg-green-600/10 text-green-400" : "bg-zinc-800 text-zinc-500"
                          }`}
                        >
                          {skill.enabled ? "已启用" : "已停用"}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleUninstall(skill.id); }}
                          className="rounded p-1 text-zinc-500 hover:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    {skill.triggers && skill.triggers.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {skill.triggers.map((t) => (
                          <span key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {selected && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
                  <div className="flex items-center gap-2 mb-4">
                    <FileText className="h-5 w-5 text-zinc-400" />
                    <h3 className="font-semibold text-white">{selected.name}</h3>
                  </div>
                  <pre className="max-h-[60vh] overflow-auto rounded-lg bg-zinc-950 p-4 text-sm text-zinc-300">
                    {selected.content || "暂无内容"}
                  </pre>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        /* Marketplace */
        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
            <input
              value={marketQuery}
              onChange={(e) => setMarketQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchMarketplace()}
              placeholder="搜索远程技能（回车搜索）..."
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 py-3 pl-10 pr-4 text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {marketLoading ? (
            <div className="py-8 text-center text-zinc-500">搜索中...</div>
          ) : marketResults.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-700 p-8 text-center">
              <Store className="mx-auto h-10 w-10 text-zinc-600" />
              <p className="mt-3 text-zinc-400">搜索远程技能市场</p>
              <p className="mt-1 text-sm text-zinc-600">支持 SkillHub / ClawHub / GitHub 源</p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {marketResults.map((ms) => (
                <div key={ms.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <h4 className="font-medium text-white truncate">{ms.name}</h4>
                      <p className="mt-1 text-xs text-zinc-500 line-clamp-2">{ms.description || "暂无描述"}</p>
                    </div>
                  </div>
                  {ms.tags && ms.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {ms.tags.map((t) => (
                        <span key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{t}</span>
                      ))}
                    </div>
                  )}
                  <div className="mt-3 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs text-zinc-600">
                      {ms.author && <span>{ms.author}</span>}
                      {ms.downloads != null && ms.downloads > 0 && <span>★ {ms.downloads}</span>}
                      <span className="text-zinc-700">{ms.sourceName || ms.source}</span>
                    </div>
                    <button
                      onClick={() => installSkill(ms)}
                      disabled={installing === ms.id}
                      className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {installing === ms.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                      安装
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
