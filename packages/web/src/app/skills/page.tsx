"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/utils";
import { Puzzle, Plus, Trash2, FileText, Code, Search, Download, Store, Loader2, ExternalLink, ChevronDown, ChevronUp, X } from "lucide-react";
import { GuidedEmptyState } from "@/components/ui/guided-empty-state";
import { FeatureBanner } from "@/components/ui/feature-banner";

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
  const [localQuery, setLocalQuery] = useState("");

  // 搜索过滤本地技能
  const filteredSkills = useMemo(() => {
    const q = localQuery.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      (s.triggers ?? []).some(t => t.toLowerCase().includes(q))
    );
  }, [skills, localQuery]);

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
    } catch (err) {
      // [v3 Task 5] 安装 skill 失败不中断 UI，installing 状态仍会被外层 finally 重置
      console.debug("[skills] install failed", err);
    }
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

      <FeatureBanner
        pageId="skills"
        icon={Puzzle}
        title="技能市场"
        description="技能（Skill）是 Agent 的可插拔能力模块。每个技能通过 .md 文件定义触发词和提示词模板，Agent 在对话中识别到触发词后自动调用对应技能执行任务。"
        useCases={[
          "代码审查：创建代码审查技能，Agent 自动审查代码质量",
          "日报生成：设置定时触发，Agent 每日自动汇总工作内容生成日报",
          "翻译助手：定义翻译技能，在对话中随时触发多语言翻译",
        ]}
        tips={[
          "本地技能放在 skills/ 目录，兼容 OpenClaw / Hermes 格式",
          "远程市场支持 SkillHub / ClawHub / GitHub 源，一键安装",
        ]}
      />

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
        /* 本地已安装技能 — 全宽卡片网格 + 搜索 + 展开详情 */
        <>
          {loading ? (
            <div className="py-12 text-center text-zinc-500">加载中...</div>
          ) : skills.length === 0 ? (
            <GuidedEmptyState
              icon={Puzzle}
              title="还没有安装技能"
              description="技能（Skill）是 Agent 的可插拔能力模块。通过 .md 文件定义触发词和提示词，Agent 在对话中识别触发词后自动调用对应技能。兼容 OpenClaw / Hermes 格式。"
              steps={[
                "在 skills/ 目录创建 .md 文件，定义触发词和提示词模板",
                "或从远程技能市场一键安装社区共享的技能",
                "在对话中使用触发词，Agent 会自动调用对应技能",
              ]}
              secondaryAction={{ label: "去市场安装", onClick: () => setTab("marketplace") }}
            />
          ) : (
            <>
              {/* 搜索过滤 */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
                <input
                  value={localQuery}
                  onChange={(e) => setLocalQuery(e.target.value)}
                  placeholder={`搜索已安装技能（共 ${skills.length} 个）...`}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-900 py-2.5 pl-10 pr-4 text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                />
              </div>

              {/* 全宽响应式卡片网格 */}
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {filteredSkills.map((skill) => {
                  const isExpanded = selected?.id === skill.id;
                  return (
                    <div
                      key={skill.id}
                      className={`rounded-xl border transition-colors ${
                        isExpanded
                          ? "border-blue-600 bg-blue-600/5"
                          : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
                      }`}
                    >
                      {/* 卡片头 */}
                      <div
                        className="cursor-pointer p-4"
                        onClick={() => setSelected(isExpanded ? null : skill)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-start gap-3 min-w-0 flex-1">
                            <Puzzle className="h-5 w-5 shrink-0 mt-0.5 text-purple-400" />
                            <div className="min-w-0">
                              <h3 className="font-medium text-white truncate">{skill.name}</h3>
                              <p className="mt-1 text-xs text-zinc-500 line-clamp-2">{skill.description}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleSkill(skill); }}
                              className={`rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${
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
                        {/* 版本 + 触发词 */}
                        <div className="mt-2 flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-zinc-600">v{skill.version}</span>
                          {skill.triggers && skill.triggers.slice(0, 3).map((t) => (
                            <span key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{t}</span>
                          ))}
                          {skill.triggers && skill.triggers.length > 3 && (
                            <span className="text-xs text-zinc-600">+{skill.triggers.length - 3}</span>
                          )}
                        </div>
                      </div>

                      {/* 展开的详情区 */}
                      {isExpanded && (
                        <div className="border-t border-zinc-800 p-4">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <FileText className="h-4 w-4 text-zinc-400" />
                              <span className="text-xs font-medium text-zinc-400">技能内容</span>
                            </div>
                            <button onClick={() => setSelected(null)} className="text-zinc-500 hover:text-white">
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                          {skill.triggers && skill.triggers.length > 0 && (
                            <div className="mb-3 flex flex-wrap gap-1">
                              {skill.triggers.map((t) => (
                                <span key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{t}</span>
                              ))}
                            </div>
                          )}
                          <pre className="max-h-48 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-300">
                            {skill.content || "暂无内容"}
                          </pre>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {filteredSkills.length === 0 && (
                <div className="py-8 text-center text-zinc-500">没有匹配的技能</div>
              )}
            </>
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
              <p className="mt-3 text-zinc-400">搜索远程技能市场，发现社区共享的技能</p>
              <p className="mt-1 text-sm text-zinc-600">
                输入关键词（如 code-review、translation）搜索，支持 SkillHub / ClawHub / GitHub 源
              </p>
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
