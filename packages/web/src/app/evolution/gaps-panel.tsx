"use client";

/**
 * P1-1: 能力缺口展示面板（独立组件）
 *
 * 展示进化引擎在对话中自动检测到的"缺什么能力/工具"。
 * 调 GET /api/evolution/gaps。独立成组件，避免改动 773 行的 evolution/page.tsx 大文件。
 */

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import { AlertCircle, RefreshCw } from "lucide-react";

interface CapabilityGap {
  id: string;
  category: string;
  description: string;
  priority?: number;
  status?: string;
  detectedBy?: string;
  sampleResponse?: string;
}

export function GapsPanel() {
  const [gaps, setGaps] = useState<CapabilityGap[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchGaps = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ gaps: CapabilityGap[] }>(
        "/api/evolution/gaps",
      ).catch(() => ({ gaps: [] as CapabilityGap[] }));
      setGaps(data.gaps ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGaps();
  }, [fetchGaps]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">能力缺口</h3>
          <p className="text-sm text-zinc-400">系统在对话中自动发现你可能需要的能力/工具</p>
        </div>
        <button
          onClick={fetchGaps}
          disabled={loading}
          className="flex items-center gap-2 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
        >
          {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} 刷新
        </button>
      </div>

      {gaps.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
          <AlertCircle className="mx-auto h-8 w-8 text-zinc-600" />
          <p className="mt-2 text-sm text-zinc-500">
            暂未检测到能力缺口。当 Agent 在对话中表示"无法完成某事"或工具连续失败时，会自动出现在这里。
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {gaps.map((gap) => (
            <div key={gap.id} className="rounded-xl border border-amber-800/30 bg-amber-900/10 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-amber-600/20 px-2 py-0.5 text-xs text-amber-300">{gap.category}</span>
                    {gap.priority != null && (
                      <span className="text-xs text-zinc-500">优先级 {gap.priority}</span>
                    )}
                    {gap.status && <span className="text-xs text-zinc-500">· {gap.status}</span>}
                  </div>
                  <p className="mt-2 text-sm text-white">{gap.description}</p>
                  {gap.sampleResponse && (
                    <p className="mt-1 text-xs text-zinc-500 line-clamp-2">来源：{gap.sampleResponse}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
