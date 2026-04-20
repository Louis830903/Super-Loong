"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import {
  MessageSquare,
  Send,
  RefreshCw,
  CheckCircle,
  XCircle,
  Loader2,
  Settings,
  Wifi,
  WifiOff,
} from "lucide-react";

// ─── 类型定义 ────────────────────────────────────────────
interface WeclawStatusData {
  connected: boolean;
  last_message_at: number;
  message_count: number;
  last_error: string;
  weclaw_version: string;
  bound_user: string;
  weclaw_api_url: string;
  weclaw_running?: boolean;
  weclaw_uptime?: number;
}

// ─── WeClaw 管理面板 ────────────────────────────────────

export default function WeclawPanel() {
  const [status, setStatus] = useState<WeclawStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 推送表单
  const [pushTo, setPushTo] = useState("");
  const [pushText, setPushText] = useState("");
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState("");

  // 配置表单
  const [showConfig, setShowConfig] = useState(false);
  const [configUrl, setConfigUrl] = useState("");
  const [configGateway, setConfigGateway] = useState("");

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiFetch<WeclawStatusData>("/api/gateway/weclaw/status");
      setStatus(data);
      setError("");
      // 用返回的值填充配置表单
      if (data.weclaw_api_url) setConfigUrl(data.weclaw_api_url);
    } catch (e: any) {
      setError(e.message || "无法获取 WeClaw 状态");
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    // 每 30 秒自动刷新状态
    const timer = setInterval(fetchStatus, 30000);
    return () => clearInterval(timer);
  }, [fetchStatus]);

  const handlePush = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pushTo.trim() || !pushText.trim()) return;
    setPushing(true);
    setPushResult("");
    try {
      const res = await apiFetch<{ success: boolean; message: string }>(
        "/api/gateway/weclaw/push",
        {
          method: "POST",
          body: JSON.stringify({ to: pushTo, text: pushText }),
        }
      );
      setPushResult(res.success ? "发送成功" : res.message || "发送失败");
      if (res.success) setPushText("");
    } catch (e: any) {
      setPushResult("推送失败: " + (e.message || "未知错误"));
    } finally {
      setPushing(false);
    }
  };

  const handleConfigSave = async () => {
    try {
      const body: Record<string, string> = {};
      if (configUrl) body.weclaw_api_url = configUrl;
      if (configGateway) body.gateway_public_url = configGateway;
      await apiFetch("/api/gateway/weclaw/config", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setShowConfig(false);
      await fetchStatus();
    } catch (e: any) {
      alert("配置更新失败: " + e.message);
    }
  };

  // 时间格式化
  const formatTime = (ts: number) => {
    if (!ts) return "从未";
    const d = new Date(ts * 1000);
    return d.toLocaleString("zh-CN");
  };

  const formatUptime = (seconds: number) => {
    if (!seconds) return "—";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`;
  };

  return (
    <div className="space-y-4">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <MessageSquare className="h-5 w-5 text-green-400" />
          <h3 className="text-lg font-semibold text-white">
            微信 ClawBot (WeClaw)
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowConfig(!showConfig)}
            className="rounded-lg border border-zinc-700 p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white"
            title="配置"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            onClick={fetchStatus}
            disabled={loading}
            className="rounded-lg border border-zinc-700 p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-50"
            title="刷新状态"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* 状态卡片 */}
      {status && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {/* WeClaw 进程 */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              {status.weclaw_running ? (
                <Wifi className="h-4 w-4 text-green-400" />
              ) : (
                <WifiOff className="h-4 w-4 text-zinc-600" />
              )}
              WeClaw 进程
            </div>
            <p className={`mt-1 text-lg font-bold ${status.weclaw_running ? "text-green-400" : "text-zinc-500"}`}>
              {status.weclaw_running ? "运行中" : "未启动"}
            </p>
            {status.weclaw_version && (
              <p className="text-xs text-zinc-500">v{status.weclaw_version}</p>
            )}
          </div>

          {/* 微信连接 */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              {status.connected ? (
                <CheckCircle className="h-4 w-4 text-green-400" />
              ) : (
                <XCircle className="h-4 w-4 text-zinc-600" />
              )}
              微信连接
            </div>
            <p className={`mt-1 text-lg font-bold ${status.connected ? "text-green-400" : "text-zinc-500"}`}>
              {status.connected ? "已连接" : "等待消息"}
            </p>
            {status.bound_user && (
              <p className="text-xs text-zinc-500 truncate" title={status.bound_user}>
                {status.bound_user}
              </p>
            )}
          </div>

          {/* 消息统计 */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-sm text-zinc-400">消息总数</p>
            <p className="mt-1 text-lg font-bold text-white">
              {status.message_count}
            </p>
            <p className="text-xs text-zinc-500">
              最近: {formatTime(status.last_message_at)}
            </p>
          </div>

          {/* 运行时间 */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-sm text-zinc-400">运行时间</p>
            <p className="mt-1 text-lg font-bold text-white">
              {formatUptime(status.weclaw_uptime || 0)}
            </p>
            <p className="text-xs text-zinc-500 truncate" title={status.weclaw_api_url}>
              {status.weclaw_api_url}
            </p>
          </div>
        </div>
      )}

      {/* 最近错误 */}
      {status?.last_error && (
        <div className="rounded-lg border border-yellow-800 bg-yellow-900/10 px-4 py-3 text-sm text-yellow-400">
          最近错误: {status.last_error}
        </div>
      )}

      {/* 配置面板 */}
      {showConfig && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
          <h4 className="text-sm font-medium text-zinc-300">WeClaw 配置</h4>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">WeClaw API 地址</label>
            <input
              value={configUrl}
              onChange={(e) => setConfigUrl(e.target.value)}
              placeholder="http://127.0.0.1:18011"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">网关公开地址 (用于媒体 URL)</label>
            <input
              value={configGateway}
              onChange={(e) => setConfigGateway(e.target.value)}
              placeholder="http://127.0.0.1:8642"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowConfig(false)}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
            >
              取消
            </button>
            <button
              onClick={handleConfigSave}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              保存
            </button>
          </div>
        </div>
      )}

      {/* 主动推送 */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <h4 className="mb-3 text-sm font-medium text-zinc-300 flex items-center gap-2">
          <Send className="h-4 w-4" />
          主动推送消息到微信
        </h4>
        <form onSubmit={handlePush} className="space-y-3">
          <div className="flex gap-3">
            <input
              value={pushTo}
              onChange={(e) => setPushTo(e.target.value)}
              placeholder="目标用户 ID"
              className="w-1/3 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
            />
            <input
              value={pushText}
              onChange={(e) => setPushText(e.target.value)}
              placeholder="消息内容"
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={pushing || !pushTo.trim() || !pushText.trim()}
              className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {pushing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              发送
            </button>
          </div>
          {pushResult && (
            <p className={`text-xs ${pushResult.includes("成功") ? "text-green-400" : "text-red-400"}`}>
              {pushResult}
            </p>
          )}
        </form>
      </div>

      {/* 未启动提示 */}
      {!loading && !status?.weclaw_running && (
        <div className="rounded-lg border border-dashed border-zinc-700 p-6 text-center">
          <MessageSquare className="mx-auto h-10 w-10 text-zinc-600" />
          <p className="mt-3 text-sm text-zinc-400">
            WeClaw 未启动，请先运行安装脚本
          </p>
          <div className="mt-2 space-y-1 text-xs text-zinc-600 font-mono">
            <p># Windows</p>
            <p>powershell scripts\setup-weclaw.ps1</p>
            <p># Linux/macOS</p>
            <p>bash scripts/setup-weclaw.sh</p>
          </div>
        </div>
      )}
    </div>
  );
}
