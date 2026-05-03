"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/utils";
import {
  Globe, ListTodo, Bell, Bug, RefreshCw, Loader2,
  CheckCircle, XCircle, AlertTriangle, Zap, Wifi, WifiOff,
} from "lucide-react";
import { FeatureBanner } from "@/components/ui/feature-banner";

// ─── 类型定义 ──────────────────────────────────────────────────

interface AgentCardInfo {
  name: string;
  description: string;
  skills: { id: string; name: string; description: string; tags: string[] }[];
  capabilities: { streaming: boolean; pushNotifications: boolean };
  a2aEnabled: boolean;
}

interface RemoteAgent {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: { streaming?: boolean; pushNotifications?: boolean };
  skills: { id: string; name: string; description: string }[];
}

interface A2ATask {
  id: string;
  contextId: string;
  status: { state: string; timestamp: string; message?: unknown };
  artifacts: unknown[];
  history: unknown[];
}

// ─── Tab 定义 ──────────────────────────────────────────────────

const TABS = [
  { id: "registry", label: "注册表", icon: Globe },
  { id: "tasks", label: "任务", icon: ListTodo },
  { id: "card", label: "Agent Card", icon: Zap },
  { id: "debug", label: "调试", icon: Bug },
] as const;

type TabId = (typeof TABS)[number]["id"];

// ─── 状态颜色映射 ──────────────────────────────────────────────

const STATE_COLORS: Record<string, string> = {
  submitted: "text-blue-400 bg-blue-900/30",
  working: "text-yellow-400 bg-yellow-900/30",
  completed: "text-green-400 bg-green-900/30",
  failed: "text-red-400 bg-red-900/30",
  canceled: "text-zinc-400 bg-zinc-800/50",
  rejected: "text-orange-400 bg-orange-900/30",
  "input-required": "text-purple-400 bg-purple-900/30",
  "auth-required": "text-pink-400 bg-pink-900/30",
};

// ═══════════════════════════════════════════════════════════════
// 主页面组件
// ═══════════════════════════════════════════════════════════════

export default function A2APage() {
  const [activeTab, setActiveTab] = useState<TabId>("registry");

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="max-w-6xl mx-auto">
        {/* 标题 */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Globe className="h-6 w-6 text-blue-400" />
            A2A 协议管理
          </h1>
          <p className="text-zinc-500 text-sm mt-1">
            Agent-to-Agent 协议状态、远端 Agent 注册表与任务监控
          </p>
        </div>

        <FeatureBanner
          pageId="a2a"
          icon={Globe}
          title="A2A 协议管理"
          description="A2A（Agent-to-Agent）协议让多个 Agent 节点之间可以相互发现、发送消息和协作完成任务。通过 A2A，你可以构建分布式的多 Agent 系统。"
          useCases={[
            "多节点协作：不同机器上的 Agent 通过 A2A 协议通信协作",
            "远端 Agent 发现：自动发现网络中注册的其他 Agent 节点及其技能",
            "任务委托：将复杂任务拆解后分发给不同的远端 Agent 执行",
            "调试测试：通过调试面板直接向远端 Agent 发送测试消息",
          ]}
          tips={[
            "设置环境变量 ENABLE_A2A=true 启用协议支持",
            "Agent Card 展示当前节点对外暴露的能力和技能列表",
          ]}
        />

        {/* Tab 栏 */}
        <div className="flex gap-1 border-b border-zinc-800 mb-6">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? "border-blue-500 text-blue-400"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab 内容 */}
        {activeTab === "registry" && <RegistryTab />}
        {activeTab === "tasks" && <TasksTab />}
        {activeTab === "card" && <CardTab />}
        {activeTab === "debug" && <DebugTab />}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Tab 1: 远端 Agent 注册表
// ═══════════════════════════════════════════════════════════════

function RegistryTab() {
  const [agents, setAgents] = useState<RemoteAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ agents: RemoteAgent[]; enabled: boolean }>("/api/a2a/registry");
      setAgents(res.agents || []);
      setEnabled(res.enabled);
    } catch { setAgents([]); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingSpinner />;

  if (!enabled) {
    return (
      <EmptyState
        icon={WifiOff}
        title="A2A 未启用"
        description="设置环境变量 ENABLE_A2A=true 以启用 Agent-to-Agent 协议"
      />
    );
  }

  if (agents.length === 0) {
    return (
      <div>
        <div className="flex justify-end mb-4">
          <RefreshButton onClick={load} />
        </div>
        <EmptyState
          icon={Globe}
          title="暂无远端 Agent"
          description="尚未有远端 Agent 注册到本节点。远端 Agent 可通过 A2A 注册接口注册。"
        />
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <span className="text-sm text-zinc-500">{agents.length} 个远端 Agent</span>
        <RefreshButton onClick={load} />
      </div>
      <div className="grid gap-3">
        {agents.map((agent, i) => (
          <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-medium text-zinc-100">{agent.name}</h3>
                <p className="text-sm text-zinc-500 mt-0.5">{agent.description}</p>
              </div>
              <div className="flex items-center gap-2">
                {agent.capabilities?.streaming && (
                  <span className="text-xs px-2 py-0.5 rounded bg-blue-900/30 text-blue-400">流式</span>
                )}
                <Wifi className="h-4 w-4 text-green-500" />
              </div>
            </div>
            <div className="mt-2 text-xs text-zinc-600">
              <span className="font-mono">{agent.url}</span>
              {agent.version && <span className="ml-3">v{agent.version}</span>}
            </div>
            {agent.skills?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {agent.skills.map((s, j) => (
                  <span key={j} className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                    {s.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Tab 2: Task 列表
// ═══════════════════════════════════════════════════════════════

function TasksTab() {
  const [tasks, setTasks] = useState<A2ATask[]>([]);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [stateFilter, setStateFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = stateFilter ? `?state=${stateFilter}&limit=50` : "?limit=50";
      const res = await apiFetch<{ tasks: A2ATask[]; enabled: boolean }>(`/api/a2a/tasks${query}`);
      setTasks(res.tasks || []);
      setEnabled(res.enabled);
    } catch { setTasks([]); }
    setLoading(false);
  }, [stateFilter]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingSpinner />;

  if (!enabled) {
    return (
      <EmptyState
        icon={WifiOff}
        title="A2A 未启用"
        description="设置环境变量 ENABLE_A2A=true 以启用 Task 管理"
      />
    );
  }

  const states = ["", "submitted", "working", "completed", "failed", "canceled"];

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <div className="flex gap-1">
          {states.map((s) => (
            <button
              key={s}
              onClick={() => setStateFilter(s)}
              className={`text-xs px-2.5 py-1 rounded transition-colors ${
                stateFilter === s
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {s || "全部"}
            </button>
          ))}
        </div>
        <RefreshButton onClick={load} />
      </div>

      {tasks.length === 0 ? (
        <EmptyState icon={ListTodo} title="暂无 Task" description="A2A 任务将在此显示" />
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => (
            <div key={task.id} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-zinc-500">{task.id.slice(0, 8)}...</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${STATE_COLORS[task.status.state] || "bg-zinc-800 text-zinc-400"}`}>
                    {task.status.state}
                  </span>
                </div>
                <span className="text-xs text-zinc-600">
                  {new Date(task.status.timestamp).toLocaleString()}
                </span>
              </div>
              <div className="mt-1 text-xs text-zinc-600">
                context: {task.contextId.slice(0, 12)}...
                {task.artifacts.length > 0 && <span className="ml-3">产物: {task.artifacts.length}</span>}
                {task.history.length > 0 && <span className="ml-3">消息: {task.history.length}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Tab 3: Agent Card 预览
// ═══════════════════════════════════════════════════════════════

function CardTab() {
  const [card, setCard] = useState<AgentCardInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<AgentCardInfo>("/api/a2a/card");
      setCard(res);
    } catch { setCard(null); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingSpinner />;
  if (!card) return <EmptyState icon={AlertTriangle} title="无法获取 Agent Card" description="API 服务可能未启动" />;

  return (
    <div>
      <div className="flex justify-end mb-4">
        <RefreshButton onClick={load} />
      </div>

      {/* 基本信息 */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 mb-4">
        <h3 className="text-lg font-medium">{card.name}</h3>
        <p className="text-sm text-zinc-500 mt-1">{card.description}</p>
        <div className="flex gap-3 mt-3">
          <StatusBadge
            active={card.a2aEnabled}
            label={card.a2aEnabled ? "A2A 已启用" : "A2A 未启用"}
          />
          <StatusBadge
            active={card.capabilities.streaming}
            label={card.capabilities.streaming ? "支持流式" : "无流式"}
          />
          <StatusBadge
            active={card.capabilities.pushNotifications}
            label={card.capabilities.pushNotifications ? "支持推送" : "无推送"}
          />
        </div>
      </div>

      {/* 技能列表 */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <h4 className="text-sm font-medium text-zinc-400 mb-3">
          已加载技能 ({card.skills.length})
        </h4>
        {card.skills.length === 0 ? (
          <p className="text-sm text-zinc-600">暂无已加载技能</p>
        ) : (
          <div className="grid gap-2">
            {card.skills.map((skill) => (
              <div key={skill.id} className="flex items-start gap-2 py-1.5 border-b border-zinc-800/50 last:border-0">
                <Zap className="h-3.5 w-3.5 text-yellow-500 mt-0.5 shrink-0" />
                <div>
                  <span className="text-sm text-zinc-200">{skill.name}</span>
                  {skill.description && (
                    <p className="text-xs text-zinc-600 mt-0.5">{skill.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Tab 4: 调试面板
// ═══════════════════════════════════════════════════════════════

function DebugTab() {
  const [targetUrl, setTargetUrl] = useState("");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!targetUrl || !message) return;
    setSending(true);
    setResult(null);
    try {
      // 直接向目标 Agent 发送 A2A JSON-RPC 请求
      const resp = await fetch(`${targetUrl}/a2a`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "SendMessage",
          params: {
            message: {
              messageId: `test-${Date.now()}`,
              role: "user",
              parts: [{ type: "text", text: message }],
            },
          },
        }),
      });
      const data = await resp.json();
      setResult(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setResult(`错误: ${err.message}`);
    }
    setSending(false);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <h4 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
          <Bug className="h-4 w-4" />
          向远端 Agent 发送测试消息
        </h4>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">目标 Agent URL</label>
            <input
              type="text"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="http://remote-agent:3001"
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-md text-sm text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-blue-600"
            />
          </div>
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">消息内容</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="输入要发送的测试消息..."
              rows={3}
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-md text-sm text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-blue-600 resize-none"
            />
          </div>
          <button
            onClick={handleSend}
            disabled={sending || !targetUrl || !message}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            发送
          </button>
        </div>
      </div>

      {result && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
          <h4 className="text-xs text-zinc-500 mb-2">响应结果</h4>
          <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono bg-zinc-950 p-3 rounded-md overflow-auto max-h-64">
            {result}
          </pre>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 通用组件
// ═══════════════════════════════════════════════════════════════

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
    </div>
  );
}

function EmptyState({ icon: Icon, title, description }: { icon: any; title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Icon className="h-10 w-10 text-zinc-700 mb-3" />
      <h3 className="text-sm font-medium text-zinc-400">{title}</h3>
      <p className="text-xs text-zinc-600 mt-1 max-w-xs">{description}</p>
    </div>
  );
}

function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800/50 hover:bg-zinc-800 rounded-md transition-colors"
    >
      <RefreshCw className="h-3.5 w-3.5" />
      刷新
    </button>
  );
}

function StatusBadge({ active, label }: { active: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded ${
      active ? "bg-green-900/30 text-green-400" : "bg-zinc-800 text-zinc-500"
    }`}>
      {active ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </span>
  );
}
