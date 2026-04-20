"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { apiFetch, showToast } from "@/lib/utils";
import {
  Radio, Plus, Trash2, CheckCircle, XCircle, Wifi, WifiOff,
  Loader2, RefreshCw, Activity, Clock, AlertTriangle,
  ArrowUpCircle, Shield, Wrench, QrCode, Settings,
} from "lucide-react";

// ─── 类型定义（对齐 v2 Schema 驱动 API）─────────────────

interface FieldSchema {
  key: string;
  label: string;
  type: "string" | "secret" | "number" | "boolean" | "select" | "url";
  required: boolean;
  default: unknown;
  placeholder: string;
  help_text: string;
  options: { value: string; label: string }[];
  group: string;
  order: number;
}

interface ChannelSchema {
  channel_id: string;
  channel_label: string;
  docs_url: string;
  setup_guide: string;
  fields: FieldSchema[];
}

interface ChannelStatus {
  id: string;
  label: string;
  connected: boolean;
  last_error: string | null;
  has_qr_login: boolean;
  has_doctor: boolean;
  has_setup: boolean;
  capabilities: { media: boolean; threads: boolean; block_streaming: boolean };
}

interface HealthEntry {
  status: string;
  severity: number;
  needs_restart: boolean;
  cooldown_remaining: number;
}

interface GatewayHealth {
  status: string;
  version: string;
  api_connection: string;
  channels: Record<string, { connected: boolean; last_error: string | null }>;
  channel_count: number;
  active_sessions: number;
  health: Record<string, HealthEntry>;
  reconnect: Record<string, unknown>;
}

// ─── 样式映射 ────────────────────────────────────────

const platformColors: Record<string, string> = {
  dingtalk: "text-sky-400",
  wecom: "text-blue-400",
  feishu: "text-indigo-400",
  weixin: "text-green-400",
};

const healthLevelMeta: Record<string, { label: string; color: string; bg: string }> = {
  healthy:       { label: "健康",   color: "text-green-400",  bg: "bg-green-900/20 border-green-800" },
  startup_grace: { label: "启动中", color: "text-yellow-400", bg: "bg-yellow-900/20 border-yellow-800" },
  stale:         { label: "不活跃", color: "text-orange-400", bg: "bg-orange-900/20 border-orange-800" },
  disconnected:  { label: "已断开", color: "text-red-400",    bg: "bg-red-900/20 border-red-800" },
  not_running:   { label: "未运行", color: "text-zinc-500",   bg: "bg-zinc-900 border-zinc-800" },
};

const statusMetas: Record<string, { label: string; color: string; bg: string }> = {
  ok:        { label: "在线", color: "text-green-400",  bg: "border-green-800 bg-green-900/20" },
  degraded:  { label: "降级", color: "text-yellow-400", bg: "border-yellow-800 bg-yellow-900/20" },
  unhealthy: { label: "异常", color: "text-red-400",    bg: "border-red-800 bg-red-900/20" },
  offline:   { label: "离线", color: "text-zinc-500",   bg: "border-zinc-800 bg-zinc-900" },
};

// ─── Schema 驱动表单渲染 ─────────────────────────────

function SchemaField({
  field,
  value,
  onChange,
}: {
  field: FieldSchema;
  value: string;
  onChange: (key: string, val: string) => void;
}) {
  const base = "w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none";

  if (field.type === "select" && field.options.length > 0) {
    return (
      <select value={value || String(field.default || "")} onChange={(e) => onChange(field.key, e.target.value)} className={base}>
        {field.options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  }

  return (
    <input
      type={field.type === "secret" ? "password" : field.type === "number" ? "number" : "text"}
      value={value}
      onChange={(e) => onChange(field.key, e.target.value)}
      placeholder={field.placeholder || field.help_text}
      required={field.required}
      className={base}
    />
  );
}

export default function ChannelsPage() {
  const [schemas, setSchemas] = useState<ChannelSchema[]>([]);
  const [channelList, setChannelList] = useState<ChannelStatus[]>([]);
  const [gwHealth, setGwHealth] = useState<GatewayHealth | null>(null);
  const [gwStatus, setGwStatus] = useState("offline");
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState("");
  const [showConnect, setShowConnect] = useState(false);
  const [selectedChannel, setSelectedChannel] = useState("");
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [expandedChannel, setExpandedChannel] = useState<string | null>(null);
  const [qrState, setQrState] = useState<{
    qrDataUrl: string;
    message: string;
    status: string;
    error: string | null;
  } | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrPolling, setQrPolling] = useState(false);
  // Ref 追踪对话框是否仍打开，避免异步请求返回后的竞态
  const dialogOpenRef = useRef(false);

  // ── 数据加载 ──────────────────────────────────────
  const refresh = useCallback(async () => {
    try {
      const health = await apiFetch<GatewayHealth>("/api/gateway/health");
      setGwHealth(health);
      setGwStatus(health.status || "offline");
    } catch {
      setGwStatus("offline");
      setGwHealth(null);
    }
    try {
      const s = await apiFetch<ChannelSchema[]>("/api/gateway/channels/schemas");
      setSchemas(Array.isArray(s) ? s : []);
    } catch {}
    try {
      const data = await apiFetch<{ channels: ChannelStatus[] }>("/api/gateway/channels/list");
      setChannelList(data?.channels || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [refresh]);

  // ── 操作 ──────────────────────────────────────────

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedChannel) return;
    setConnecting(selectedChannel);
    try {
      await apiFetch(`/api/gateway/channels/${selectedChannel}/connect`, {
        method: "POST",
        body: JSON.stringify({ credentials: formValues }),
      });
      showToast("连接成功", "success");
      dialogOpenRef.current = false;
      setShowConnect(false);
      setFormValues({});
      setQrState(null);
      setQrPolling(false);
      await refresh();
    } catch (err: any) {
      // apiFetch 内部已经 showToast(error)，这里不再重复提示
    } finally {
      setConnecting("");
    }
  };

  const handleDisconnect = async (channelId: string) => {
    const label = channelList.find((c) => c.id === channelId)?.label || channelId;
    if (!confirm(`确定断开 ${label}？`)) return;
    await apiFetch(`/api/gateway/channels/${channelId}/disconnect`, { method: "POST" });
    await refresh();
  };

  const openConnectDialog = (channelId: string) => {
    setSelectedChannel(channelId);
    setFormValues({});
    setQrState(null);
    setQrPolling(false);
    dialogOpenRef.current = true;
    setShowConnect(true);
  };

  const closeDialog = () => {
    dialogOpenRef.current = false;
    setShowConnect(false);
    setQrState(null);
    setQrPolling(false);
    setFormValues({});
  };

  // QR 扫码登录
  const handleQrStart = async () => {
    if (!selectedChannel) return;
    const channelAtStart = selectedChannel;
    setQrLoading(true);
    try {
      const data = await apiFetch<{ qr_data_url: string; session_id: string; message: string }>(
        `/api/gateway/channels/${channelAtStart}/qr/start`,
        { method: "POST", body: JSON.stringify({ credentials: formValues }) }
      );
      // 防竞态：请求期间对话框被关闭或渠道切换，丢弃结果
      if (!dialogOpenRef.current) return;
      setQrState({
        qrDataUrl: data.qr_data_url,
        message: data.message || "请使用手机扫描二维码",
        status: "waiting",
        error: null,
      });
      setQrPolling(true);
    } catch (err: any) {
      alert("获取二维码失败: " + (err.message || "未知错误"));
    } finally {
      setQrLoading(false);
    }
  };

  // QR 轮询 — 每 2.5s 检查扫码状态
  useEffect(() => {
    if (!qrPolling || !selectedChannel) return;

    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const intervalId = setInterval(async () => {
      try {
        const data = await apiFetch<{ status: string; connected: boolean; error: string | null }>(
          `/api/gateway/channels/${selectedChannel}/qr/status`
        );
        if (data.connected) {
          setQrState((prev) => prev ? { ...prev, status: "connected" } : null);
          setQrPolling(false);
          closeTimer = setTimeout(() => {
            dialogOpenRef.current = false;
            setShowConnect(false);
            setQrState(null);
            setFormValues({});
            refresh();
          }, 1500);
        } else if (data.error) {
          setQrState((prev) => prev ? { ...prev, status: "error", error: data.error } : null);
          setQrPolling(false);
        } else {
          setQrState((prev) => prev ? { ...prev, status: data.status } : null);
        }
      } catch { /* 轮询异常忽略 */ }
    }, 2500);

    return () => {
      clearInterval(intervalId);
      if (closeTimer !== undefined) clearTimeout(closeTimer);
    };
  }, [qrPolling, selectedChannel, refresh]);

  const selectedSchema = schemas.find((s) => s.channel_id === selectedChannel);
  const selectedHasQr = channelList.find((c) => c.id === selectedChannel)?.has_qr_login;
  const gwOnline = gwStatus !== "offline";
  const sMeta = statusMetas[gwStatus] || statusMetas.offline;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">通道管理</h1>
          <p className="mt-1 text-zinc-400">Schema 驱动的 IM 平台配置</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={refresh}
            disabled={loading}
            className="rounded-lg border border-zinc-700 p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-50"
            title="刷新"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${sMeta.bg} ${sMeta.color}`}>
            {gwOnline ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
            网关 {sMeta.label}
            {gwHealth?.channel_count !== undefined && gwOnline && (
              <span className="text-xs opacity-70">({gwHealth.channel_count} 渠道)</span>
            )}
          </div>
        </div>
      </div>

      {/* 渠道卡片网格（Schema 驱动）*/}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {channelList.map((ch) => {
          const color = platformColors[ch.id] || "text-zinc-400";
          const healthLevel = gwHealth?.health?.[ch.id]?.status || "not_running";
          const lm = healthLevelMeta[healthLevel] || healthLevelMeta.not_running;
          const isExpanded = expandedChannel === ch.id;

          return (
            <div
              key={ch.id}
              className={`rounded-xl border overflow-hidden transition-all ${
                ch.connected ? lm.bg : "border-zinc-800 bg-zinc-900/50"
              }`}
            >
              {/* 主区域 */}
              <div
                className="p-4 cursor-pointer hover:bg-zinc-900/80"
                onClick={() => setExpandedChannel(isExpanded ? null : ch.id)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className={`font-medium ${color}`}>{ch.label}</p>
                    <p className={`text-xs mt-0.5 ${ch.connected ? lm.color : "text-zinc-500"}`}>
                      {ch.connected ? lm.label : "未连接"}
                    </p>
                    {ch.last_error && ch.connected && (
                      <p className="text-xs text-red-400 mt-1 truncate max-w-[180px]" title={ch.last_error}>
                        <AlertTriangle className="inline h-3 w-3 mr-0.5" />
                        {ch.last_error}
                      </p>
                    )}
                  </div>
                  {ch.connected ? (
                    <CheckCircle className={`h-5 w-5 ${lm.color}`} />
                  ) : (
                    <Radio className="h-5 w-5 text-zinc-700" />
                  )}
                </div>

                {/* 功能标签 */}
                <div className="flex gap-1 mt-2 flex-wrap">
                  {ch.has_qr_login && (
                    <span
                      className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded flex items-center gap-0.5 cursor-pointer hover:bg-zinc-700 hover:text-blue-400 transition-colors"
                      onClick={(e) => { e.stopPropagation(); openConnectDialog(ch.id); }}
                    >
                      <QrCode className="h-2.5 w-2.5" /> QR
                    </span>
                  )}
                  {ch.has_doctor && (
                    <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded flex items-center gap-0.5">
                      <Wrench className="h-2.5 w-2.5" /> 诊断
                    </span>
                  )}
                  {ch.capabilities.media && (
                    <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">媒体</span>
                  )}
                  {ch.capabilities.block_streaming && (
                    <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">流式</span>
                  )}
                </div>
              </div>

              {/* 展开操作区 */}
              {isExpanded && (
                <div className="border-t border-zinc-800 px-4 py-3 space-y-2">
                  {!ch.connected ? (
                    <div className="flex gap-2">
                      <button
                        onClick={() => openConnectDialog(ch.id)}
                        disabled={!gwOnline}
                        className={`${ch.has_qr_login ? "flex-1" : "w-full"} flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50`}
                      >
                        <Plus className="h-4 w-4" /> 配置连接
                      </button>
                      {ch.has_qr_login && (
                        <button
                          onClick={() => openConnectDialog(ch.id)}
                          disabled={!gwOnline}
                          className="flex items-center justify-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-blue-400 disabled:opacity-50"
                        >
                          <QrCode className="h-4 w-4" /> 扫码
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleDisconnect(ch.id)}
                        className="flex-1 flex items-center justify-center gap-1 rounded-lg border border-zinc-700 px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-400"
                      >
                        <Trash2 className="h-3 w-3" /> 断开
                      </button>
                      {ch.has_doctor && (
                        <button
                          onClick={async () => {
                            const data = await apiFetch(`/api/gateway/channels/${ch.id}/doctor`);
                            alert(JSON.stringify(data, null, 2));
                          }}
                          className="flex-1 flex items-center justify-center gap-1 rounded-lg border border-zinc-700 px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-yellow-400"
                        >
                          <Wrench className="h-3 w-3" /> 诊断
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Session 信息 */}
      {gwOnline && gwHealth && (
        <div className="flex items-center gap-4 text-xs text-zinc-500">
          <span>活跃 Session: {gwHealth.active_sessions || 0}</span>
          <span>·</span>
          <span>API: {gwHealth.api_connection || "unknown"}</span>
          <span>·</span>
          <span>版本: {gwHealth.version || "-"}</span>
        </div>
      )}

      {/* Empty State */}
      {!loading && channelList.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-700 p-12 text-center">
          <Radio className="mx-auto h-12 w-12 text-zinc-600" />
          <p className="mt-4 text-zinc-400">
            {gwOnline ? "正在加载渠道列表..." : "IM 网关离线，请先启动 services/im-gateway"}
          </p>
          {!gwOnline && (
            <p className="mt-2 text-sm text-zinc-600 font-mono">cd services/im-gateway && python server.py</p>
          )}
        </div>
      )}

      {/* Schema 驱动连接对话框 */}
      {showConnect && selectedSchema && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={closeDialog}>
          <div className="w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-white mb-1">
              {qrState ? "扫码登录" : "配置"} {selectedSchema.channel_label}
            </h2>

            {qrState ? (
              /* QR 扫码界面 */
              <div className="text-center py-6 space-y-4">
                <div className="inline-block p-4 bg-white rounded-xl">
                  <img src={qrState.qrDataUrl} alt="QR Code" className="w-52 h-52" />
                </div>
                <p className="text-sm text-zinc-300">{qrState.message}</p>
                <div className="flex items-center justify-center gap-2 text-sm">
                  {qrState.status === "connected" ? (
                    <span className="text-green-400 flex items-center gap-1.5">
                      <CheckCircle className="h-4 w-4" /> 扫码成功，正在连接...
                    </span>
                  ) : qrState.error ? (
                    <span className="text-red-400 flex items-center gap-1.5">
                      <XCircle className="h-4 w-4" /> {qrState.error}
                    </span>
                  ) : qrState.status === "scanned" ? (
                    <span className="text-blue-400 flex items-center gap-1.5">
                      <Loader2 className="h-4 w-4 animate-spin" /> 已扫码，等待确认...
                    </span>
                  ) : (
                    <span className="text-yellow-400 flex items-center gap-1.5">
                      <Loader2 className="h-4 w-4 animate-spin" /> 等待扫码...
                    </span>
                  )}
                </div>
                {qrState.status !== "connected" && (
                  <div className="flex justify-center gap-3 pt-2">
                    <button
                      onClick={() => { setQrState(null); setQrPolling(false); }}
                      className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-900"
                    >
                      ← 返回
                    </button>
                    {(qrState.error || qrState.status === "expired") && (
                      <button
                        onClick={handleQrStart}
                        disabled={qrLoading}
                        className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {qrLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                        重新获取
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              /* 常规配置表单 */
              <>
            {/* Setup Guide */}
            {selectedSchema.setup_guide && (
              <div className="text-xs text-zinc-400 mb-4 prose prose-invert prose-sm max-w-none">
                <pre className="whitespace-pre-wrap text-zinc-500 bg-zinc-900 p-3 rounded-lg text-xs">
                  {selectedSchema.setup_guide}
                </pre>
              </div>
            )}

            <form onSubmit={handleConnect} className="space-y-3">
              {/* Basic fields */}
              {selectedSchema.fields
                .filter((f) => f.group === "basic" || !f.group)
                .map((f) => (
                  <div key={f.key}>
                    <label className="block text-sm text-zinc-400 mb-1">
                      {f.label}
                      {f.required && <span className="text-red-400 ml-0.5">*</span>}
                    </label>
                    <SchemaField
                      field={f}
                      value={formValues[f.key] || ""}
                      onChange={(k, v) => setFormValues((prev) => ({ ...prev, [k]: v }))}
                    />
                    {f.help_text && <p className="text-xs text-zinc-600 mt-0.5">{f.help_text}</p>}
                  </div>
                ))}

              {/* Advanced fields (collapsible) */}
              {selectedSchema.fields.filter((f) => f.group === "advanced").length > 0 && (
                <details className="mt-2">
                  <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-300">
                    <Settings className="inline h-3 w-3 mr-1" />
                    高级配置
                  </summary>
                  <div className="mt-2 space-y-3 pl-2 border-l border-zinc-800">
                    {selectedSchema.fields
                      .filter((f) => f.group === "advanced")
                      .map((f) => (
                        <div key={f.key}>
                          <label className="block text-sm text-zinc-400 mb-1">
                            {f.label}
                            {f.required && <span className="text-red-400 ml-0.5">*</span>}
                          </label>
                          <SchemaField
                            field={f}
                            value={formValues[f.key] || ""}
                            onChange={(k, v) => setFormValues((prev) => ({ ...prev, [k]: v }))}
                          />
                          {f.help_text && <p className="text-xs text-zinc-600 mt-0.5">{f.help_text}</p>}
                        </div>
                      ))}
                  </div>
                </details>
              )}

              {/* Docs link */}
              {selectedSchema.docs_url && (
                <p className="text-xs text-zinc-600">
                  <a href={selectedSchema.docs_url} target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-400">
                    查看官方文档 →
                  </a>
                </p>
              )}

              <div className="flex justify-end gap-3 pt-3">
                <button type="button" onClick={closeDialog} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-900">
                  取消
                </button>
                {selectedHasQr && (
                  <button
                    type="button"
                    onClick={handleQrStart}
                    disabled={qrLoading}
                    className="flex items-center gap-2 rounded-lg border border-blue-800 bg-blue-950/50 px-4 py-2 text-sm text-blue-400 hover:bg-blue-900/50 disabled:opacity-50"
                  >
                    {qrLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
                    扫码登录
                  </button>
                )}
                <button
                  type="submit"
                  disabled={!!connecting}
                  className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {connecting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {connecting ? "连接中..." : "连接"}
                </button>
              </div>
            </form>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
