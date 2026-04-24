"use client";

/**
 * Traces Panel — 全链路追踪瀑布图组件
 *
 * 可嵌入 Dashboard 页面作为独立 Tab 使用。
 * 支持:
 * - 实时 SSE 接收新 Span
 * - 历史 Trace 列表查询
 * - 瀑布图展示（展开/收起 Span 树）
 * - 按状态/操作过滤
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { API_BASE } from "@/lib/utils";

// ─── 类型定义 ────────────────────────────────────

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operation: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: "ok" | "error" | "running";
  attributes: Record<string, unknown>;
}

interface TraceItem {
  traceId: string;
  startTime: number;
  endTime: number | null;
  spanCount: number;
  operations: string[];
  status: "ok" | "error";
  duration: number;
}

// ─── 组件 ────────────────────────────────────────

export function TracesPanel() {
  const [traces, setTraces] = useState<TraceItem[]>([]);
  const [liveSpans, setLiveSpans] = useState<Span[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);
  const [traceSpans, setTraceSpans] = useState<Span[]>([]);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [tracingEnabled, setTracingEnabled] = useState(false); // 后端追踪开关状态
  const [toggling, setToggling] = useState(false); // 开关操作中
  const evtSourceRef = useRef<EventSource | null>(null);

  // 加载历史 Trace 列表
  const loadTraces = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/traces`);
      if (res.ok) {
        const data = await res.json();
        if (data.traces) setTraces(data.traces);
        // 后端返回 enabled 字段表示追踪是否启用
        if (data.enabled === false) setTracingEnabled(false);
      }
    } catch {
      // API 未启用追踪或不可达
    }
  }, []);

  // SSE 实时连接
  useEffect(() => {
    loadTraces();

    const evt = new EventSource(`${API_BASE}/api/traces/live`);
    evtSourceRef.current = evt;

    evt.onopen = () => setConnected(true);
    evt.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        // 处理连接确认消息（含追踪启用状态）
        if (msg.type === "connected") {
          setConnected(true);
          setTracingEnabled(msg.enabled === true);
          return;
        }
        // 心跳消息携带最新追踪状态（支持动态开关同步）
        if (msg.type === "heartbeat") {
          setTracingEnabled(msg.enabled === true);
          return;
        }
        if (msg.type === "span") {
          setLiveSpans((prev) => [...prev.slice(-200), msg]);
        }
      } catch {}
    };
    evt.onerror = () => setConnected(false);

    return () => {
      evt.close();
      evtSourceRef.current = null;
    };
  }, [loadTraces]);

  // 加载单条 Trace 详情
  const loadTraceDetail = async (traceId: string) => {
    setSelectedTrace(traceId);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/traces/${traceId}`);
      if (res.ok) {
        const data = await res.json();
        setTraceSpans(data.spans || []);
      }
    } catch {
      setTraceSpans([]);
    }
    setLoading(false);
  };

  // 动态开关追踪
  const toggleTracing = async () => {
    setToggling(true);
    try {
      const res = await fetch(`${API_BASE}/api/traces/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !tracingEnabled }),
      });
      if (res.ok) {
        const data = await res.json();
        setTracingEnabled(data.enabled);
        // 开启后刷新数据
        if (data.enabled) setTimeout(loadTraces, 500);
      }
    } catch {}
    setToggling(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* 状态栏 */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-700/50">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${connected ? (tracingEnabled ? "bg-green-400 animate-pulse" : "bg-yellow-400") : "bg-red-400"}`} />
          <span className="text-xs text-gray-400">
            {connected
              ? (tracingEnabled ? "实时追踪中" : "已连接 · 追踪已关闭")
              : "未连接"}
          </span>
        </div>
        <span className="text-xs text-gray-500">
          {traces.length} 条历史 · {liveSpans.length} 实时 Span
        </span>
        {/* 追踪开关 */}
        <button
          onClick={toggleTracing}
          disabled={toggling || !connected}
          className={`ml-auto flex items-center gap-1.5 text-xs px-3 py-1 rounded-full border transition
            ${tracingEnabled
              ? "border-green-600/50 bg-green-900/20 text-green-400 hover:bg-green-900/40"
              : "border-gray-600 bg-gray-800/50 text-gray-400 hover:border-blue-400 hover:text-blue-400"
            }
            ${toggling ? "opacity-50 cursor-wait" : ""}
            ${!connected ? "opacity-30 cursor-not-allowed" : ""}
          `}
        >
          {/* 开关滑块图标 */}
          <div className={`w-6 h-3.5 rounded-full relative transition-colors ${
            tracingEnabled ? "bg-green-500" : "bg-gray-600"
          }`}>
            <div className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-transform ${
              tracingEnabled ? "translate-x-3" : "translate-x-0.5"
            }`} />
          </div>
          <span>{toggling ? "切换中..." : (tracingEnabled ? "开" : "关")}</span>
        </button>
        <button
          onClick={loadTraces}
          className="text-xs px-2 py-1 rounded border border-gray-600 hover:border-blue-400 text-gray-400 hover:text-blue-400 transition"
        >
          刷新
        </button>
      </div>

      {/* 主体 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左侧: Trace 列表 */}
        <div className="w-1/2 border-r border-gray-700/50 overflow-y-auto p-2 space-y-1">
          {/* 实时 Span 流 */}
          {liveSpans.slice(-20).reverse().map((span, i) => (
            <div
              key={`live-${i}`}
              onClick={() => span.traceId && loadTraceDetail(span.traceId)}
              className={`p-2 rounded border cursor-pointer transition text-xs
                ${span.status === "error" ? "border-red-800/50 bg-red-900/10" : "border-gray-700/50 hover:border-blue-500/50"}
              `}
            >
              <div className="flex justify-between items-center">
                <span className="font-mono text-blue-400">{span.operation}</span>
                <span className={`px-1.5 py-0.5 rounded text-xs ${
                  span.status === "error" ? "bg-red-900/30 text-red-400" :
                  (span.duration || 0) > 2000 ? "bg-yellow-900/30 text-yellow-400" :
                  "bg-green-900/30 text-green-400"
                }`}>
                  {span.duration || 0}ms
                </span>
              </div>
              <div className="text-gray-500 mt-1 truncate">
                {span.traceId?.slice(0, 8)} · {new Date(span.startTime).toLocaleTimeString()}
              </div>
            </div>
          ))}

          {/* 历史列表 */}
          {traces.length > 0 && (
            <div className="mt-3 pt-2 border-t border-gray-700/30">
              <div className="text-xs text-gray-500 px-1 mb-1">历史记录</div>
              {traces.map((t) => (
                <div
                  key={t.traceId}
                  onClick={() => loadTraceDetail(t.traceId)}
                  className={`p-2 rounded border cursor-pointer transition text-xs mb-1
                    ${selectedTrace === t.traceId ? "border-blue-500 bg-blue-900/10" : "border-gray-700/50 hover:border-gray-600"}
                    ${t.status === "error" ? "border-l-2 border-l-red-500" : "border-l-2 border-l-green-600"}
                  `}
                >
                  <div className="flex justify-between">
                    <span className="text-gray-300">{t.operations[0] || "unknown"}</span>
                    <span className={`text-xs ${t.duration > 2000 ? "text-yellow-400" : "text-gray-500"}`}>
                      {t.duration}ms
                    </span>
                  </div>
                  <div className="text-gray-500 text-xs mt-0.5">
                    {t.spanCount} spans · {new Date(t.startTime).toLocaleTimeString()}
                  </div>
                </div>
              ))}
            </div>
          )}

          {traces.length === 0 && liveSpans.length === 0 && (
            <div className="text-center text-gray-500 text-sm py-8">
              暂无追踪数据<br />
              <span className="text-xs">
                {!tracingEnabled ? "点击上方开关启用全链路追踪" : "追踪已开启，等待新请求产生数据..."}
              </span>
            </div>
          )}
        </div>

        {/* 右侧: Span 瀑布图 */}
        <div className="w-1/2 overflow-y-auto p-2">
          {selectedTrace && (
            <div>
              <div className="text-xs text-gray-400 mb-2 flex items-center gap-2">
                <span className="font-mono">{selectedTrace.slice(0, 12)}...</span>
                {loading && <span className="text-blue-400">加载中...</span>}
              </div>

              {traceSpans.length > 0 && (
                <WaterfallChart spans={traceSpans} />
              )}
            </div>
          )}

          {!selectedTrace && (
            <div className="text-center text-gray-500 text-sm py-8">
              点击左侧 Trace 查看详情
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── 瀑布图子组件 ────────────────────────────────

function WaterfallChart({ spans }: { spans: Span[] }) {
  if (spans.length === 0) return null;

  const minTime = spans[0].startTime;
  const maxTime = Math.max(...spans.map((s) => s.endTime || s.startTime));
  const totalDuration = maxTime - minTime || 1;

  return (
    <div className="space-y-0.5">
      {spans.map((span) => {
        const left = ((span.startTime - minTime) / totalDuration) * 100;
        const width = Math.max(1, ((span.duration || 1) / totalDuration) * 100);
        const barColor = span.status === "error" ? "bg-red-500" :
          (span.duration || 0) > 2000 ? "bg-yellow-500" : "bg-green-500";

        return (
          <div key={span.spanId} className="flex items-center gap-2 text-[11px] py-0.5 group">
            {/* 操作名 */}
            <div className="w-28 truncate text-gray-400 flex-shrink-0" title={span.operation}>
              {span.operation}
            </div>
            {/* 瀑布条 */}
            <div className="flex-1 h-4 relative bg-gray-800/50 rounded overflow-hidden">
              <div
                className={`absolute top-0 h-full rounded ${barColor} opacity-80 group-hover:opacity-100 transition`}
                style={{ left: `${left}%`, width: `${width}%`, minWidth: "2px" }}
              />
            </div>
            {/* 耗时 */}
            <div className="w-14 text-right text-gray-500 flex-shrink-0">
              {span.duration || 0}ms
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default TracesPanel;
