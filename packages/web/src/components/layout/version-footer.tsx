"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import type { VersionInfo } from "@super-agent/web-types";

/**
 * 版本检查 + 更新提示组件。
 * 可放在 Sidebar 底部或 Dashboard 顶部，支持手动刷新。
 *
 * @param variant  "footer" 侧边栏精简模式 / "banner" 仪表盘横幅模式
 */
export function VersionFooter({ variant = "footer" }: { variant?: "footer" | "banner" }) {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [checking, setChecking] = useState(false);

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

  // ── footer 模式：始终显示版本号 + 刷新按钮 ──
  if (variant === "footer") {
    const hasUpdate = info?.outdated && info?.latest;
    return (
      <div className="flex items-center justify-between gap-2">
        {/* 版本信息 */}
        {hasUpdate ? (
          <a
            href={info!.releaseUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 transition-colors min-w-0"
          >
            <ArrowUpCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">v{info!.current} → v{info!.latest}</span>
            {info!.source === "gitee" && (
              <span className="shrink-0 text-[10px] text-zinc-600">Gitee</span>
            )}
          </a>
        ) : (
          <p className="text-xs text-zinc-500 truncate">
            Super Loong v{info?.current ?? "0.1.0"}
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
  if (!info || !info.success) {
    return null;
  }

  // 有新版本 — 显示更新横幅 + 重新检查按钮
  if (info.outdated && info.latest) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-amber-700/50 bg-amber-900/20 px-4 py-3">
        <a
          href={info.releaseUrl ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 min-w-0 flex-1 transition-colors hover:opacity-80"
        >
          <ArrowUpCircle className="h-5 w-5 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-300">
              有新版本可用：v{info.latest}
            </p>
            <p className="text-xs text-amber-600">
              当前版本 v{info.current} — 点击前往下载
              {info.source === "gitee" && "（Gitee 镜像）"}
            </p>
          </div>
          <span className="shrink-0 rounded bg-amber-600/30 px-2 py-1 text-xs font-medium text-amber-300">
            更新
          </span>
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

  // 已是最新 — 不显示（无更新无需打扰）
  return null;
}
