"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, API_BASE } from "@/lib/utils";
import { useAgents } from "@/hooks/useAgents";
import {
  Users, Play, Loader2, CheckCircle, XCircle, ArrowRight,
  Plus, Trash2, ChevronDown, ChevronUp, X, MessageSquare, Clock,
  StopCircle, Paperclip, FileText, Download, Search, Check,
} from "lucide-react";
import type { AgentInfo } from "@/hooks/useAgents";

import type { AttachmentItem, TaskOutputItem, CollabMessageItem, CollabHistoryItem } from "@/types/api-types";

// G-1: 使用 type 字段判断，fallback 兼容旧数据
const isCrew = (item: CollabHistoryItem) => item.type === "crew" || (item.type == null && "process" in item && item.process !== undefined);
const getItemId = (item: CollabHistoryItem) => item.crewId ?? item.chatId ?? "unknown";
const formatDuration = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

/** 格式化文件大小（字节 → 人类可读） */
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

/** 从路径中提取文件名 */
const baseName = (p: string): string => {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
};

/** 可展开文本组件 — 替代所有截断逻辑 */
function ExpandableText({ text, maxLen = 500 }: { text: string; maxLen?: number }) {
  const [expanded, setExpanded] = useState(false);
  // P2-5: runtime null 防御，后端旧数据可能返回 null/undefined
  const safeText = text ?? "";
  if (safeText.length <= maxLen) return <p className="text-sm text-zinc-300 whitespace-pre-wrap">{safeText}</p>;
  return (
    <div>
      <p className="text-sm text-zinc-300 whitespace-pre-wrap">{expanded ? safeText : safeText.slice(0, maxLen) + "..."}</p>
      <button onClick={() => setExpanded(!expanded)} className="text-xs text-blue-400 hover:text-blue-300 mt-1">
        {expanded ? "↑ 收起" : "↓ 展开全文"}
      </button>
    </div>
  );
}

/** 可复用的附件列表组件 — 展示附件下载链接 */
function AttachmentList({ attachments }: { attachments?: AttachmentItem[] }) {
  if (!attachments?.length) return null;
  return (
    <div className="mt-2 space-y-1">
      <h6 className="text-xs font-medium text-zinc-500 flex items-center gap-1">
        <Paperclip className="h-3 w-3" /> 附件 ({attachments.length})
      </h6>
      {attachments.map((att, i) => {
        const displayName = att.filename ?? (att.path ? baseName(att.path) : att.url ?? "file");
        const downloadUrl = att.path
          ? `${API_BASE}/api/collab/attachment?path=${encodeURIComponent(att.path)}`
          : att.url ?? "#";
        return (
          <a
            key={i}
            href={downloadUrl}
            download={displayName}
            className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300 hover:border-blue-700 hover:text-blue-400 transition-colors"
          >
            <FileText className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
            <span className="truncate">{displayName}</span>
            {att.size != null && <span className="text-zinc-600 ml-auto shrink-0">{formatSize(att.size)}</span>}
            <Download className="h-3 w-3 text-zinc-600 shrink-0" />
          </a>
        );
      })}
    </div>
  );
}

// ─── 可复用 Agent 分组选择器 ──────────────────────────────────
// 替代 200+ Agent 平铺标签墙，提供搜索+部门分组+折叠+已选展示
interface AgentSelectorProps {
  agents: AgentInfo[];
  selected: string[];
  onToggle: (agentId: string) => void;
}

/** 按部门分组的数据结构 */
interface AgentGroup {
  key: string;
  label: string;
  agents: AgentInfo[];
  isCustom: boolean;
}

function AgentSelector({ agents, selected, onToggle }: AgentSelectorProps) {
  const [search, setSearch] = useState("");
  // 内置部门默认折叠，自建默认展开
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ _custom: true });

  const toggleExpand = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  // 搜索过滤 + 按部门分组
  const groups = useMemo<AgentGroup[]>(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? agents.filter(
          (a) =>
            a.name.toLowerCase().includes(q) ||
            a.departmentLabel.toLowerCase().includes(q) ||
            a.description.toLowerCase().includes(q),
        )
      : agents;

    // 自建 Agent 单独分组
    const custom = filtered.filter((a) => !a.isBuiltin);
    // 内置 Agent 按部门聚合
    const deptMap = new Map<string, AgentInfo[]>();
    for (const a of filtered.filter((a) => a.isBuiltin)) {
      const key = a.department || "other";
      if (!deptMap.has(key)) deptMap.set(key, []);
      deptMap.get(key)!.push(a);
    }

    const result: AgentGroup[] = [];
    if (custom.length > 0) {
      result.push({ key: "_custom", label: "\u81ea\u5efa Agent", agents: custom, isCustom: true });
    }
    // 按部门名称排序
    const sortedDepts = [...deptMap.entries()].sort(([, a], [, b]) =>
      (a[0]?.departmentLabel ?? "").localeCompare(b[0]?.departmentLabel ?? ""),
    );
    for (const [dept, list] of sortedDepts) {
      result.push({
        key: dept,
        label: list[0]?.departmentLabel || dept,
        agents: list.sort((a, b) => a.name.localeCompare(b.name)),
        isCustom: false,
      });
    }
    return result;
  }, [agents, search]);

  // 搜索时自动展开所有分组
  const isSearching = search.trim().length > 0;

  // 全选/取消全选某个分组
  const toggleGroupAll = (group: AgentGroup) => {
    const allSelected = group.agents.every((a) => selected.includes(a.id));
    if (allSelected) {
      group.agents.forEach((a) => { if (selected.includes(a.id)) onToggle(a.id); });
    } else {
      group.agents.forEach((a) => { if (!selected.includes(a.id)) onToggle(a.id); });
    }
  };

  const selectedAgents = agents.filter((a) => selected.includes(a.id));

  return (
    <div className="space-y-3">
      <label className="block text-sm text-zinc-400">
        \u9009\u62e9\u53c2\u4e0e Agent
        {selected.length > 0 && (
          <span className="ml-2 text-xs text-blue-400">\u5df2\u9009 {selected.length} \u4e2a</span>
        )}
      </label>

      {/* \u641c\u7d22\u6846 */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="\u641c\u7d22 Agent \u540d\u79f0\u6216\u90e8\u95e8..."
          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-9 pr-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none"
        />
        {search && (
          <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* \u5df2\u9009 Agent Chips */}
      {selectedAgents.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedAgents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onToggle(a.id)}
              className="flex items-center gap-1 rounded-full bg-blue-600/20 border border-blue-600/40 px-2.5 py-1 text-xs text-blue-300 hover:bg-blue-600/30 transition-colors"
            >
              {a.name}
              <X className="h-3 w-3" />
            </button>
          ))}
        </div>
      )}

      {/* \u5206\u7ec4\u5217\u8868 */}
      <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/50 divide-y divide-zinc-800/50">
        {groups.length === 0 ? (
          <div className="py-6 text-center text-sm text-zinc-500">\u65e0\u5339\u914d\u7684 Agent</div>
        ) : (
          groups.map((group) => {
            const isOpen = isSearching || expanded[group.key] || false;
            const selectedCount = group.agents.filter((a) => selected.includes(a.id)).length;
            const allSelected = selectedCount === group.agents.length;
            return (
              <div key={group.key}>
                {/* \u5206\u7ec4\u5934 */}
                <button
                  type="button"
                  onClick={() => toggleExpand(group.key)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-zinc-900/50 transition-colors"
                >
                  <ChevronDown
                    className={`h-3.5 w-3.5 text-zinc-500 shrink-0 transition-transform ${isOpen ? "" : "-rotate-90"}`}
                  />
                  <span className={`font-medium ${group.isCustom ? "text-green-400" : "text-zinc-300"}`}>
                    {group.label}
                  </span>
                  <span className="text-xs text-zinc-600">({group.agents.length})</span>
                  {selectedCount > 0 && (
                    <span className="rounded-full bg-blue-600/20 px-1.5 py-0.5 text-xs text-blue-400">
                      {selectedCount} \u5df2\u9009
                    </span>
                  )}
                  <span className="flex-1" />
                  <span
                    onClick={(e) => { e.stopPropagation(); toggleGroupAll(group); }}
                    className="text-xs text-zinc-500 hover:text-blue-400 cursor-pointer px-1"
                  >
                    {allSelected ? "\u53d6\u6d88\u5168\u9009" : "\u5168\u9009"}
                  </span>
                </button>
                {/* \u5206\u7ec4\u5185\u5bb9 */}
                {isOpen && (
                  <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
                    {group.agents.map((a) => {
                      const isSel = selected.includes(a.id);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => onToggle(a.id)}
                          className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors ${
                            isSel
                              ? "bg-blue-600 text-white"
                              : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                          }`}
                        >
                          {isSel && <Check className="h-3 w-3" />}
                          {a.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── 字符数限制常量（与后端 LIMITS 保持一致） ────────────────────
const LIMITS = {
  CREW_NAME: 100,
  TASK_DESC: 5000,
  TASK_OUTPUT: 2000,
  GC_TOPIC: 200,
  GC_INITIAL_MSG: 5000,
  GC_SYSTEM_MSG: 5000,
  TERM_KEYWORD: 100,
} as const;

/** 字符计数器 — 接近上限时变黄/变红提醒 */
function CharCounter({ current, max }: { current: number; max: number }) {
  const ratio = current / max;
  const color = ratio >= 1 ? "text-red-400" : ratio >= 0.9 ? "text-yellow-400" : "text-zinc-600";
  return <span className={`text-xs ${color}`}>{current}/{max}</span>;
}

// ─── Crew 任务行类型 ────────────────────────────────────────
interface TaskRow {
  id: string;
  description: string;
  expectedOutput: string;
  /** Agent ID；autoAssign 模式下为空字符串表示由 Manager 自动分配 */
  agentId: string;
  /** 可选的能力提示，辅助 Manager 匹配或生成新 Agent 规格 */
  requiredCapabilities?: string[];
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
  /** E-3: 当前运行中的任务 ID 集合 */
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set());
  /** E-3: 正在取消中的任务 ID */
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set());
  /** G-3: 执行错误信息 */
  const [error, setError] = useState<string | null>(null);

  // ─── Crew 表单（支持多任务） ──────────────────────────────
  const [crewForm, setCrewForm] = useState({
    name: "新任务团队",
    process: "sequential" as string,
    agents: [] as string[],
    managerAgentId: "",
    tasks: [emptyTask(0)] as TaskRow[],
    /** Hierarchical 智能 Agent 自动分配（仅 hierarchical 生效） */
    autoAssign: false,
    /** 单次 Crew 最多动态创建的 Agent 数（硬上限 30） */
    maxDynamicAgents: 10,
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
    // I-4/T-2: graph 模式扩展字段（正式纳入类型，消除 as any）
    graphTransitions: {} as Record<string, string[]>,
    graphStartAgent: "",
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

  // E-3: 轮询运行中任务（每 3 秒），有运行中任务时激活
  useEffect(() => {
    const poll = () => {
      apiFetch<Array<{ id: string }>>("/api/collab/running")
        .then((tasks) => {
          const ids = new Set(tasks.map((t) => t.id));
          setRunningTaskIds(ids);
          // 运行中任务清空后自动刷新历史（某个任务刚完成）
          if (ids.size === 0 && running) refreshHistory();
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, [running]);

  // E-3: 取消运行中的任务
  const cancelTask = async (taskId: string) => {
    setCancellingIds((prev) => new Set(prev).add(taskId));
    try {
      await apiFetch(`/api/collab/cancel/${taskId}`, { method: "POST" });
      setRunningTaskIds((prev) => { const s = new Set(prev); s.delete(taskId); return s; });
      // 短暂延时后刷新历史，等待后端结果落库
      setTimeout(refreshHistory, 500);
    } catch (err) {
      // FE-1: 将取消失败信息提示用户，而非静默忽略
      setError(err instanceof Error ? err.message : "取消任务失败，请重试");
    }
    setCancellingIds((prev) => { const s = new Set(prev); s.delete(taskId); return s; });
  };

  // ─── G-2: SSE 实时进度推送 ──────────────────────────────────
  /** 当前执行中任务的实时进度信息（task:start / groupchat:message 等） */
  const [liveProgress, setLiveProgress] = useState<Record<string, string>>({});
  const refreshHistoryRef = useRef(refreshHistory);
  refreshHistoryRef.current = refreshHistory;

  useEffect(() => {
    const url = `${API_BASE}/api/collab/events`;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      try {
        es = new EventSource(url);

        es.onmessage = (e) => {
          try {
            const event = JSON.parse(e.data);
            const eventType = event.type as string;

            // 任务开始/完成/消息 → 更新实时进度
            if (eventType === "task:start") {
              setLiveProgress((prev) => ({
                ...prev,
                [event.crewId]: `执行任务 ${event.taskId}...`,
              }));
            } else if (eventType === "task:complete") {
              setLiveProgress((prev) => ({
                ...prev,
                [event.crewId]: `任务 ${event.taskId} 完成`,
              }));
            } else if (eventType === "groupchat:message") {
              setLiveProgress((prev) => ({
                ...prev,
                [event.chatId]: `[${event.message?.agentName}] ${(event.message?.content ?? "").slice(0, 60)}`,
              }));
            }

            // crew/groupchat 完成 → 清除进度 + 刷新历史
            if (eventType === "crew:complete" || eventType === "crew:error" ||
                eventType === "groupchat:complete") {
              const id = event.crewId ?? event.chatId;
              if (id) setLiveProgress((prev) => { const p = { ...prev }; delete p[id]; return p; });
              refreshHistoryRef.current();
            }
          } catch { /* JSON 解析失败，静默忽略 */ }
        };

        es.onerror = () => {
          es?.close();
          es = null;
          // P2: 3 秒后尝试重连
          reconnectTimer = setTimeout(connect, 3000);
        };
      } catch { /* EventSource 创建失败（如 SSR 环境），静默忽略 */ }
    };

    connect();

    return () => {
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

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
    // autoAssign 模式下 Agent 预选不强制（Manager 可从 211+ 全局 Agent 中匹配）
    const isAutoAssign = crewForm.process === "hierarchical" && crewForm.autoAssign;
    if (!isAutoAssign && crewForm.agents.length < 2) { alert("至少选择 2 个 Agent"); return; }
    if (crewForm.tasks.some((t) => !t.description.trim())) { alert("所有任务必须填写描述"); return; }
    if (crewForm.process === "hierarchical" && !crewForm.managerAgentId) { alert("分层模式必须选择 Manager Agent"); return; }
    setRunning(true);
    setError(null); // G-3: 提交时清除旧错误
    try {
      const body: Record<string, unknown> = {
        name: crewForm.name,
        process: crewForm.process,
        tasks: crewForm.tasks.map((t) => {
          const taskBody: Record<string, unknown> = {
            id: t.id,
            description: t.description,
            expectedOutput: t.expectedOutput || "Task result",
            ...(t.context.length > 0 ? { context: t.context } : {}),
            ...(t.requiredCapabilities && t.requiredCapabilities.length > 0
              ? { requiredCapabilities: t.requiredCapabilities }
              : {}),
          };
          // autoAssign 模式下：允许不传 agentId（由 Manager 自动分配）
          // 非 autoAssign 模式下：保留原有 fallback 行为（未选择则默认第一个 Agent）
          if (isAutoAssign) {
            if (t.agentId) taskBody.agentId = t.agentId;
          } else {
            taskBody.agentId = t.agentId || crewForm.agents[0];
          }
          return taskBody;
        }),
      };
      if (crewForm.process === "hierarchical") {
        body.managerAgentId = crewForm.managerAgentId;
        if (isAutoAssign) {
          body.autoAssign = true;
          body.maxDynamicAgents = crewForm.maxDynamicAgents;
        }
      }
      await apiFetch("/api/collab/crew", { method: "POST", body: JSON.stringify(body) });
      refreshHistory();
    } catch (err: any) {
      // G-3: 设置错误信息，让用户看到失败原因
      setError(err?.message ?? "Crew 执行失败，请重试");
    }
    setRunning(false);
  };

  // ─── 提交 GroupChat ───────────────────────────────────────
  const runGroupChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (gcForm.agents.length < 2) { alert("至少选择 2 个 Agent"); return; }
    if (!gcForm.topic.trim()) { alert("请填写讨论主题"); return; }
    setRunning(true);
    setError(null); // G-3: 提交时清除旧错误
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
      // H-2: manual 模式传递发言顺序
      if (gcForm.selectionMethod === "manual" && gcForm.agents.length >= 2) {
        body.manualSpeakerOrder = gcForm.agents;
      }
      // I-4: graph 模式传递 transitions 配置
      if (gcForm.selectionMethod === "graph" && gcForm.agents.length >= 2) {
        body.graphConfig = {
          transitions: gcForm.graphTransitions ?? {},
          startAgent: gcForm.graphStartAgent ?? gcForm.agents[0],
        };
      }
      await apiFetch("/api/collab/groupchat", { method: "POST", body: JSON.stringify(body) });
      refreshHistory();
    } catch (err: any) {
      // G-3: 设置错误信息，让用户看到失败原因
      setError(err?.message ?? "GroupChat 执行失败，请重试");
    }
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

      {/* G-3: 错误横幅 — 执行失败时显示错误信息 */}
      {error && (
        <div className="rounded-lg border border-red-800/40 bg-red-900/10 p-3 text-sm text-red-400 flex justify-between items-center">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-300 shrink-0">✕</button>
        </div>
      )}

      {/* ═══════════════ Crew 表单 ═══════════════════════════ */}
      {tab === "crew" ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
          <h3 className="font-semibold text-white mb-4">创建 Crew 任务</h3>
          <form onSubmit={runCrew} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>团队名称 <CharCounter current={crewForm.name.length} max={LIMITS.CREW_NAME} /></label>
                <input value={crewForm.name} onChange={(e) => setCrewForm({ ...crewForm, name: e.target.value })} maxLength={LIMITS.CREW_NAME} className={inputCls} />
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

                {/* 智能 Agent 自动分配开关 */}
                <div className="mt-3 flex items-start gap-2">
                  <input
                    id="autoAssign"
                    type="checkbox"
                    checked={crewForm.autoAssign}
                    onChange={(e) => setCrewForm({ ...crewForm, autoAssign: e.target.checked })}
                    className="mt-0.5"
                  />
                  <label htmlFor="autoAssign" className="text-sm text-amber-300 cursor-pointer">
                    由 Manager 智能分配 Agent
                    <p className="text-xs text-zinc-500 mt-0.5">
                      开启后，无 agentId 的任务将由 Manager 从全局 Agent 池匹配或动态创建（继承当前系统模型，无需单独配置）
                    </p>
                  </label>
                </div>

                {crewForm.autoAssign && (
                  <div className="mt-2">
                    <label className="text-xs text-zinc-500">最多动态创建 Agent 数（1-30）</label>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={crewForm.maxDynamicAgents}
                      onChange={(e) => setCrewForm({
                        ...crewForm,
                        maxDynamicAgents: Math.min(30, Math.max(1, Number(e.target.value) || 1)),
                      })}
                      className={`${inputCls} text-sm`}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Agent 分组选择器 */}
            <AgentSelector
              agents={agents}
              selected={crewForm.agents}
              onToggle={(id) => toggleAgent(id, "crew")}
            />

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
                    <div className="relative">
                      <textarea
                        placeholder="任务描述..."
                        value={task.description}
                        onChange={(e) => updateTask(idx, { description: e.target.value })}
                        rows={2}
                        maxLength={LIMITS.TASK_DESC}
                        className={`${inputCls} resize-none text-sm`}
                        required
                      />
                      <div className="text-right mt-0.5"><CharCounter current={task.description.length} max={LIMITS.TASK_DESC} /></div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="text-xs text-zinc-500">预期输出 <CharCounter current={task.expectedOutput.length} max={LIMITS.TASK_OUTPUT} /></label>
                        <input
                          value={task.expectedOutput}
                          onChange={(e) => updateTask(idx, { expectedOutput: e.target.value })}
                          maxLength={LIMITS.TASK_OUTPUT}
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
                          {crewForm.process === "hierarchical" && crewForm.autoAssign ? (
                            <option value="">🤖 Manager 自动分配</option>
                          ) : (
                            <option value="">自动（第一个Agent）</option>
                          )}
                          {crewForm.agents.map((aid) => {
                            const a = agents.find((x) => x.id === aid);
                            return a ? <option key={aid} value={aid}>{a.name}</option> : null;
                          })}
                        </select>
                      </div>
                    </div>
                    {/* P1-1：能力提示标签——仅在 autoAssign 开启时生效，辅助 Manager 匹配/新建 Agent */}
                    {crewForm.process === "hierarchical" && crewForm.autoAssign && (
                      <div>
                        <label className="text-xs text-zinc-500 flex items-center gap-1">
                          能力提示
                          <span className="text-[10px] text-zinc-600">（回车/逗号添加，点击 x 删除）</span>
                        </label>
                        <div className="flex flex-wrap items-center gap-1 mt-1 min-h-[32px] rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5">
                          {(task.requiredCapabilities ?? []).map((cap) => (
                            <span key={cap} className="inline-flex items-center gap-1 rounded bg-amber-600/20 text-amber-300 px-2 py-0.5 text-xs">
                              {cap}
                              <button
                                type="button"
                                onClick={() => {
                                  const next = (task.requiredCapabilities ?? []).filter((c) => c !== cap);
                                  updateTask(idx, { requiredCapabilities: next.length > 0 ? next : undefined });
                                }}
                                className="text-amber-300 hover:text-red-400"
                                aria-label={`删除标签 ${cap}`}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                          <input
                            type="text"
                            placeholder={(task.requiredCapabilities ?? []).length === 0 ? "例：web-search, python, data-analysis" : ""}
                            maxLength={50}
                            className="flex-1 min-w-[120px] bg-transparent text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
                            onKeyDown={(e) => {
                              const input = e.currentTarget;
                              const raw = input.value;
                              // 回车或逗号触发添加；Backspace 在空输入时删除最后一个标签
                              if (e.key === "Enter" || e.key === ",") {
                                e.preventDefault();
                                const trimmed = raw.trim().replace(/,$/, "").trim();
                                if (!trimmed) return;
                                const existing = task.requiredCapabilities ?? [];
                                // 去重（大小写无关）+ 上限 10 个
                                const lower = trimmed.toLowerCase();
                                if (existing.some((c) => c.toLowerCase() === lower)) {
                                  input.value = "";
                                  return;
                                }
                                if (existing.length >= 10) {
                                  input.value = "";
                                  return;
                                }
                                updateTask(idx, { requiredCapabilities: [...existing, trimmed] });
                                input.value = "";
                              } else if (e.key === "Backspace" && raw === "") {
                                const existing = task.requiredCapabilities ?? [];
                                if (existing.length === 0) return;
                                const next = existing.slice(0, -1);
                                updateTask(idx, { requiredCapabilities: next.length > 0 ? next : undefined });
                              }
                            }}
                            onBlur={(e) => {
                              // 失焦时自动提交未按回车的文本
                              const trimmed = e.currentTarget.value.trim();
                              if (!trimmed) return;
                              const existing = task.requiredCapabilities ?? [];
                              const lower = trimmed.toLowerCase();
                              if (existing.some((c) => c.toLowerCase() === lower) || existing.length >= 10) {
                                e.currentTarget.value = "";
                                return;
                              }
                              updateTask(idx, { requiredCapabilities: [...existing, trimmed] });
                              e.currentTarget.value = "";
                            }}
                          />
                        </div>
                      </div>
                    )}
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
              <label className={labelCls}>讨论主题 <CharCounter current={gcForm.topic.length} max={LIMITS.GC_TOPIC} /></label>
              <input value={gcForm.topic} onChange={(e) => setGcForm({ ...gcForm, topic: e.target.value })} maxLength={LIMITS.GC_TOPIC} className={inputCls} required />
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
                  <option value="manual">手动指定</option>
                  <option value="graph">状态机 (Graph)</option>
                  <option value="handoff">Agent自主交接 (Handoff)</option>
                  <option value="random">随机</option>
                </select>
              </div>
            </div>
            {/* Agent 分组选择器 */}
            <AgentSelector
              agents={agents}
              selected={gcForm.agents}
              onToggle={(id) => toggleAgent(id, "gc")}
            />

            {/* H-2/F3: manual 模式 — Agent 发言顺序排列 */}
            {gcForm.selectionMethod === "manual" && gcForm.agents.length >= 2 && (
              <div>
                <label className="block text-sm text-zinc-400 mb-2">发言顺序（上下箭头调整）</label>
                <div className="space-y-1">
                  {gcForm.agents.map((aid, idx) => {
                    const a = agents.find((x) => x.id === aid);
                    return (
                      <div key={aid} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5">
                        <span className="text-xs text-zinc-500 w-5">{idx + 1}.</span>
                        <span className="flex-1 text-sm text-white">{a?.name ?? aid}</span>
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => {
                            const next = [...gcForm.agents];
                            [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                            setGcForm({ ...gcForm, agents: next });
                          }}
                          className="text-zinc-500 hover:text-white disabled:opacity-20 text-xs"
                          title="上移"
                        >▲</button>
                        <button
                          type="button"
                          disabled={idx === gcForm.agents.length - 1}
                          onClick={() => {
                            const next = [...gcForm.agents];
                            [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                            setGcForm({ ...gcForm, agents: next });
                          }}
                          className="text-zinc-500 hover:text-white disabled:opacity-20 text-xs"
                          title="下移"
                        >▼</button>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-1 text-xs text-zinc-600">Agent 将按此顺序循环发言</p>
              </div>
            )}

            {/* I-4/F1: graph 模式 — transitions 邻接表配置 */}
            {gcForm.selectionMethod === "graph" && gcForm.agents.length >= 2 && (
              <div>
                <label className="block text-sm text-zinc-400 mb-2">状态机转移规则</label>
                <div className="space-y-2">
                  {gcForm.agents.map((aid) => {
                    const a = agents.find((x) => x.id === aid);
                    const others = gcForm.agents.filter((id) => id !== aid);
                    return (
                      <div key={aid} className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                        <span className="text-sm text-white">{a?.name ?? aid}</span>
                        <span className="text-xs text-zinc-500 ml-2">→ 可转移到：</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {others.map((oid) => {
                            const o = agents.find((x) => x.id === oid);
                            const transitions = gcForm.graphTransitions ?? {};
                            const selected = (transitions[aid] ?? []).includes(oid);
                            return (
                              <button
                                key={oid} type="button"
                                onClick={() => {
                                  const t = { ...(gcForm.graphTransitions ?? {}) };
                                  if (!t[aid]) t[aid] = [];
                                  if (selected) t[aid] = t[aid].filter((x: string) => x !== oid);
                                  else t[aid] = [...t[aid], oid];
                                  setGcForm({ ...gcForm, graphTransitions: t });
                                }}
                                className={`rounded px-2 py-0.5 text-xs transition-colors ${selected ? "bg-green-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}
                              >
                                {o?.name ?? oid}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2">
                  <label className="text-xs text-zinc-500">起始发言者</label>
                  <select
                    value={gcForm.graphStartAgent ?? gcForm.agents[0] ?? ""}
                    onChange={(e) => setGcForm({ ...gcForm, graphStartAgent: e.target.value })}
                    className={`${inputCls} text-sm`}
                  >
                    {gcForm.agents.map((aid) => {
                      const a = agents.find((x) => x.id === aid);
                      return <option key={aid} value={aid}>{a?.name ?? aid}</option>;
                    })}
                  </select>
                </div>
              </div>
            )}

            {/* I-4/F1: handoff 模式 — 使用说明 */}
            {gcForm.selectionMethod === "handoff" && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2">
                <p className="text-xs text-zinc-400">
                  💡 Agent 在回复中包含 <code className="text-yellow-400">[HANDOFF:AgentName]</code> 即可指定下一位发言者。未包含时按轮流顺序继续。
                </p>
              </div>
            )}

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
                    <label className="text-xs text-zinc-500">系统消息 <CharCounter current={gcForm.systemMessage.length} max={LIMITS.GC_SYSTEM_MSG} /></label>
                    <textarea
                      value={gcForm.systemMessage}
                      onChange={(e) => setGcForm({ ...gcForm, systemMessage: e.target.value })}
                      rows={2}
                      maxLength={LIMITS.GC_SYSTEM_MSG}
                      className={`${inputCls} text-sm resize-none`}
                      placeholder="可选：为参与Agent提供对话背景..."
                    />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500">终止关键词 <CharCounter current={gcForm.terminationKeyword.length} max={LIMITS.TERM_KEYWORD} /></label>
                    <input
                      value={gcForm.terminationKeyword}
                      onChange={(e) => setGcForm({ ...gcForm, terminationKeyword: e.target.value })}
                      maxLength={LIMITS.TERM_KEYWORD}
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
              const isTaskRunning = runningTaskIds.has(id);
              const isCancelling = cancellingIds.has(id);
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
                      ) : r.status === "cancelled" ? (
                        <StopCircle className="h-5 w-5 text-yellow-500 shrink-0" />
                      ) : r.status === "failed" || r.status === "error" ? (
                        <XCircle className="h-5 w-5 text-red-500 shrink-0" />
                      ) : (
                        <Loader2 className="h-5 w-5 text-blue-400 animate-spin shrink-0" />
                      )}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-white">{r.name || (crew ? "Crew" : "GroupChat")}</span>
                          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${crew ? "bg-blue-600/20 text-blue-400" : "bg-purple-600/20 text-purple-400"}`}>
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
                        {/* G-2: SSE 实时进度显示 */}
                        {isTaskRunning && liveProgress[id] && (
                          <p className="text-xs text-blue-400 mt-0.5 truncate max-w-xs">{liveProgress[id]}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* E-3: 运行中任务显示取消按钮 */}
                      {isTaskRunning && (
                        <button
                          onClick={(e) => { e.stopPropagation(); cancelTask(id); }}
                          disabled={isCancelling}
                          className="flex items-center gap-1 rounded-lg border border-red-800 bg-red-900/30 px-2 py-1 text-xs text-red-400 hover:bg-red-900/60 disabled:opacity-50 transition-colors"
                          title="取消执行"
                        >
                          {isCancelling
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <StopCircle className="h-3 w-3" />
                          }
                          取消
                        </button>
                      )}
                      <span className={`rounded px-2 py-0.5 text-xs ${
                        r.status === "completed" || r.status === "terminated" || r.status === "max_turns"
                          ? "bg-green-600/10 text-green-400"
                          : r.status === "cancelled"
                            ? "bg-yellow-600/10 text-yellow-400"
                            : "bg-red-600/10 text-red-400"
                      }`}>
                        {r.status === "cancelled" ? "已取消" : r.status}
                      </span>
                    </div>
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

          {/* 下载按钮组（有 workspaceDir 时显示） */}
          {selectedResult.workspaceDir && (
            <div className="flex gap-2 mb-1">
              <a
                href={`${API_BASE}/api/collab/download/${getItemId(selectedResult)}`}
                download
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
              >
                <Download className="h-3.5 w-3.5" /> 下载全部(ZIP)
              </a>
            </div>
          )}

          {/* 全部产出文件汇总 */}
          {selectedResult.allAttachments && selectedResult.allAttachments.length > 0 && (
            <div className="rounded-lg border border-amber-800/30 bg-amber-900/10 p-3">
              <h5 className="text-xs font-medium text-amber-400 mb-2 flex items-center gap-1">
                <Paperclip className="h-3.5 w-3.5" />
                全部产出文件 ({selectedResult.allAttachments.length})
              </h5>
              <AttachmentList attachments={selectedResult.allAttachments} />
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
                  <ExpandableText text={to.output} />
                  <AttachmentList attachments={to.attachments} />
                </div>
              ))}
              {selectedResult.finalOutput && (
                <div className="rounded-lg border border-green-800/30 bg-green-900/10 p-3">
                  <h5 className="text-xs font-medium text-green-400 mb-1">最终输出</h5>
                  <ExpandableText text={selectedResult.finalOutput} />
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
                      <span className={`rounded px-1 py-0.5 text-xs ${msg.role === "system" ? "bg-zinc-700 text-zinc-400" : "bg-zinc-800 text-zinc-500"}`}>
                        {msg.role}
                      </span>
                    </div>
                    <ExpandableText text={msg.content} maxLen={300} />
                    <AttachmentList attachments={msg.attachments} />
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
