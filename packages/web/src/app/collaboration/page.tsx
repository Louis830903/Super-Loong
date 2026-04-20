"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/utils";
import { useAgents } from "@/hooks/useAgents";
import {
  Users, Play, Loader2, CheckCircle, XCircle, ArrowRight,
  Plus, Trash2, ChevronDown, ChevronUp, X, MessageSquare, Clock,
} from "lucide-react";

// ─── 匹配后端 CrewResult / GroupChatResult 的联合类型 ────────
interface TaskOutputItem {
  taskId: string;
  agentId: string;
  output: string;
  retries: number;
  durationMs: number;
}

interface CollabMessageItem {
  id: string;
  agentId: string;
  agentName: string;
  content: string;
  role: string;
}

interface CollabHistoryItem {
  // Crew 模式字段
  crewId?: string;
  process?: "sequential" | "hierarchical";
  taskOutputs?: TaskOutputItem[];
  finalOutput?: string;
  // GroupChat 模式字段
  chatId?: string;
  messages?: CollabMessageItem[];
  turns?: number;
  summary?: string;
  // 共有字段
  name: string;
  status: string;
  totalDurationMs: number;
  error?: string;
}

// 判断是否为 Crew 类型（后端使用 'process' in result）
const isCrew = (item: CollabHistoryItem) => "process" in item && item.process !== undefined;
const getItemId = (item: CollabHistoryItem) => item.crewId ?? item.chatId ?? "unknown";
const formatDuration = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

// ─── Crew 任务行类型 ────────────────────────────────────────
interface TaskRow {
  id: string;
  description: string;
  expectedOutput: string;
  agentId: string;
  context: string[];
}

const emptyTask = (index: number): TaskRow => ({
  id: `task-${index + 1}`,
  description: "",
  expectedOutput: "Task result",
  agentId: "",
  context: [],
});

export default function CollaborationPage() {
  const { agents } = useAgents();
  const [results, setResults] = useState<CollabHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<"crew" | "groupchat">("crew");
  const [selectedResult, setSelectedResult] = useState<CollabHistoryItem | null>(null);

  // ─── Crew 表单（支持多任务） ──────────────────────────────
  const [crewForm, setCrewForm] = useState({
    name: "新任务团队",
    process: "sequential" as string,
    agents: [] as string[],
    managerAgentId: "",
    tasks: [emptyTask(0)] as TaskRow[],
  });

  // ─── GroupChat 表单（含高级选项） ─────────────────────────
  const [gcForm, setGcForm] = useState({
    topic: "",
    agents: [] as string[],
    maxRounds: 10,
    selectionMethod: "round_robin" as string,
    // 高级选项
    systemMessage: "",
    terminationKeyword: "",
    moderatorAgentId: "",
  });
  const [showAdvanced, setShowAdvanced] = useState(false);

  // 加载历史记录
  useEffect(() => {
    apiFetch<{ results: CollabHistoryItem[] }>("/api/collab/history")
      .catch(() => ({ results: [] }))
      .then((d) => setResults(d.results ?? []))
      .finally(() => setLoading(false));
  }, []);

  // 刷新历史
  const refreshHistory = () => {
    apiFetch<{ results: CollabHistoryItem[] }>("/api/collab/history")
      .catch(() => ({ results: [] }))
      .then((d) => setResults(d.results ?? []));
  };

  // ─── Agent 选择切换 ──────────────────────────────────────
  const toggleAgent = (agentId: string, formType: "crew" | "gc") => {
    if (formType === "crew") {
      setCrewForm((f) => ({
        ...f,
        agents: f.agents.includes(agentId) ? f.agents.filter((a) => a !== agentId) : [...f.agents, agentId],
      }));
    } else {
      setGcForm((f) => ({
        ...f,
        agents: f.agents.includes(agentId) ? f.agents.filter((a) => a !== agentId) : [...f.agents, agentId],
      }));
    }
  };

  // ─── 任务行操作 ──────────────────────────────────────────
  const addTask = () => setCrewForm((f) => ({ ...f, tasks: [...f.tasks, emptyTask(f.tasks.length)] }));
  const removeTask = (idx: number) => setCrewForm((f) => ({
    ...f,
    tasks: f.tasks.filter((_, i) => i !== idx).map((t, i) => ({ ...t, id: `task-${i + 1}` })),
  }));
  const updateTask = (idx: number, patch: Partial<TaskRow>) => setCrewForm((f) => ({
    ...f,
    tasks: f.tasks.map((t, i) => i === idx ? { ...t, ...patch } : t),
  }));

  // ─── 提交 Crew ───────────────────────────────────────────
  const runCrew = async (e: React.FormEvent) => {
    e.preventDefault();
    if (crewForm.agents.length < 2) { alert("至少选择 2 个 Agent"); return; }
    if (crewForm.tasks.some((t) => !t.description.trim())) { alert("所有任务必须填写描述"); return; }
    if (crewForm.process === "hierarchical" && !crewForm.managerAgentId) { alert("分层模式必须选择 Manager Agent"); return; }
    setRunning(true);
    try {
      const body: Record<string, unknown> = {
        name: crewForm.name,
        process: crewForm.process,
        tasks: crewForm.tasks.map((t) => ({
          id: t.id,
          description: t.description,
          expectedOutput: t.expectedOutput || "Task result",
          agentId: t.agentId || crewForm.agents[0],
          ...(t.context.length > 0 ? { context: t.context } : {}),
        })),
      };
      if (crewForm.process === "hierarchical") body.managerAgentId = crewForm.managerAgentId;
      await apiFetch("/api/collab/crew", { method: "POST", body: JSON.stringify(body) });
      refreshHistory();
    } catch { /* API 错误已在 apiFetch 中处理 */ }
    setRunning(false);
  };

  // ─── 提交 GroupChat ───────────────────────────────────────
  const runGroupChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (gcForm.agents.length < 2) { alert("至少选择 2 个 Agent"); return; }
    if (!gcForm.topic.trim()) { alert("请填写讨论主题"); return; }
    setRunning(true);
    try {
      const body: Record<string, unknown> = {
        name: gcForm.topic,
        participantIds: gcForm.agents,
        initialMessage: gcForm.topic,
        speakerSelection: gcForm.selectionMethod,
        maxTurns: gcForm.maxRounds,
      };
      // 高级选项：仅非空时传递
      if (gcForm.systemMessage.trim()) body.systemMessage = gcForm.systemMessage;
      if (gcForm.terminationKeyword.trim()) body.terminationKeyword = gcForm.terminationKeyword;
      if (gcForm.selectionMethod === "auto" && gcForm.moderatorAgentId) body.moderatorAgentId = gcForm.moderatorAgentId;
      await apiFetch("/api/collab/groupchat", { method: "POST", body: JSON.stringify(body) });
      refreshHistory();
    } catch { /* API 错误已在 apiFetch 中处理 */ }
    setRunning(false);
  };

  // ─── 输入框基础样式 ──────────────────────────────────────
  const inputCls = "w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none";
  const labelCls = "block text-sm text-zinc-400 mb-1";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">多 Agent 协作</h1>
        <p className="mt-1 text-zinc-400">Crew 任务编排 & GroupChat 多轮对话</p>
      </div>

      {/* ─── Tabs ───────────────────────────────────────────── */}
      <div className="flex gap-1 rounded-lg bg-zinc-900 p-1">
        <button onClick={() => setTab("crew")} className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium ${tab === "crew" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"}`}>
          <ArrowRight className="h-4 w-4" /> Crew 编排
        </button>
        <button onClick={() => setTab("groupchat")} className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium ${tab === "groupchat" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"}`}>
          <Users className="h-4 w-4" /> GroupChat
        </button>
      </div>

      {/* ═══════════════ Crew 表单 ═══════════════════════════ */}
      {tab === "crew" ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
          <h3 className="font-semibold text-white mb-4">创建 Crew 任务</h3>
          <form onSubmit={runCrew} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>团队名称</label>
                <input value={crewForm.name} onChange={(e) => setCrewForm({ ...crewForm, name: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>执行模式</label>
                <select value={crewForm.process} onChange={(e) => setCrewForm({ ...crewForm, process: e.target.value })} className={inputCls}>
                  <option value="sequential">顺序执行</option>
                  <option value="hierarchical">分层执行</option>
                </select>
              </div>
            </div>

            {/* B-3: 分层模式 Manager Agent 选择 */}
            {crewForm.process === "hierarchical" && (
              <div className="rounded-lg border border-amber-800/40 bg-amber-900/10 p-3">
                <label className="block text-sm text-amber-400 mb-1">Manager Agent（必选）</label>
                <p className="text-xs text-zinc-500 mb-2">分层模式下，Manager Agent 负责分析任务依赖并分配执行顺序</p>
                <select
                  value={crewForm.managerAgentId}
                  onChange={(e) => setCrewForm({ ...crewForm, managerAgentId: e.target.value })}
                  className={inputCls}
                  required
                >
                  <option value="">请选择 Manager Agent</option>
                  {crewForm.agents.map((aid) => {
                    const a = agents.find((x) => x.id === aid);
                    return a ? <option key={aid} value={aid}>{a.name}</option> : null;
                  })}
                </select>
              </div>
            )}

            {/* Agent 选择 */}
            <div>
              <label className="block text-sm text-zinc-400 mb-2">选择参与 Agent</label>
              <div className="flex flex-wrap gap-2">
                {agents.map((a) => (
                  <button key={a.id} type="button" onClick={() => toggleAgent(a.id, "crew")}
                    className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${crewForm.agents.includes(a.id) ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}>
                    {a.name}
                  </button>
                ))}
              </div>
            </div>

            {/* B-2: 多任务表单 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-zinc-400">任务列表</label>
                <button type="button" onClick={addTask} className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300">
                  <Plus className="h-3.5 w-3.5" /> 添加任务
                </button>
              </div>
              <div className="space-y-3">
                {crewForm.tasks.map((task, idx) => (
                  <div key={task.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-zinc-500">任务 {idx + 1}</span>
                      {crewForm.tasks.length > 1 && (
                        <button type="button" onClick={() => removeTask(idx)} className="text-zinc-600 hover:text-red-400">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    <textarea
                      placeholder="任务描述..."
                      value={task.description}
                      onChange={(e) => updateTask(idx, { description: e.target.value })}
                      rows={2}
                      className={`${inputCls} resize-none text-sm`}
                      required
                    />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="text-xs text-zinc-500">预期输出</label>
                        <input
                          value={task.expectedOutput}
                          onChange={(e) => updateTask(idx, { expectedOutput: e.target.value })}
                          className={`${inputCls} text-sm`}
                          placeholder="Task result"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500">分配 Agent</label>
                        <select
                          value={task.agentId}
                          onChange={(e) => updateTask(idx, { agentId: e.target.value })}
                          className={`${inputCls} text-sm`}
                        >
                          <option value="">自动（第一个Agent）</option>
                          {crewForm.agents.map((aid) => {
                            const a = agents.find((x) => x.id === aid);
                            return a ? <option key={aid} value={aid}>{a.name}</option> : null;
                          })}
                        </select>
                      </div>
                    </div>
                    {/* 上下文依赖（仅在有多个任务时显示） */}
                    {crewForm.tasks.length > 1 && idx > 0 && (
                      <div>
                        <label className="text-xs text-zinc-500">依赖任务（可选）</label>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {crewForm.tasks.slice(0, idx).map((prevTask) => (
                            <button
                              key={prevTask.id}
                              type="button"
                              onClick={() => {
                                const ctx = task.context.includes(prevTask.id)
                                  ? task.context.filter((c) => c !== prevTask.id)
                                  : [...task.context, prevTask.id];
                                updateTask(idx, { context: ctx });
                              }}
                              className={`rounded px-2 py-0.5 text-xs ${task.context.includes(prevTask.id) ? "bg-purple-600/30 text-purple-300" : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700"}`}
                            >
                              {prevTask.id}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <button type="submit" disabled={running} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              执行 Crew
            </button>
          </form>
        </div>
      ) : (
        /* ═══════════════ GroupChat 表单 ═══════════════════════ */
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
          <h3 className="font-semibold text-white mb-4">创建 GroupChat</h3>
          <form onSubmit={runGroupChat} className="space-y-4">
            <div>
              <label className={labelCls}>讨论主题</label>
              <input value={gcForm.topic} onChange={(e) => setGcForm({ ...gcForm, topic: e.target.value })} className={inputCls} required />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>最大轮次</label>
                <input type="number" min={1} max={100} value={gcForm.maxRounds} onChange={(e) => setGcForm({ ...gcForm, maxRounds: Number(e.target.value) })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>发言选择</label>
                <select value={gcForm.selectionMethod} onChange={(e) => setGcForm({ ...gcForm, selectionMethod: e.target.value })} className={inputCls}>
                  <option value="round_robin">轮流发言</option>
                  <option value="auto">自动选择</option>
                  <option value="random">随机</option>
                </select>
              </div>
            </div>
            {/* Agent 选择 */}
            <div>
              <label className="block text-sm text-zinc-400 mb-2">选择参与 Agent</label>
              <div className="flex flex-wrap gap-2">
                {agents.map((a) => (
                  <button key={a.id} type="button" onClick={() => toggleAgent(a.id, "gc")}
                    className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${gcForm.agents.includes(a.id) ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}>
                    {a.name}
                  </button>
                ))}
              </div>
            </div>

            {/* B-4: 高级选项折叠面板 */}
            <div className="border border-zinc-800 rounded-lg">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex w-full items-center justify-between px-3 py-2 text-sm text-zinc-400 hover:text-white"
              >
                <span>高级选项</span>
                {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              {showAdvanced && (
                <div className="border-t border-zinc-800 p-3 space-y-3">
                  <div>
                    <label className="text-xs text-zinc-500">系统消息（为对话提供背景上下文）</label>
                    <textarea
                      value={gcForm.systemMessage}
                      onChange={(e) => setGcForm({ ...gcForm, systemMessage: e.target.value })}
                      rows={2}
                      className={`${inputCls} text-sm resize-none`}
                      placeholder="可选：为参与Agent提供对话背景..."
                    />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500">终止关键词（当Agent输出包含此关键词时停止）</label>
                    <input
                      value={gcForm.terminationKeyword}
                      onChange={(e) => setGcForm({ ...gcForm, terminationKeyword: e.target.value })}
                      className={`${inputCls} text-sm`}
                      placeholder="例如：TERMINATE"
                    />
                  </div>
                  {gcForm.selectionMethod === "auto" && (
                    <div>
                      <label className="text-xs text-zinc-500">Moderator Agent（负责选择下一位发言者）</label>
                      <select
                        value={gcForm.moderatorAgentId}
                        onChange={(e) => setGcForm({ ...gcForm, moderatorAgentId: e.target.value })}
                        className={`${inputCls} text-sm`}
                      >
                        <option value="">默认（第一个参与者）</option>
                        {gcForm.agents.map((aid) => {
                          const a = agents.find((x) => x.id === aid);
                          return a ? <option key={aid} value={aid}>{a.name}</option> : null;
                        })}
                      </select>
                    </div>
                  )}
                </div>
              )}
            </div>

            <button type="submit" disabled={running} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              开始 GroupChat
            </button>
          </form>
        </div>
      )}

      {/* ═══════════════ 执行历史 ═════════════════════════════ */}
      <div>
        <h2 className="mb-3 text-lg font-semibold text-white">执行历史</h2>
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 text-zinc-500 animate-spin" /></div>
        ) : results.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-700 p-8 text-center">
            <Users className="mx-auto h-10 w-10 text-zinc-600" />
            <p className="mt-3 text-zinc-400">暂无协作执行记录</p>
          </div>
        ) : (
          <div className="space-y-2">
            {results.map((r) => {
              const id = getItemId(r);
              const crew = isCrew(r);
              return (
                <div
                  key={id}
                  onClick={() => setSelectedResult(selectedResult && getItemId(selectedResult) === id ? null : r)}
                  className={`cursor-pointer rounded-xl border bg-zinc-900/50 p-4 transition-colors ${
                    selectedResult && getItemId(selectedResult) === id ? "border-blue-600" : "border-zinc-800 hover:border-zinc-700"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {r.status === "completed" || r.status === "terminated" || r.status === "max_turns" ? (
                        <CheckCircle className="h-5 w-5 text-green-500 shrink-0" />
                      ) : r.status === "failed" || r.status === "error" ? (
                        <XCircle className="h-5 w-5 text-red-500 shrink-0" />
                      ) : (
                        <Loader2 className="h-5 w-5 text-blue-400 animate-spin shrink-0" />
                      )}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-white">{r.name || (crew ? "Crew" : "GroupChat")}</span>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${crew ? "bg-blue-600/20 text-blue-400" : "bg-purple-600/20 text-purple-400"}`}>
                            {crew ? "Crew" : "GroupChat"}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-0.5">
                          <span className="text-xs text-zinc-500 flex items-center gap-1">
                            <Clock className="h-3 w-3" /> {formatDuration(r.totalDurationMs)}
                          </span>
                          <span className="text-xs text-zinc-500">
                            {crew ? `${r.taskOutputs?.length ?? 0} 个任务` : `${r.turns ?? 0} 轮`}
                          </span>
                        </div>
                      </div>
                    </div>
                    <span className={`rounded px-2 py-0.5 text-xs ${
                      r.status === "completed" || r.status === "terminated" || r.status === "max_turns"
                        ? "bg-green-600/10 text-green-400"
                        : "bg-red-600/10 text-red-400"
                    }`}>
                      {r.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ═══════════════ B-1: 详情面板 ════════════════════════ */}
      {selectedResult && (
        <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-white">
              执行详情 — {selectedResult.name}
            </h3>
            <button onClick={() => setSelectedResult(null)} className="text-zinc-500 hover:text-white">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* 错误信息 */}
          {selectedResult.error && (
            <div className="rounded-lg border border-red-800/40 bg-red-900/10 p-3 text-sm text-red-400">
              {selectedResult.error}
            </div>
          )}

          {/* Crew 详情：展示每个 TaskOutput */}
          {isCrew(selectedResult) && selectedResult.taskOutputs && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-zinc-400">任务输出</h4>
              {selectedResult.taskOutputs.map((to, i) => (
                <div key={to.taskId} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-zinc-400">
                      #{i + 1} {to.taskId} → {to.agentId}
                    </span>
                    <span className="text-xs text-zinc-500">{formatDuration(to.durationMs)} · {to.retries} 次重试</span>
                  </div>
                  <p className="text-sm text-zinc-300 whitespace-pre-wrap">{to.output.slice(0, 500)}{to.output.length > 500 ? "..." : ""}</p>
                </div>
              ))}
              {selectedResult.finalOutput && (
                <div className="rounded-lg border border-green-800/30 bg-green-900/10 p-3">
                  <h5 className="text-xs font-medium text-green-400 mb-1">最终输出</h5>
                  <p className="text-sm text-zinc-300 whitespace-pre-wrap">{selectedResult.finalOutput.slice(0, 500)}</p>
                </div>
              )}
            </div>
          )}

          {/* GroupChat 详情：展示消息时间线 */}
          {!isCrew(selectedResult) && selectedResult.messages && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-zinc-400 flex items-center gap-1">
                <MessageSquare className="h-3.5 w-3.5" /> 对话记录（{selectedResult.messages.length} 条）
              </h4>
              <div className="max-h-80 overflow-y-auto space-y-1.5 pr-1">
                {selectedResult.messages.map((msg) => (
                  <div key={msg.id} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-medium text-blue-400">{msg.agentName}</span>
                      <span className={`rounded px-1 py-0.5 text-[10px] ${msg.role === "system" ? "bg-zinc-700 text-zinc-400" : "bg-zinc-800 text-zinc-500"}`}>
                        {msg.role}
                      </span>
                    </div>
                    <p className="text-sm text-zinc-300">{msg.content.slice(0, 300)}{msg.content.length > 300 ? "..." : ""}</p>
                  </div>
                ))}
              </div>
              {selectedResult.summary && (
                <div className="rounded-lg border border-blue-800/30 bg-blue-900/10 p-3">
                  <h5 className="text-xs font-medium text-blue-400 mb-1">摘要</h5>
                  <p className="text-sm text-zinc-300">{selectedResult.summary}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
