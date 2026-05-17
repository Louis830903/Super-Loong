"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { apiFetch } from "@/lib/utils";
import { ArrowUpCircle, RefreshCw, Download } from "lucide-react";
import type { VersionInfo } from "@super-agent/web-types";
import { useVersionWebSocket } from "@/hooks/use-version-websocket";

/** 安装状态枚举 */
type InstallPhase = "idle" | "installing" | "restarting" | "success" | "timeout" | "error";

/**
 * 版本检查 + 更新提示组件。
 * 可放在 Sidebar 底部或 Dashboard 顶部，支持手动刷新。
 *
 * @param variant  "footer" 侧边栏精简模式 / "banner" 仪表盘横幅模式
 */
export function VersionFooter({ variant = "footer" }: { variant?: "footer" | "banner" }) {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [installPhase, setInstallPhase] = useState<InstallPhase>("idle");
  const [installError, setInstallError] = useState<string | null>(null);
  const [targetVersion, setTargetVersion] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartRef = useRef<number>(0);

  // WebSocket 被动推送的版本信息（优先级高于手动 /api/version 轮询）
  const wsInfo = useVersionWebSocket();
  // 合并两个来源：WebSocket 推送优先
  const displayInfo = wsInfo ?? info;

  /** 手动触发版本检查（防重入） */
  const checkVersion = useCallback(() => {
    if (checking) return;
    setChecking(true);
    apiFetch<VersionInfo>("/api/version")
      .then((data) => setInfo(data))
      .catch(() => {
        /* 网络不可用时静默忽略 */
      })
      .finally(() => setChecking(false));
  }, [checking]);

  // 页面首次加载自动检查
  useEffect(() => { checkVersion(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 组件卸载时清理轮询定时器
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  /** 触发一键安装 */
  const handleInstall = useCallback(async () => {
    if (installPhase !== "idle") return;
    setInstallPhase("installing");
    setInstallError(null);
    try {
      const res = await apiFetch<{ status: string; version: string; message: string; error?: string }>(
        "/api/update/install",
        { method: "POST" },
      );
      if (res.status === "installing") {
        setTargetVersion(res.version);
        setInstallPhase("restarting");
        // 开始轮询 API 恢复
        startPolling(res.version);
      } else {
        // 安装失败（API 返回错误）
        setInstallPhase("error");
        setInstallError(res.error ?? "安装失败");
      }
    } catch (err: unknown) {
      // 请求本身失败（网络错误或 API 未响应）
      setInstallPhase("error");
      setInstallError((err as { message?: string }).message ?? "请求失败");
    }
  }, [installPhase]);

  /** 轮询 API 恢复 */
  const startPolling = useCallback((version: string) => {
    pollStartRef.current = Date.now();
    pollTimerRef.current = setInterval(async () => {
      try {
        const data = await apiFetch<VersionInfo>("/api/version");
        // API 恢复且版本号匹配 → 更新成功
        if (data.success && data.current === version) {
          stopPolling();
          setInstallPhase("success");
          setInfo(data);
          return;
        }
        // API 恢复但版本不匹配 → 可能仍是旧版，继续等待
        if (data.success) {
          setInfo(data);
        }
      } catch {
        // API 仍未恢复，继续等待
      }
      // 60 秒超时
      if (Date.now() - pollStartRef.current > 60_000) {
        stopPolling();
        setInstallPhase("timeout");
      }
    }, 2000);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // ── footer 模式：始终显示版本号 + 刷新按钮 ──
  if (variant === "footer") {
    const hasUpdate = displayInfo?.outdated && displayInfo?.latest;
    return (
      <div className="flex items-center justify-between gap-2">
        {/* 版本信息 */}
        {hasUpdate ? (
          <a
            href={displayInfo!.releaseUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 transition-colors min-w-0"
          >
            <ArrowUpCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">v{displayInfo!.current} → v{displayInfo!.latest}</span>
            {displayInfo!.source === "gitee" && (
              <span className="shrink-0 text-[10px] text-zinc-600">Gitee</span>
            )}
          </a>
        ) : (
          <p className="text-xs text-zinc-500 truncate" data-testid="version-display">
            Super Loong v{displayInfo?.current ?? info?.current ?? "0.1.0"}
          </p>
        )}

        {/* 手动刷新按钮 */}
        <button
          onClick={checkVersion}
          disabled={checking}
          title="检查更新"
          className="shrink-0 rounded p-0.5 text-zinc-600 hover:text-zinc-300 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${checking ? "animate-spin" : ""}`} />
        </button>
      </div>
    );
  }

  // ── banner 模式 ──

  // 查询中或查询失败 — 不显示（避免闪烁）
  if (!displayInfo || !displayInfo.success) {
    // 安装/重启状态下即使 API 不可用也要显示进度
    if (installPhase !== "idle") {
      return <InstallProgressBanner phase={installPhase} error={installError} targetVersion={targetVersion} onDismiss={() => setInstallPhase("idle")} />;
    }
    return null;
  }

  // 有新版本 — 显示更新横幅 + 安装按钮
  if (displayInfo.outdated && displayInfo.latest) {
    // 安装/重启状态
    if (installPhase !== "idle") {
      return <InstallProgressBanner phase={installPhase} error={installError} targetVersion={targetVersion} onDismiss={() => setInstallPhase("idle")} />;
    }

    return (
      <div className="flex items-center gap-3 rounded-xl border border-amber-700/50 bg-amber-900/20 px-4 py-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <ArrowUpCircle className="h-5 w-5 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-300">
              有新版本可用：v{displayInfo.latest}
            </p>
            <p className="text-xs text-amber-600">
              当前版本 v{displayInfo.current}
              {displayInfo.source === "gitee" && "（Gitee 镜像）"}
            </p>
          </div>
        </div>

        {/* 安装中禁用按钮避免重复点击 */}
        <button
          onClick={handleInstall}
          disabled={installPhase !== "idle"}
          className="shrink-0 flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Download className="h-4 w-4" />
          一键安装
        </button>

        <a
          href={displayInfo.releaseUrl ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded px-2 py-1.5 text-xs text-amber-500 hover:text-amber-300 hover:bg-amber-900/40 transition-colors"
        >
          手动下载
        </a>

        <button
          onClick={checkVersion}
          disabled={checking}
          title="重新检查"
          className="shrink-0 rounded p-1.5 text-amber-500 hover:text-amber-300 hover:bg-amber-900/40 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
        </button>
      </div>
    );
  }

  // 安装成功 — 绿色横幅
  if (installPhase === "success" && targetVersion) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-green-700/50 bg-green-900/20 px-4 py-3">
        <ArrowUpCircle className="h-5 w-5 shrink-0 text-green-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-green-300">
            已更新至 v{targetVersion}
          </p>
          <p className="text-xs text-green-600">
            所有服务已恢复正常运行
          </p>
        </div>
        <button
          onClick={() => setInstallPhase("idle")}
          className="shrink-0 rounded px-2 py-1 text-xs text-green-500 hover:text-green-300 transition-colors"
        >
          知道了
        </button>
      </div>
    );
  }

  // 已是最新 — 不显示（无更新无需打扰）
  return null;
}

/** 安装进度横幅子组件（抽取独立避免重复） */
function InstallProgressBanner({
  phase,
  error,
  targetVersion,
  onDismiss,
}: {
  phase: InstallPhase;
  error: string | null;
  targetVersion: string | null;
  onDismiss: () => void;
}) {
  if (phase === "installing") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-blue-700/50 bg-blue-900/20 px-4 py-3">
        <RefreshCw className="h-5 w-5 shrink-0 text-blue-400 animate-spin" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-blue-300">正在下载更新...</p>
          <p className="text-xs text-blue-600">
            {targetVersion ? `目标版本 v${targetVersion}` : ""}
          </p>
        </div>
      </div>
    );
  }

  if (phase === "restarting") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-blue-700/50 bg-blue-900/20 px-4 py-3">
        <RefreshCw className="h-5 w-5 shrink-0 text-blue-400 animate-spin" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-blue-300">更新已部署，服务正在重启...</p>
          <p className="text-xs text-blue-600">
            {targetVersion ? `目标版本 v${targetVersion}` : ""} — 预计 10-30 秒
          </p>
        </div>
      </div>
    );
  }

  if (phase === "timeout") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-amber-700/50 bg-amber-900/20 px-4 py-3">
        <ArrowUpCircle className="h-5 w-5 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-300">重启超时</p>
          <p className="text-xs text-amber-600">
            服务可能仍在启动中，请手动刷新页面检查
          </p>
        </div>
        <button
          onClick={() => window.location.reload()}
          className="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 transition-colors"
        >
          刷新页面
        </button>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-red-700/50 bg-red-900/20 px-4 py-3">
        <ArrowUpCircle className="h-5 w-5 shrink-0 text-red-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-red-300">安装失败</p>
          <p className="text-xs text-red-600">
            {error ?? "未知错误，请手动下载更新"}
          </p>
        </div>
        <button
          onClick={onDismiss}
          className="shrink-0 rounded px-2 py-1 text-xs text-red-500 hover:text-red-300 transition-colors"
        >
          重试
        </button>
      </div>
    );
  }

  return null;
}
