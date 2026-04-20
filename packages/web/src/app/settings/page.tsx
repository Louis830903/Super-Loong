"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import {
  Settings, Save, Key, Globe, CheckCircle2, XCircle, ChevronDown, ChevronUp,
  Zap, ExternalLink, Loader2, RefreshCw, Wrench, Search, Database, Shield, Info,
} from "lucide-react";

interface ServiceKeyInfo {
  key: string;
  label: string;
  hasValue: boolean;
  maskedValue: string;
  hint?: string;
  helpUrl?: string;
}

interface ServiceInfo {
  id: string;
  name: string;
  description: string;
  website?: string;
  configured: boolean;
  keys: ServiceKeyInfo[];
}

interface ModelDef {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens?: number;
  supportsFunctions: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  tags: string[];
}

interface ProviderInfo {
  id: string;
  name: string;
  website: string;
  baseUrl: string;
  defaultBaseUrl: string;
  isEnabled: boolean;
  selectedModel: string;
  keyStatus: "configured" | "missing";
  maskedKey: string;
  models: ModelDef[];
}

export default function SettingsPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({});
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});
  const [loading, setLoading] = useState(true);

  // ── 服务配置状态 ──
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [svcExpandedId, setSvcExpandedId] = useState<string | null>(null);
  const [svcInputs, setSvcInputs] = useState<Record<string, Record<string, string>>>({});
  const [svcSaving, setSvcSaving] = useState<Record<string, boolean>>({});
  const [svcResults, setSvcResults] = useState<Record<string, { success: boolean; message: string }>>({});
  const [detecting, setDetecting] = useState(false);

  const fetchProviders = useCallback(async () => {
    try {
      const data = await apiFetch<{ providers: ProviderInfo[] }>("/api/models/providers");
      setProviders(data.providers);
      // Initialize selected models from server state
      const models: Record<string, string> = {};
      for (const p of data.providers) {
        if (p.selectedModel) models[p.id] = p.selectedModel;
      }
      setSelectedModels((prev) => ({ ...prev, ...models }));
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProviders(); }, [fetchProviders]);

  // ── 服务配置 Fetch ──
  const fetchServices = useCallback(async () => {
    try {
      const data = await apiFetch<{ services: ServiceInfo[] }>("/api/services");
      setServices(data.services);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchServices(); }, [fetchServices]);

  const handleServiceSave = async (serviceId: string) => {
    setSvcSaving((s) => ({ ...s, [serviceId]: true }));
    try {
      const inputs = svcInputs[serviceId] ?? {};
      await apiFetch(`/api/services/${serviceId}`, {
        method: "PUT",
        body: JSON.stringify(inputs),
      });
      setSvcInputs((prev) => { const next = { ...prev }; delete next[serviceId]; return next; });
      await fetchServices();
      setSvcResults((r) => ({ ...r, [serviceId]: { success: true, message: "保存成功" } }));
      setTimeout(() => setSvcResults((r) => { const n = { ...r }; delete n[serviceId]; return n; }), 2000);
    } catch (err: any) {
      setSvcResults((r) => ({ ...r, [serviceId]: { success: false, message: err.message || "保存失败" } }));
    } finally {
      setSvcSaving((s) => ({ ...s, [serviceId]: false }));
    }
  };

  const handleBrowserDetect = async () => {
    setDetecting(true);
    try {
      const data = await apiFetch<{ detected: Array<{ name: string; path: string }>; recommended: { name: string; path: string } | null }>(
        "/api/services/browser/detect", { method: "POST" }
      );
      if (data.recommended) {
        setSvcInputs((prev) => ({
          ...prev,
          browser: { ...(prev.browser ?? {}), browser_path: data.recommended!.path },
        }));
        setSvcResults((r) => ({ ...r, browser: { success: true, message: `检测到 ${data.recommended!.name}：${data.recommended!.path}` } }));
      } else {
        setSvcResults((r) => ({ ...r, browser: { success: false, message: "未检测到已安装的浏览器" } }));
      }
    } catch (err: any) {
      setSvcResults((r) => ({ ...r, browser: { success: false, message: err.message || "探测失败" } }));
    } finally {
      setDetecting(false);
    }
  };

  const handleSave = async (providerId: string) => {
    setSaving((s) => ({ ...s, [providerId]: true }));
    try {
      const body: Record<string, unknown> = {};
      if (apiKeys[providerId] !== undefined) body.apiKey = apiKeys[providerId];
      if (baseUrls[providerId] !== undefined) body.baseUrl = baseUrls[providerId];
      if (selectedModels[providerId]) body.selectedModel = selectedModels[providerId];
      body.isEnabled = true;

      await apiFetch(`/api/models/providers/${providerId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });

      // Clear the local key input after saving
      setApiKeys((k) => { const next = { ...k }; delete next[providerId]; return next; });
      await fetchProviders();
      setTestResults((r) => ({ ...r, [providerId]: { success: true, message: "保存成功" } }));
      setTimeout(() => setTestResults((r) => { const n = { ...r }; delete n[providerId]; return n; }), 2000);
    } catch (err: any) {
      setTestResults((r) => ({ ...r, [providerId]: { success: false, message: err.message || "保存失败" } }));
    } finally {
      setSaving((s) => ({ ...s, [providerId]: false }));
    }
  };

  const handleTest = async (providerId: string) => {
    setTesting((t) => ({ ...t, [providerId]: true }));
    setTestResults((r) => { const n = { ...r }; delete n[providerId]; return n; });
    try {
      // Auto-save first if user entered a new API key
      const localKey = apiKeys[providerId];
      const localUrl = baseUrls[providerId];
      const localModel = selectedModels[providerId];
      if (localKey || localUrl || localModel) {
        const saveBody: Record<string, unknown> = { isEnabled: true };
        if (localKey !== undefined) saveBody.apiKey = localKey;
        if (localUrl !== undefined) saveBody.baseUrl = localUrl;
        if (localModel) saveBody.selectedModel = localModel;
        await apiFetch(`/api/models/providers/${providerId}`, {
          method: "PUT",
          body: JSON.stringify(saveBody),
        });
        // Clear local key input after saving
        setApiKeys((k) => { const next = { ...k }; delete next[providerId]; return next; });
        await fetchProviders();
      }

      const model = localModel || selectedModels[providerId] || providers.find((p) => p.id === providerId)?.models[0]?.id;
      const data = await apiFetch<{ success: boolean; model: string; response: string }>(`/api/models/providers/${providerId}/test`, {
        method: "POST",
        body: JSON.stringify({ model }),
      });
      setTestResults((r) => ({ ...r, [providerId]: { success: true, message: `连接成功 (${data.model})` } }));
    } catch (err: any) {
      setTestResults((r) => ({ ...r, [providerId]: { success: false, message: err.message || "连接失败" } }));
    } finally {
      setTesting((t) => ({ ...t, [providerId]: false }));
    }
  };

  const formatCtx = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(0)}M`;
    return `${(n / 1000).toFixed(0)}K`;
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
      </div>
    );
  }

  // 统计已配置的 provider 数和服务数
  const configuredProviders = providers.filter((p) => p.keyStatus === "configured").length;
  const configuredServices = services.filter((s) => s.configured).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">模型配置</h1>
          <p className="mt-1 text-zinc-400">选择 Provider，填写 API Key，即可开始对话</p>
        </div>
        <button onClick={() => { fetchProviders(); fetchServices(); }} className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
          <RefreshCw className="h-4 w-4" /> 刷新
        </button>
      </div>

      {/* 持久化状态总览 */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
        <div className="flex items-center gap-2 mb-2">
          <Database className="h-4 w-4 text-blue-400" />
          <span className="text-sm font-medium text-white">持久化状态</span>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-400">
            <Shield className="h-3 w-3" /> 所有配置已加密存储到本地数据库
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
          <div className="rounded-lg bg-zinc-800/50 px-3 py-2">
            <p className="text-[11px] text-zinc-500">LLM Provider</p>
            <p className="text-sm font-medium text-white">{configuredProviders}/{providers.length} <span className="text-zinc-500 font-normal">已配置</span></p>
          </div>
          <div className="rounded-lg bg-zinc-800/50 px-3 py-2">
            <p className="text-[11px] text-zinc-500">外部服务</p>
            <p className="text-sm font-medium text-white">{configuredServices}/{services.length} <span className="text-zinc-500 font-normal">已配置</span></p>
          </div>
          <div className="rounded-lg bg-zinc-800/50 px-3 py-2">
            <p className="text-[11px] text-zinc-500">加密方式</p>
            <p className="text-sm font-medium text-white">AES-256-CBC</p>
          </div>
          <div className="rounded-lg bg-zinc-800/50 px-3 py-2">
            <p className="text-[11px] text-zinc-500">存储位置</p>
            <p className="text-sm font-medium text-zinc-300 truncate" title="~/.super-agent/super-agent.db">~/.super-agent/</p>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-zinc-600 flex items-center gap-1">
          <Info className="h-3 w-3" /> 重启程序后所有配置自动恢复。API Key 输入框显示为空是安全设计，已保存的 Key 以掩码形式展示在占位符中。
        </p>
      </div>

      {/* Provider Cards */}
      <div className="space-y-3">
        {providers.map((provider) => {
          const isExpanded = expandedId === provider.id;
          const isCustom = provider.id === "custom";
          const currentModel = selectedModels[provider.id] || provider.selectedModel;
          const result = testResults[provider.id];

          return (
            <div key={provider.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
              {/* Header */}
              <button
                onClick={() => setExpandedId(isExpanded ? null : provider.id)}
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-zinc-800/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800 text-lg font-bold text-blue-400">
                    {provider.name.charAt(0)}
                  </div>
                  <div className="text-left">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white">{provider.name}</span>
                      {provider.keyStatus === "configured" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400">
                          <Database className="h-3 w-3" /> 已保存
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-700/50 px-2 py-0.5 text-xs text-zinc-400">
                          <XCircle className="h-3 w-3" /> 未配置
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-500">
                      {isCustom ? "自定义 OpenAI 兼容端点" : `${provider.models.length} 个模型`}
                      {currentModel && ` · 当前: ${currentModel}`}
                      {provider.keyStatus === "configured" && provider.maskedKey && (
                        <span className="text-zinc-600"> · Key: {provider.maskedKey}</span>
                      )}
                    </p>
                  </div>
                </div>
                {isExpanded ? <ChevronUp className="h-5 w-5 text-zinc-400" /> : <ChevronDown className="h-5 w-5 text-zinc-400" />}
              </button>

              {/* Expanded Panel */}
              {isExpanded && (
                <div className="border-t border-zinc-800 px-5 py-5 space-y-4">
                  {/* Website link */}
                  {provider.website && (
                    <a href={provider.website} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300">
                      <ExternalLink className="h-3.5 w-3.5" /> 获取 API Key →
                    </a>
                  )}

                  {/* 持久化详情（已配置时显示） */}
                  {provider.keyStatus === "configured" && (
                    <div className="rounded-lg border border-emerald-800/30 bg-emerald-900/10 px-4 py-3">
                      <p className="text-xs font-medium text-emerald-400 mb-2 flex items-center gap-1">
                        <Database className="h-3.5 w-3.5" /> 以下配置已持久化到数据库（重启自动恢复）
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                        <div>
                          <span className="text-zinc-500">API Key</span>
                          <p className="text-zinc-300 font-mono">{provider.maskedKey || "(空)"}</p>
                        </div>
                        <div>
                          <span className="text-zinc-500">模型</span>
                          <p className="text-zinc-300">{provider.selectedModel || "(未选择)"}</p>
                        </div>
                        <div>
                          <span className="text-zinc-500">Base URL</span>
                          <p className="text-zinc-300 truncate" title={provider.baseUrl}>{provider.baseUrl === provider.defaultBaseUrl ? "(默认)" : provider.baseUrl || "(默认)"}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* API Key Input */}
                  <div>
                    <label className="block text-sm text-zinc-400 mb-1.5">
                      API Key
                      {provider.keyStatus === "configured" && (
                        <span className="ml-2 text-[11px] text-zinc-600">(留空则保持当前已保存的 Key 不变)</span>
                      )}
                    </label>
                    <div className="relative">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
                      <input
                        type="password"
                        value={apiKeys[provider.id] ?? ""}
                        onChange={(e) => setApiKeys((k) => ({ ...k, [provider.id]: e.target.value }))}
                        placeholder={provider.maskedKey || "sk-..."}
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-800 py-2.5 pl-10 pr-3 text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* Base URL (for custom or override) */}
                  {(isCustom || provider.baseUrl !== provider.defaultBaseUrl) && (
                    <div>
                      <label className="block text-sm text-zinc-400 mb-1.5">Base URL</label>
                      <div className="relative">
                        <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
                        <input
                          value={baseUrls[provider.id] ?? provider.baseUrl ?? ""}
                          onChange={(e) => setBaseUrls((u) => ({ ...u, [provider.id]: e.target.value }))}
                          placeholder={provider.defaultBaseUrl || "https://api.example.com/v1"}
                          className="w-full rounded-lg border border-zinc-700 bg-zinc-800 py-2.5 pl-10 pr-3 text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                        />
                      </div>
                    </div>
                  )}

                  {/* Model Selector */}
                  {!isCustom && provider.models.length > 0 && (
                    <div>
                      <label className="block text-sm text-zinc-400 mb-1.5">选择模型</label>
                      <select
                        value={currentModel || ""}
                        onChange={(e) => setSelectedModels((m) => ({ ...m, [provider.id]: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-white focus:border-blue-500 focus:outline-none"
                      >
                        <option value="">-- 请选择 --</option>
                        {provider.models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} ({formatCtx(m.contextWindow)}
                            {m.supportsVision ? " · 视觉" : ""}
                            {m.supportsReasoning ? " · 推理" : ""}
                            {m.tags.includes("free") ? " · 免费" : ""})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Custom model ID input */}
                  {isCustom && (
                    <div>
                      <label className="block text-sm text-zinc-400 mb-1.5">Model ID</label>
                      <input
                        value={selectedModels[provider.id] ?? provider.selectedModel ?? ""}
                        onChange={(e) => setSelectedModels((m) => ({ ...m, [provider.id]: e.target.value }))}
                        placeholder="gpt-4o / llama3 / ..."
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                  )}

                  {/* Model Tags */}
                  {!isCustom && currentModel && (() => {
                    const model = provider.models.find((m) => m.id === currentModel);
                    if (!model) return null;
                    return (
                      <div className="flex flex-wrap gap-1.5">
                        {model.tags.map((tag) => (
                          <span key={tag} className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-300 border border-zinc-700">
                            {tag}
                          </span>
                        ))}
                        {model.supportsFunctions && (
                          <span className="rounded-full bg-blue-500/10 px-2.5 py-0.5 text-xs text-blue-400 border border-blue-500/20">
                            工具调用
                          </span>
                        )}
                      </div>
                    );
                  })()}

                  {/* Result Message */}
                  {result && (
                    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${result.success ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                      {result.success ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                      {result.message}
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={() => handleSave(provider.id)}
                      disabled={saving[provider.id]}
                      className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {saving[provider.id] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      保存配置
                    </button>
                    <button
                      onClick={() => handleTest(provider.id)}
                      disabled={testing[provider.id] || provider.keyStatus === "missing" && !apiKeys[provider.id]}
                      className="flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      {testing[provider.id] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                      测试连接
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── 服务配置区块 ── */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <Wrench className="h-5 w-5 text-purple-400" /> 服务配置
            </h2>
            <p className="mt-1 text-sm text-zinc-400">配置语音、图片生成、浏览器等外部服务</p>
          </div>
          <button onClick={fetchServices} className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
            <RefreshCw className="h-4 w-4" /> 刷新
          </button>
        </div>

        <div className="space-y-3">
          {services.map((svc) => {
            const isExpanded = svcExpandedId === svc.id;
            const svcResult = svcResults[svc.id];
            return (
              <div key={svc.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
                <button
                  onClick={() => setSvcExpandedId(isExpanded ? null : svc.id)}
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-zinc-800/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800 text-lg font-bold text-purple-400">
                      {svc.name.charAt(0)}
                    </div>
                    <div className="text-left">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white">{svc.name}</span>
                        {svc.configured ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400">
                            <Database className="h-3 w-3" /> 已保存
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-zinc-700/50 px-2 py-0.5 text-xs text-zinc-400">
                            <XCircle className="h-3 w-3" /> 未配置
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-zinc-500">
                        {svc.description}
                        {svc.configured && (
                          <span className="text-zinc-600"> · {svc.keys.filter((k) => k.hasValue).length}/{svc.keys.length} 项已保存</span>
                        )}
                      </p>
                    </div>
                  </div>
                  {isExpanded ? <ChevronUp className="h-5 w-5 text-zinc-400" /> : <ChevronDown className="h-5 w-5 text-zinc-400" />}
                </button>

                {isExpanded && (
                  <div className="border-t border-zinc-800 px-5 py-5 space-y-4">
                    {svc.website && (
                      <div className="flex flex-wrap items-center gap-3">
                        <a href={svc.website} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300">
                          <ExternalLink className="h-3.5 w-3.5" /> 获取密钥 →
                        </a>
                        {/* 如果字段有独立 helpUrl，去重后额外显示 */}
                        {(() => {
                          const extraUrls = new Map<string, string>();
                          svc.keys.forEach(k => {
                            if (k.helpUrl && k.helpUrl !== svc.website && !extraUrls.has(k.helpUrl)) {
                              extraUrls.set(k.helpUrl, k.label);
                            }
                          });
                          return Array.from(extraUrls.entries()).map(([url, label]) => (
                            <a key={url} href={url} target="_blank" rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300">
                              <Key className="h-3.5 w-3.5" /> {label} →
                            </a>
                          ));
                        })()}
                      </div>
                    )}

                    {/* 持久化详情（有已保存项时显示） */}
                    {svc.keys.some((k) => k.hasValue) && (
                      <div className="rounded-lg border border-emerald-800/30 bg-emerald-900/10 px-4 py-3">
                        <p className="text-xs font-medium text-emerald-400 mb-2 flex items-center gap-1">
                          <Database className="h-3.5 w-3.5" /> 已保存的配置（重启自动恢复）
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                          {svc.keys.map((k) => (
                            <div key={k.key}>
                              <span className="text-zinc-500">{k.label}</span>
                              <p className={`font-mono ${k.hasValue ? "text-zinc-300" : "text-zinc-600"}`}>
                                {k.hasValue ? k.maskedValue || "(已设置)" : "(未设置)"}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {svc.keys.map((k) => (
                      <div key={k.key}>
                        <label className="block text-sm text-zinc-400 mb-1">
                          {k.label}
                          {k.hasValue && (
                            <span className="ml-2 text-[11px] text-emerald-600">（已保存）</span>
                          )}
                          {k.helpUrl && (
                            <a href={k.helpUrl} target="_blank" rel="noopener noreferrer"
                              className="ml-2 text-[11px] text-blue-500 hover:text-blue-400">
                              获取 →
                            </a>
                          )}
                        </label>
                        {k.hint && (
                          <p className="text-[11px] text-zinc-600 mb-1.5 flex items-center gap-1">
                            <Info className="h-3 w-3 shrink-0" /> {k.hint}
                          </p>
                        )}
                        <div className="relative">
                          <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
                          <input
                            type={k.key.includes("secret") || k.key === "api_key" || k.key === "access_key_id" ? "password" : "text"}
                            value={svcInputs[svc.id]?.[k.key] ?? ""}
                            onChange={(e) => setSvcInputs((prev) => ({
                              ...prev,
                              [svc.id]: { ...(prev[svc.id] ?? {}), [k.key]: e.target.value },
                            }))}
                            placeholder={k.hasValue ? k.maskedValue : "未设置"}
                            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 py-2.5 pl-10 pr-3 text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                          />
                        </div>
                      </div>
                    ))}

                    {/* 浏览器自动探测按钮 */}
                    {svc.id === "browser" && (
                      <button
                        onClick={handleBrowserDetect}
                        disabled={detecting}
                        className="flex items-center gap-2 rounded-lg border border-purple-500/30 bg-purple-500/10 px-4 py-2 text-sm text-purple-300 hover:bg-purple-500/20 disabled:opacity-50"
                      >
                        {detecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                        自动探测本地浏览器
                      </button>
                    )}

                    {svcResult && (
                      <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${svcResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                        {svcResult.success ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                        {svcResult.message}
                      </div>
                    )}

                    <div className="flex items-center gap-3 pt-1">
                      <button
                        onClick={() => handleServiceSave(svc.id)}
                        disabled={svcSaving[svc.id]}
                        className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {svcSaving[svc.id] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        保存配置
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* System Info */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <div className="flex items-center gap-2 mb-4">
          <Settings className="h-5 w-5 text-amber-400" />
          <h2 className="text-lg font-semibold text-white">系统信息</h2>
        </div>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-zinc-400">版本</span>
            <span className="text-white">v0.1.0</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-400">API 地址</span>
            <span className="font-mono text-zinc-300">http://localhost:3001</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-400">存储后端</span>
            <span className="text-emerald-400">SQLite (AES-256-CBC 加密)</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-400">数据目录</span>
            <span className="font-mono text-zinc-300 text-xs">~/.super-agent/</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-400">已配置 Provider</span>
            <span className={configuredProviders > 0 ? "text-emerald-400" : "text-zinc-500"}>{configuredProviders}/{providers.length}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-400">已配置服务</span>
            <span className={configuredServices > 0 ? "text-emerald-400" : "text-zinc-500"}>{configuredServices}/{services.length}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
