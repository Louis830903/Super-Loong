"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import {
  ArrowRightLeft,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  FileText,
  Puzzle,
  Plug,
  Brain,
  User,
  Heart,
} from "lucide-react";

// ═══ 类型定义（与后端 openclaw-migration.ts 保持一致）═══════

interface MigrationItem {
  kind: string;
  label: string;
  status: "found" | "not_found" | "will_overwrite" | "conflict";
  detail: string;
}

interface MigrationPreview {
  openclawExists: boolean;
  openclawPath: string;
  items: MigrationItem[];
}

interface MigrationResult {
  kind: string;
  label: string;
  status: "migrated" | "skipped" | "conflict" | "not_found" | "error" | "found";
  message: string;
}

interface MigrationReport {
  success: boolean;
  results: MigrationResult[];
  summary: string;
}

// ═══ 图标映射 ═══════════════════════════════════════════════

const kindIcons: Record<string, React.ReactNode> = {
  soul: <Heart className="h-4 w-4 text-pink-400" />,
  memory: <Brain className="h-4 w-4 text-purple-400" />,
  user: <User className="h-4 w-4 text-blue-400" />,
  skills: <Puzzle className="h-4 w-4 text-amber-400" />,
  mcp: <Plug className="h-4 w-4 text-emerald-400" />,
  "daily-memory": <FileText className="h-4 w-4 text-cyan-400" />,
};

/** 状态徽章 */
function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "found":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400">
          <CheckCircle2 className="h-3 w-3" /> 已找到
        </span>
      );
    case "will_overwrite":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400">
          <AlertTriangle className="h-3 w-3" /> 将覆盖
        </span>
      );
    case "not_found":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-700/50 px-2 py-0.5 text-xs text-zinc-500">
          <XCircle className="h-3 w-3" /> 未找到
        </span>
      );
    case "migrated":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400">
          <CheckCircle2 className="h-3 w-3" /> 已迁移
        </span>
      );
    case "skipped":
    case "conflict":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400">
          <AlertTriangle className="h-3 w-3" /> 已跳过
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-400">
          <XCircle className="h-3 w-3" /> 失败
        </span>
      );
    default:
      return null;
  }
}

// ═══ 组件 ═══════════════════════════════════════════════════

export function MigrationCard() {
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);

  // 页面加载时自动检测 OpenClaw
  const fetchPreview = useCallback(async () => {
    try {
      const data = await apiFetch<MigrationPreview>("/api/migration/preview");
      setPreview(data);
    } catch {
      setError("无法连接到后端服务");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    fetchPreview();
  }, [fetchPreview]);

  // 执行迁移
  const handleMigrate = async () => {
    setMigrating(true);
    setError(null);
    try {
      const data = await apiFetch<MigrationReport>("/api/migration/execute", {
        method: "POST",
        body: JSON.stringify({ overwrite }),
      });
      setReport(data);
    } catch (err: any) {
      setError(err.message || "迁移失败");
    } finally {
      setMigrating(false);
    }
  };

  // 加载中
  if (!loaded) {
    return (
      <div className="mt-8">
        <div className="flex items-center gap-2 mb-4">
          <ArrowRightLeft className="h-5 w-5 text-amber-400" />
          <h2 className="text-xl font-bold text-white">数据迁移</h2>
        </div>
        <div className="flex h-24 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/50">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
        </div>
      </div>
    );
  }

  // 未检测到 OpenClaw
  if (!preview?.openclawExists) {
    return (
      <div className="mt-8">
        <div className="flex items-center gap-2 mb-4">
          <ArrowRightLeft className="h-5 w-5 text-zinc-500" />
          <h2 className="text-xl font-bold text-white">数据迁移</h2>
        </div>
        <p className="mt-1 text-sm text-zinc-400">从其他 Agent 平台一键迁移数据到 Super Agent</p>
        <div className="mt-4 rounded-xl border border-dashed border-zinc-700 bg-zinc-900/30 p-6 text-center">
          <ArrowRightLeft className="mx-auto h-8 w-8 text-zinc-600" />
          <p className="mt-3 text-sm text-zinc-500">未检测到 OpenClaw 数据目录</p>
          <p className="mt-1 text-xs text-zinc-600">
            如果您曾使用过 OpenClaw，请确保数据在 {preview?.openclawPath ?? "~/.openclaw"} 目录下
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-8">
      <div className="flex items-center gap-2 mb-4">
        <ArrowRightLeft className="h-5 w-5 text-amber-400" />
        <h2 className="text-xl font-bold text-white">数据迁移</h2>
      </div>
      <p className="mt-1 text-sm text-zinc-400">从其他 Agent 平台一键迁移数据到 Super Agent</p>

      {/* OpenClaw 迁移卡片 */}
      <div className="mt-4 rounded-xl border border-amber-500/20 bg-gradient-to-r from-amber-500/5 via-amber-500/3 to-transparent p-5">
        {/* 检测成功提示 */}
        <div className="flex items-center gap-2 mb-4">
          <CheckCircle2 className="h-4 w-4 text-amber-400" />
          <span className="text-sm font-medium text-amber-300">
            检测到 OpenClaw 数据目录 ({preview.openclawPath})
          </span>
        </div>

        {/* 预览列表 */}
        <div className="space-y-2 mb-5">
          {preview.items.map((item) => (
            <div
              key={item.kind}
              className="flex items-center justify-between rounded-lg bg-zinc-800/40 px-4 py-2.5"
            >
              <div className="flex items-center gap-3">
                {kindIcons[item.kind]}
                <div>
                  <span className="text-sm text-white">{item.label}</span>
                  <span className="ml-2 text-xs text-zinc-500">{item.detail}</span>
                </div>
              </div>
              <StatusBadge status={item.status} />
            </div>
          ))}
        </div>

        {/* 已执行的迁移报告 */}
        {report && (
          <div className="mb-5 rounded-lg border border-zinc-700 bg-zinc-900/50 p-4">
            <p className={`text-sm font-medium mb-3 ${report.success ? "text-emerald-400" : "text-red-400"}`}>
              {report.summary}
            </p>
            <div className="space-y-1.5">
              {report.results.map((r) => {
                const colorMap: Record<string, string> = {
                  migrated: "text-emerald-400",
                  skipped: "text-amber-400",
                  conflict: "text-amber-400",
                  not_found: "text-zinc-500",
                  error: "text-red-400",
                };
                return (
                  <div key={r.kind} className="flex items-center gap-2 text-xs">
                    <StatusBadge status={r.status} />
                    <span className={colorMap[r.status] ?? "text-zinc-400"}>{r.label}</span>
                    <span className="text-zinc-600">— {r.message}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 错误提示 */}
        {error && (
          <div className="mb-5 flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
            <XCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleMigrate}
            disabled={migrating}
            className="flex items-center gap-2 rounded-lg bg-amber-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
          >
            {migrating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                迁移中...
              </>
            ) : (
              <>
                <ArrowRightLeft className="h-4 w-4" />
                开始迁移
              </>
            )}
          </button>

          {/* 覆盖选项 */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-amber-500 focus:ring-amber-500/30"
            />
            <span className="text-xs text-zinc-400">覆盖已有数据</span>
          </label>

          {/* 重新检测按钮（迁移后显示） */}
          {report && (
            <button
              onClick={fetchPreview}
              className="flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              重新检测
            </button>
          )}
        </div>

        {/* 说明文字 */}
        <p className="mt-3 text-xs text-zinc-600">
          迁移不会删除 OpenClaw 的原始数据。已存在的条目会自动跳过，不会重复导入。
        </p>
      </div>
    </div>
  );
}
