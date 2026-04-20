"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import {
  Plug, Plus, Trash2, CheckCircle, XCircle, Wrench, Loader2, Play,
  Search, Download, Package, Globe, Star, ExternalLink, Shield, Clock,
  RefreshCw, AlertTriangle,
} from "lucide-react";
import { showToast } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────────

interface MCPServer {
  id: string;
  config: {
    name: string;
    transport: string;
    command?: string;
    url?: string;
    args?: string[];
  };
  status: string;
  tools: unknown[];
  error?: string;
}

interface MCPTool {
  name: string;
  description: string;
  serverName: string;
  serverId: string;
  inputSchema?: Record<string, unknown>;
}

interface MCPMarketEntry {
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  repository?: string;
  isOfficial: boolean;
  publishedAt?: string;
  updatedAt?: string;
  npmPackage?: string;
  dockerImage?: string;
  transportType: string;
  packages: Array<{
    registryType: string;
    identifier: string;
    version?: string;
    transport: { type: string };
    environmentVariables?: Array<{
      name: string;
      description?: string;
      isRequired?: boolean;
      isSecret?: boolean;
    }>;
  }>;
  envVars: Array<{
    name: string;
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
  }>;
}

type TabType = "servers" | "marketplace";

// ─── Main Page ──────────────────────────────────────────────

export default function MCPPage() {
  const [tab, setTab] = useState<TabType>("servers");
  // 用于跨 Tab 通知刷新：市场安装后通知 ServersTab 刷新
  const [refreshKey, setRefreshKey] = useState(0);
  const triggerRefresh = () => setRefreshKey((k) => k + 1);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">MCP 工具</h1>
          <p className="mt-1 text-zinc-400">管理 Model Context Protocol 服务器和工具</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg bg-zinc-900/50 p-1 border border-zinc-800">
        <button
          onClick={() => setTab("servers")}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            tab === "servers"
              ? "bg-zinc-800 text-white"
              : "text-zinc-400 hover:text-zinc-300"
          }`}
        >
          <Plug className="mr-2 inline h-4 w-4" /> 我的服务器
        </button>
        <button
          onClick={() => setTab("marketplace")}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            tab === "marketplace"
              ? "bg-zinc-800 text-white"
              : "text-zinc-400 hover:text-zinc-300"
          }`}
        >
          <Search className="mr-2 inline h-4 w-4" /> MCP 市场
        </button>
      </div>

      {tab === "servers" ? (
        <ServersTab refreshKey={refreshKey} />
      ) : (
        <MarketplaceTab
          onInstalled={() => {
            triggerRefresh();
            setTab("servers");
          }}
        />
      )}
    </div>
  );
}

// ─── Servers Tab ────────────────────────────────────────────

function ServersTab({ refreshKey }: { refreshKey: number }) {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [tools, setTools] = useState<MCPTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedTool, setSelectedTool] = useState<MCPTool | null>(null);
  const [testArgs, setTestArgs] = useState("{}");
  const [testResult, setTestResult] = useState("");
  const [testing, setTesting] = useState(false);
  const [form, setForm] = useState({
    name: "",
    transport: "stdio" as string,
    command: "",
    args: "",
    url: "",
    env: "{}",
  });

  const [reconnecting, setReconnecting] = useState<string | null>(null);

  const fetchServers = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch<{ servers: MCPServer[] }>("/api/mcp/servers").catch(() => ({ servers: [] })),
      apiFetch<{ tools: MCPTool[] }>("/api/mcp/tools").catch(() => ({ tools: [] })),
    ]).then(([s, t]) => {
      setServers(s.servers ?? []);
      setTools(t.tools ?? []);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchServers(); }, [fetchServers, refreshKey]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    let env = {};
    try { env = JSON.parse(form.env); } catch { /* ignore invalid JSON */ }
    await apiFetch("/api/mcp/servers", {
      method: "POST",
      body: JSON.stringify({
        name: form.name,
        transport: form.transport,
        command: form.transport === "stdio" ? form.command : undefined,
        args: form.transport === "stdio" ? form.args.split(" ").filter(Boolean) : undefined,
        url: form.transport !== "stdio" ? form.url : undefined,
        env,
      }),
    });
    setShowAdd(false);
    setForm({ name: "", transport: "stdio", command: "", args: "", url: "", env: "{}" });
    fetchServers();
  };

  const handleReconnect = async (id: string) => {
    setReconnecting(id);
    try {
      const result = await apiFetch<{ status: string; error?: string; tools?: number }>(
        `/api/mcp/servers/${id}/reconnect`,
        { method: "POST" }
      );
      if (result.error) {
        showToast(`重连失败: ${result.error}`, "error");
      } else {
        showToast(`重连成功，发现 ${result.tools ?? 0} 个工具`, "success");
      }
    } catch (err: any) {
      showToast(`重连失败: ${err.message}`, "error");
    }
    setReconnecting(null);
    fetchServers();
  };

  const handleRemove = async (id: string) => {
    if (!confirm("确定移除该 MCP 服务器？")) return;
    await apiFetch(`/api/mcp/servers/${id}`, { method: "DELETE" });
    fetchServers();
  };

  const handleTestTool = async () => {
    if (!selectedTool) return;
    setTesting(true);
    setTestResult("");
    try {
      let args = {};
      try { args = JSON.parse(testArgs); } catch { /* ignore */ }
      const result = await apiFetch<{ result: unknown }>("/api/mcp/tools/call", {
        method: "POST",
        body: JSON.stringify({ serverId: selectedTool.serverId, toolName: selectedTool.name, args }),
      });
      setTestResult(JSON.stringify(result, null, 2));
    } catch (err: any) {
      setTestResult(`错误: ${err.message}`);
    }
    setTesting(false);
  };

  return (
    <>
      {/* Header */}
      <div className="flex justify-end">
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700">
          <Plus className="h-4 w-4" /> 添加服务器
        </button>
      </div>

      {/* Servers */}
      <div>
        <h2 className="mb-3 text-lg font-semibold text-white">已注册服务器</h2>
        {loading ? (
          <div className="py-8 text-center text-zinc-500">加载中...</div>
        ) : servers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-700 p-8 text-center">
            <Plug className="mx-auto h-10 w-10 text-zinc-600" />
            <p className="mt-3 text-zinc-400">暂无 MCP 服务器</p>
            <p className="mt-1 text-sm text-zinc-600">添加 MCP 服务器或从市场一键安装</p>
          </div>
        ) : (
          <div className="space-y-3">
            {servers.map((s) => (
              <div key={s.id} className="group flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="flex items-center gap-4">
                  {s.status === "connected" ? (
                    <CheckCircle className="h-5 w-5 flex-shrink-0 text-green-500" />
                  ) : s.status === "connecting" ? (
                    <Loader2 className="h-5 w-5 flex-shrink-0 text-blue-400 animate-spin" />
                  ) : s.status === "error" ? (
                    <XCircle className="h-5 w-5 flex-shrink-0 text-red-500" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 flex-shrink-0 text-yellow-500" />
                  )}
                  <div>
                    <h3 className="font-medium text-white">{s.config?.name ?? s.id}</h3>
                    <div className="flex flex-wrap gap-3 text-xs text-zinc-500">
                      <span>传输: {s.config?.transport ?? "unknown"}</span>
                      {s.config?.command && (
                        <span className="font-mono">
                          {s.config.command} {(s.config.args ?? []).join(" ")}
                        </span>
                      )}
                      {s.status === "connected" && s.tools?.length > 0 && (
                        <span className="text-green-400">{s.tools.length} 个工具</span>
                      )}
                    </div>
                    {s.error && (
                      <p className="mt-1 text-xs text-red-400 max-w-lg truncate" title={s.error}>
                        错误: {s.error}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-1 items-center">
                  {/* 重连按钮（非 connected 状态时显示） */}
                  {s.status !== "connected" && (
                    <button
                      onClick={() => handleReconnect(s.id)}
                      disabled={reconnecting === s.id}
                      className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-blue-400 disabled:opacity-50"
                      title="重新连接"
                    >
                      {reconnecting === s.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                    </button>
                  )}
                  <button
                    onClick={() => handleRemove(s.id)}
                    className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-red-400 opacity-0 group-hover:opacity-100"
                    title="删除服务器"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tools */}
      <div>
        <h2 className="mb-3 text-lg font-semibold text-white">可用工具 ({tools.length})</h2>
        {tools.length === 0 ? (
          <p className="text-sm text-zinc-500">无可用 MCP 工具</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tools.map((tool) => (
              <div
                key={tool.name}
                onClick={() => { setSelectedTool(tool); setTestResult(""); setTestArgs("{}"); }}
                className={`cursor-pointer rounded-xl border p-4 transition-colors ${
                  selectedTool?.name === tool.name ? "border-blue-600 bg-blue-600/5" : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Wrench className="h-4 w-4 text-blue-400" />
                  <h4 className="font-medium text-white text-sm">{tool.name}</h4>
                </div>
                <p className="mt-1 text-xs text-zinc-500 line-clamp-2">{tool.description}</p>
                <span className="mt-2 inline-block text-xs text-zinc-600">{tool.serverName}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tool Test Panel */}
      {selectedTool && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
          <h3 className="font-semibold text-white mb-2 flex items-center gap-2">
            <Play className="h-4 w-4 text-blue-400" /> 测试工具: {selectedTool.name}
          </h3>
          <p className="text-sm text-zinc-400 mb-4">{selectedTool.description}</p>
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-zinc-400 mb-1">参数 (JSON)</label>
              <textarea
                value={testArgs}
                onChange={(e) => setTestArgs(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white font-mono text-sm focus:border-blue-500 focus:outline-none resize-none"
              />
            </div>
            <button
              onClick={handleTestTool}
              disabled={testing}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              执行
            </button>
            {testResult && (
              <pre className="max-h-48 overflow-auto rounded-lg bg-zinc-950 p-4 text-xs text-zinc-300 font-mono">{testResult}</pre>
            )}
          </div>
        </div>
      )}

      {/* Add Server Modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowAdd(false)}>
          <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-white mb-4">添加 MCP 服务器</h2>
            <form onSubmit={handleAdd} className="space-y-4">
              <div>
                <label className="block text-sm text-zinc-400 mb-1">名称</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none" required />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">传输方式</label>
                <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value })} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none">
                  <option value="stdio">stdio (本地进程)</option>
                  <option value="sse">SSE (HTTP)</option>
                  <option value="streamable-http">Streamable HTTP</option>
                </select>
              </div>
              {form.transport === "stdio" ? (
                <>
                  <div>
                    <label className="block text-sm text-zinc-400 mb-1">命令</label>
                    <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx" className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none" required />
                  </div>
                  <div>
                    <label className="block text-sm text-zinc-400 mb-1">参数</label>
                    <input value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder="-y @modelcontextprotocol/server-filesystem /" className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white font-mono text-sm focus:border-blue-500 focus:outline-none" />
                  </div>
                </>
              ) : (
                <div>
                  <label className="block text-sm text-zinc-400 mb-1">服务器 URL</label>
                  <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="http://localhost:8080/sse" className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none" required />
                </div>
              )}
              <div>
                <label className="block text-sm text-zinc-400 mb-1">环境变量 (JSON, 可选)</label>
                <textarea value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} rows={2} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white font-mono text-sm focus:border-blue-500 focus:outline-none resize-none" />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowAdd(false)} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-900">取消</button>
                <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">添加</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Marketplace Tab ────────────────────────────────────────

function MarketplaceTab({ onInstalled }: { onInstalled: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MCPMarketEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<{
    id: string;
    success: boolean;
    message: string;
  } | null>(null);
  const [showEnvModal, setShowEnvModal] = useState<MCPMarketEntry | null>(null);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    setInstallResult(null);
    try {
      const data = await apiFetch<{ servers: MCPMarketEntry[]; count: number }>(
        `/api/mcp/marketplace/search?q=${encodeURIComponent(query.trim())}&limit=20`
      );
      setResults(data.servers ?? []);
    } catch {
      setResults([]);
    }
    setLoading(false);
  }, [query]);

  const handleInstall = async (entry: MCPMarketEntry, env?: Record<string, string>) => {
    setInstalling(entry.id);
    setInstallResult(null);
    setShowEnvModal(null);
    try {
      const result = await apiFetch<{
        id: string;
        name: string;
        status: string;
        connectError?: string;
      }>("/api/mcp/marketplace/install", {
        method: "POST",
        body: JSON.stringify({ entry, env: env ?? {} }),
      });
      if (result.connectError) {
        // 注册成功但连接失败：黄色警告
        setInstallResult({
          id: entry.id,
          success: true,
          message: `已注册但连接失败: ${result.connectError}。可在“我的服务器”中重连。`,
        });
        showToast(`${entry.displayName} 已注册，但连接失败`, "info");
      } else {
        setInstallResult({
          id: entry.id,
          success: true,
          message: `安装成功! 状态: ${result.status}`,
        });
        showToast(`${entry.displayName} 安装成功`, "success");
      }
      // 安装后通知父组件刷新并切换到服务器 Tab
      onInstalled();
    } catch (err: any) {
      setInstallResult({
        id: entry.id,
        success: false,
        message: `安装失败: ${err.message}`,
      });
    }
    setInstalling(null);
  };

  const startInstall = (entry: MCPMarketEntry) => {
    const requiredEnvVars = (entry.envVars ?? []).filter((v) => v.isRequired);
    if (requiredEnvVars.length > 0) {
      const defaults: Record<string, string> = {};
      for (const v of entry.envVars ?? []) defaults[v.name] = "";
      setEnvValues(defaults);
      setShowEnvModal(entry);
    } else {
      handleInstall(entry);
    }
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return "";
    try {
      return new Date(dateStr).toLocaleDateString("zh-CN");
    } catch {
      return "";
    }
  };

  return (
    <>
      {/* Search Bar */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="搜索 MCP 服务器 (如 filesystem, playwright, github...)"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-10 pr-4 py-2.5 text-white placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={loading || !query.trim()}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          搜索
        </button>
      </div>

      {/* Install Result Toast */}
      {installResult && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            !installResult.success
              ? "border-red-800 bg-red-900/20 text-red-400"
              : installResult.message.includes("连接失败")
                ? "border-yellow-800 bg-yellow-900/20 text-yellow-400"
                : "border-green-800 bg-green-900/20 text-green-400"
          }`}
        >
          {!installResult.success ? (
            <XCircle className="mr-2 inline h-4 w-4" />
          ) : installResult.message.includes("连接失败") ? (
            <AlertTriangle className="mr-2 inline h-4 w-4" />
          ) : (
            <CheckCircle className="mr-2 inline h-4 w-4" />
          )}
          {installResult.message}
        </div>
      )}

      {/* Results */}
      {!searched ? (
        <div className="rounded-xl border border-dashed border-zinc-700 p-12 text-center">
          <Globe className="mx-auto h-12 w-12 text-zinc-600" />
          <p className="mt-4 text-zinc-400">搜索官方 MCP Registry 发现可用的 MCP 服务器</p>
          <p className="mt-1 text-sm text-zinc-600">
            数据源: registry.modelcontextprotocol.io
          </p>
        </div>
      ) : loading ? (
        <div className="py-12 text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-blue-500" />
          <p className="mt-3 text-zinc-400">搜索中...</p>
        </div>
      ) : results.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 p-8 text-center">
          <Search className="mx-auto h-10 w-10 text-zinc-600" />
          <p className="mt-3 text-zinc-400">未找到匹配的 MCP 服务器</p>
          <p className="mt-1 text-sm text-zinc-600">
            尝试其他关键词，如 filesystem、database、search
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-zinc-500">找到 {results.length} 个 MCP 服务器</p>
          <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
            {results.map((entry) => (
              <div
                key={entry.id}
                className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 hover:border-zinc-700 transition-colors"
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Package className="h-5 w-5 flex-shrink-0 text-blue-400" />
                      <h3 className="font-semibold text-white truncate">
                        {entry.displayName}
                      </h3>
                      {entry.isOfficial && (
                        <span className="flex-shrink-0 rounded bg-green-900/30 px-1.5 py-0.5 text-[10px] font-medium text-green-400 border border-green-800/50">
                          <Shield className="mr-0.5 inline h-3 w-3" />
                          认证
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-600 font-mono truncate">
                      {entry.name}
                    </p>
                  </div>
                  <button
                    onClick={() => startInstall(entry)}
                    disabled={installing === entry.id}
                    className="flex-shrink-0 flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {installing === entry.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    安装
                  </button>
                </div>

                {/* Description */}
                <p className="mt-2 text-sm text-zinc-400 line-clamp-2">
                  {entry.description || "暂无描述"}
                </p>

                {/* Meta Info */}
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                  <span className="flex items-center gap-1">
                    <Star className="h-3 w-3" /> v{entry.version}
                  </span>
                  <span className="flex items-center gap-1">
                    <Plug className="h-3 w-3" /> {entry.transportType}
                  </span>
                  {entry.npmPackage && (
                    <span className="flex items-center gap-1 font-mono">
                      <Package className="h-3 w-3" /> {entry.npmPackage}
                    </span>
                  )}
                  {entry.dockerImage && (
                    <span className="flex items-center gap-1 font-mono">
                      docker: {entry.dockerImage}
                    </span>
                  )}
                  {entry.updatedAt && (
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {formatDate(entry.updatedAt)}
                    </span>
                  )}
                  {entry.repository && (
                    <a
                      href={entry.repository}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-blue-400 hover:text-blue-300"
                    >
                      <ExternalLink className="h-3 w-3" /> 仓库
                    </a>
                  )}
                </div>

                {/* Env Vars Hint */}
                {(entry.envVars ?? []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(entry.envVars ?? []).map((v) => (
                      <span
                        key={v.name}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
                          v.isRequired
                            ? "bg-amber-900/20 text-amber-400 border border-amber-800/40"
                            : "bg-zinc-800 text-zinc-500"
                        }`}
                      >
                        {v.name}
                        {v.isRequired && " *"}
                      </span>
                    ))}
                  </div>
                )}

                {/* Per-entry install result */}
                {installResult?.id === entry.id && (
                  <div
                    className={`mt-2 rounded px-3 py-2 text-xs ${
                      installResult.success
                        ? "bg-green-900/10 text-green-400"
                        : "bg-red-900/10 text-red-400"
                    }`}
                  >
                    {installResult.message}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Env Variables Modal */}
      {showEnvModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowEnvModal(null)}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-white mb-1">配置环境变量</h2>
            <p className="text-sm text-zinc-400 mb-4">
              {showEnvModal.displayName} 需要以下环境变量才能正常运行
            </p>
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {(showEnvModal.envVars ?? []).map((v) => (
                <div key={v.name}>
                  <label className="flex items-center gap-1 text-sm text-zinc-400 mb-1">
                    <span className="font-mono">{v.name}</span>
                    {v.isRequired && <span className="text-amber-400">*</span>}
                    {v.isSecret && (
                      <span className="text-xs text-zinc-600">(密钥)</span>
                    )}
                  </label>
                  {v.description && (
                    <p className="text-xs text-zinc-600 mb-1">{v.description}</p>
                  )}
                  <input
                    type={v.isSecret ? "password" : "text"}
                    value={envValues[v.name] ?? ""}
                    onChange={(e) =>
                      setEnvValues({ ...envValues, [v.name]: e.target.value })
                    }
                    placeholder={v.isRequired ? "必填" : "可选"}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white font-mono text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-3 pt-4">
              <button
                onClick={() => setShowEnvModal(null)}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-900"
              >
                取消
              </button>
              <button
                onClick={() => {
                  const env: Record<string, string> = {};
                  for (const [k, val] of Object.entries(envValues)) {
                    if (val.trim()) env[k] = val.trim();
                  }
                  handleInstall(showEnvModal, env);
                }}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                <Download className="mr-1.5 inline h-4 w-4" /> 安装
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
