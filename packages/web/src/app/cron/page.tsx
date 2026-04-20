"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import { useAgents } from "@/hooks/useAgents";
import { Clock, Plus, Trash2, Play, Pause, History, RefreshCw, Loader2 } from "lucide-react";

interface CronJob {
  id: string;
  name: string;
  expression: string;
  naturalLanguage?: string;
  agentId: string;
  message: string;
  enabled: boolean;
  timezone: string;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
}

interface CronHistoryEntry {
  id: string;
  jobId: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  result?: string;
  error?: string;
}

export default function CronPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const { agents } = useAgents();
  const [showCreate, setShowCreate] = useState(false);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [history, setHistory] = useState<CronHistoryEntry[]>([]);
  const [parsePreview, setParsePreview] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    expression: "",
    naturalLanguage: "",
    agentId: "",
    message: "",
    timezone: "Asia/Shanghai",
  });

  const fetchJobs = useCallback(() => {
    setLoading(true);
    apiFetch<{ jobs: CronJob[] }>("/api/cron/jobs")
      .then((data) => setJobs(data.jobs ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  const fetchHistory = async (jobId: string) => {
    setSelectedJob(jobId);
    const data = await apiFetch<{ history: CronHistoryEntry[] }>(`/api/cron/jobs/${jobId}/history`);
    setHistory(data.history ?? []);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除该定时任务？")) return;
    await apiFetch(`/api/cron/jobs/${id}`, { method: "DELETE" });
    fetchJobs();
  };

  const handleToggle = async (job: CronJob) => {
    await apiFetch(`/api/cron/jobs/${job.id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: !job.enabled }),
    });
    fetchJobs();
  };

  const handleRunNow = async (id: string) => {
    setRunning(id);
    try {
      await apiFetch(`/api/cron/jobs/${id}/run`, { method: "POST" });
      fetchJobs();
    } catch {}
    setRunning(null);
  };

  const handleParseNL = async () => {
    if (!form.naturalLanguage.trim()) return;
    try {
      const data = await apiFetch<{ expression: string }>("/api/cron/parse", {
        method: "POST",
        body: JSON.stringify({ text: form.naturalLanguage }),
      });
      setParsePreview(data.expression);
      setForm((f) => ({ ...f, expression: data.expression }));
    } catch {
      setParsePreview("解析失败");
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch("/api/cron/jobs", {
      method: "POST",
      body: JSON.stringify(form),
    });
    setShowCreate(false);
    setForm({ name: "", expression: "", naturalLanguage: "", agentId: "", message: "", timezone: "Asia/Shanghai" });
    setParsePreview("");
    fetchJobs();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">定时任务</h1>
          <p className="mt-1 text-zinc-400">管理 Cron 定时调度任务</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" /> 创建任务
        </button>
      </div>

      {loading ? (
        <div className="py-12 text-center text-zinc-500">加载中...</div>
      ) : jobs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 p-12 text-center">
          <Clock className="mx-auto h-12 w-12 text-zinc-600" />
          <p className="mt-4 text-zinc-400">暂无定时任务</p>
          <p className="mt-2 text-sm text-zinc-600">创建定时任务让 Agent 自动执行</p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <div key={job.id} className="group rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <h3 className="font-semibold text-white">{job.name}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${job.enabled ? "bg-green-600/10 text-green-400" : "bg-zinc-800 text-zinc-500"}`}>
                      {job.enabled ? "已启用" : "已停用"}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-zinc-400">
                    <span className="font-mono text-xs bg-zinc-800 px-2 py-0.5 rounded">{job.expression}</span>
                    {job.naturalLanguage && <span className="text-zinc-500">{job.naturalLanguage}</span>}
                  </div>
                  <p className="mt-2 text-sm text-zinc-500 line-clamp-1">消息: {job.message}</p>
                  <div className="mt-2 flex gap-4 text-xs text-zinc-600">
                    {job.lastRunAt && <span>上次运行: {new Date(job.lastRunAt).toLocaleString("zh-CN")}</span>}
                    {job.nextRunAt && <span>下次运行: {new Date(job.nextRunAt).toLocaleString("zh-CN")}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => handleToggle(job)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white" title={job.enabled ? "停用" : "启用"}>
                    {job.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </button>
                  <button onClick={() => handleRunNow(job.id)} disabled={running === job.id} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-blue-400" title="立即执行">
                    {running === job.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  </button>
                  <button onClick={() => fetchHistory(job.id)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-amber-400" title="查看历史">
                    <History className="h-4 w-4" />
                  </button>
                  <button onClick={() => handleDelete(job.id)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-red-400">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* History Panel */}
      {selectedJob && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-white flex items-center gap-2">
              <History className="h-5 w-5 text-amber-400" /> 执行历史
            </h3>
            <button onClick={() => setSelectedJob(null)} className="text-zinc-500 hover:text-white text-sm">关闭</button>
          </div>
          {history.length === 0 ? (
            <p className="text-zinc-500 text-sm">暂无执行记录</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {history.map((h) => (
                <div key={h.id} className="flex items-center justify-between rounded-lg bg-zinc-800/50 px-4 py-2 text-sm">
                  <div className="flex items-center gap-3">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${h.status === "success" ? "bg-green-600/10 text-green-400" : "bg-red-600/10 text-red-400"}`}>
                      {h.status}
                    </span>
                    <span className="text-zinc-400">{new Date(h.startedAt).toLocaleString("zh-CN")}</span>
                  </div>
                  {h.error && <span className="text-red-400 text-xs truncate max-w-48">{h.error}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowCreate(false)}>
          <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-white mb-4">创建定时任务</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm text-zinc-400 mb-1">任务名称</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none" required />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">自然语言描述（可选）</label>
                <div className="flex gap-2">
                  <input value={form.naturalLanguage} onChange={(e) => setForm({ ...form, naturalLanguage: e.target.value })} placeholder="例如：每周一早上9点" className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none" />
                  <button type="button" onClick={handleParseNL} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800">解析</button>
                </div>
                {parsePreview && <p className="mt-1 text-xs text-blue-400 font-mono">→ {parsePreview}</p>}
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Cron 表达式</label>
                <input value={form.expression} onChange={(e) => setForm({ ...form, expression: e.target.value })} placeholder="0 9 * * MON-FRI" className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white font-mono focus:border-blue-500 focus:outline-none" required />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">执行 Agent</label>
                <select value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none" required>
                  <option value="">选择 Agent</option>
                  {agents.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">发送消息</label>
                <textarea value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} rows={3} className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white focus:border-blue-500 focus:outline-none resize-none" required />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowCreate(false)} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-900">取消</button>
                <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">创建</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
