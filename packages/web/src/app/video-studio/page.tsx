"use client";

/**
 * 视频工作室 — 一句话出片 + Agent 模型配置 + 任务管理
 *
 * 功能：
 *   1. 输入主题 → 一键创建视频任务
 *   2. 6 Agent × Provider/Model 矩阵配置
 *   3. 一键套用 4 个系统预设
 *   4. 任务列表 + WS 实时进度
 *   5. 成本预估展示
 */

import { useState, useEffect, useCallback } from "react";
import { apiFetch, showToast } from "@/lib/utils";
import { useWebSocket } from "@/hooks/useWebSocket";
// CTR-P1-01/03：Agent ID 单一数据源，替换原先前端硬编码字符串
import { VIDEO_AGENT_IDS } from "@super-agent/web-types";
import {
  Play,
  Loader2,
  Trash2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Zap,
  DollarSign,
  CheckCircle2,
  XCircle,
  Clock,
  Video,
  Pencil,
  Save,
  X,
  Copy,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── 类型 ──────────────────────────────────────────────────

interface ProviderOverride {
  providerId: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

interface ProviderTemplate {
  id: string;
  name: string;
  description: string;
  providers: Record<string, ProviderOverride>;
  isPreset: boolean;
  createdAt: number;
}

interface VideoJob {
  id: string;
  status: string;
  input_json: string;
  progress_json?: string;
  output_json?: string;
  error?: string;
  cost_estimate_cny: number;
  cost_actual_cny?: number;
  created_at: number;
  updated_at: number;
}

interface CostEstimate {
  estimate_cny: number;
  unit_price: number;
  scenes: number;
  workflow: string;
}

// /api/models/providers 返回的 provider + 其下可选 model 结构，
// 仅保留前端下拉需要用到的字段
interface AvailableModel {
  id: string;
  name: string;
}
interface AvailableProvider {
  id: string;
  name: string;
  keyStatus: "configured" | "missing";
  models: AvailableModel[];
}

// ─── Agent ID 列表 ─────────────────────────────────────────

// CTR-P1-01/03：id 直接引用 @super-agent/web-types.VIDEO_AGENT_IDS（单一数据源），
// core 侧 video-crew-presets.ts 同样从该包 re-export，彻底消除"前端硬编码字符串
// vs 后端常量"双份维护隐患；label/desc 仅为前端展示文案，可自由调整。
const AGENT_IDS = [
  { id: VIDEO_AGENT_IDS.WRITER, label: "编剧 Agent", desc: "生成脚本和旁白" },
  { id: VIDEO_AGENT_IDS.DESIGNER, label: "设计 Agent", desc: "生成画面提示词" },
  { id: VIDEO_AGENT_IDS.STORYBOARD, label: "分镜 Agent", desc: "组装分镜表" },
  { id: VIDEO_AGENT_IDS.VOICE, label: "配音 Agent", desc: "TTS 语音合成" },
  { id: VIDEO_AGENT_IDS.VIDEO, label: "视觉 Agent", desc: "图片/视频生成" },
  { id: VIDEO_AGENT_IDS.EDITOR, label: "剪辑 Agent", desc: "合成最终视频" },
];

// ─── 状态样式映射 ──────────────────────────────────────────

const STATUS_MAP: Record<string, { label: string; color: string; icon: typeof Clock }> = {
  pending: { label: "等待中", color: "text-zinc-400", icon: Clock },
  queued: { label: "排队中", color: "text-yellow-400", icon: Clock },
  running: { label: "生成中", color: "text-blue-400", icon: Loader2 },
  succeeded: { label: "已完成", color: "text-green-400", icon: CheckCircle2 },
  failed: { label: "失败", color: "text-red-400", icon: XCircle },
  cancelled: { label: "已取消", color: "text-zinc-500", icon: XCircle },
  deleted: { label: "已删除", color: "text-zinc-600", icon: Trash2 },
};

// ─── 主页面组件 ─────────────────────────────────────────────

export default function VideoStudioPage() {
  // 创建任务表单
  const [topic, setTopic] = useState("");
  const [creating, setCreating] = useState(false);

  // 模板和预设
  const [templates, setTemplates] = useState<ProviderTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");

  // 可用 provider / model 列表（仅保留已配 Key 的），作为下拉可选值
  const [availableProviders, setAvailableProviders] = useState<AvailableProvider[]>([]);

  // 编辑态：进入后每个 Agent 行变为 provider/model 双下拉。
  // editingTemplate === null 表示"从预设克隆来的匿名草稿"，可另存为新模板；
  // editingTemplate 非 null 表示正在编辑已有用户模板，可原地 PUT 保存。
  const [isEditing, setIsEditing] = useState(false);
  const [editingProviders, setEditingProviders] = useState<Record<string, ProviderOverride>>({});
  const [editingTemplate, setEditingTemplate] = useState<ProviderTemplate | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingDescription, setEditingDescription] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);

  // 任务列表
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);

  // 配置面板展开
  const [showConfig, setShowConfig] = useState(false);

  // WS 实时进度
  const { lastEvent } = useWebSocket({ topics: ["video:*"] });

  // ─── 加载模板列表 ──────────────────────────────────────────

  const loadTemplates = useCallback(async () => {
    try {
      const data = await apiFetch<{ templates: ProviderTemplate[] }>(
        "/api/video/provider-templates"
      );
      setTemplates(data.templates);
      // 默认选中第一个预设
      if (data.templates.length > 0 && !selectedTemplateId) {
        setSelectedTemplateId(data.templates[0].id);
      }
    } catch {
      // apiFetch 已处理错误提示
    }
  }, [selectedTemplateId]);

  // ─── 加载任务列表 ──────────────────────────────────────────

  const loadJobs = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiFetch<{ jobs: VideoJob[] }>("/api/video/jobs?limit=20");
      setJobs(data.jobs || []);
    } catch {
      // 已处理
    } finally {
      setLoading(false);
    }
  }, []);

  // ─── 加载已配 Key 的 provider + 其可选 model ───────────────
  // 过滤掉未配 Key 的 provider，只把"真的能用"的选项塞进下拉
  const loadProviders = useCallback(async () => {
    try {
      const data = await apiFetch<{ providers: AvailableProvider[] }>(
        "/api/models/providers"
      );
      const usable = (data.providers || []).filter(
        (p) => p.keyStatus === "configured" && Array.isArray(p.models) && p.models.length > 0
      );
      setAvailableProviders(usable);
    } catch {
      // 已处理
    }
  }, []);

  // ─── 初始化 ────────────────────────────────────────────────

  useEffect(() => {
    loadTemplates();
    loadJobs();
    loadProviders();
  }, [loadTemplates, loadJobs, loadProviders]);

  // ─── WS 进度更新 ──────────────────────────────────────────

  useEffect(() => {
    if (!lastEvent || !lastEvent.topic.startsWith("video:")) return;
    const eventData = lastEvent.data as Record<string, unknown>;
    const jobId = eventData.jobId as string;
    if (!jobId) return;

    // 更新本地任务状态
    setJobs((prev) =>
      prev.map((j) => {
        if (j.id !== jobId) return j;
        const status = (eventData.status as string) || j.status;
        return { ...j, status, updated_at: Date.now() };
      })
    );
  }, [lastEvent]);

  // ─── 创建视频任务 ──────────────────────────────────────────

  const handleCreate = async () => {
    if (!topic.trim()) {
      showToast("请输入视频主题", "error");
      return;
    }
    setCreating(true);
    try {
      const body: Record<string, unknown> = {
        topic: topic.trim(),
        cost_confirmed: true,
      };
      // 优先级：编辑中的草稿（inline override）> 选中的模板 id > Agent 默认
      if (isEditing && Object.keys(editingProviders).length > 0) {
        body.agent_providers = editingProviders;
      } else if (selectedTemplateId) {
        body.agent_provider_template_id = selectedTemplateId;
      }
      await apiFetch("/api/video/jobs", {
        method: "POST",
        body: JSON.stringify(body),
      });
      showToast("视频任务已创建，正在排队处理", "success");
      setTopic("");
      loadJobs();
    } catch {
      // 已处理
    } finally {
      setCreating(false);
    }
  };

  // ─── 删除任务 ──────────────────────────────────────────────

  const handleDelete = async (id: string) => {
    try {
      await apiFetch(`/api/video/jobs/${id}`, { method: "DELETE" });
      showToast("任务已删除", "success");
      setJobs((prev) => prev.filter((j) => j.id !== id));
    } catch {
      // 已处理
    }
  };

  // ─── 模板编辑态 handlers ──────────────────────────────────

  // 从任意模板（系统预设或用户模板）克隆一份到编辑态。
  // editingTemplate=null 代表"从预设克隆的匿名草稿"，只能另存为新模板；
  // editingTemplate 非 null 代表正在编辑已有用户模板，可以原地 PUT 覆盖。
  const enterEditingFromTemplate = (tpl: ProviderTemplate, asClone: boolean) => {
    setIsEditing(true);
    setEditingProviders({ ...tpl.providers });
    if (asClone) {
      setEditingTemplate(null);
      setEditingName(`${tpl.name} (副本)`);
      setEditingDescription(tpl.description || "");
    } else {
      setEditingTemplate(tpl);
      setEditingName(tpl.name);
      setEditingDescription(tpl.description || "");
    }
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditingProviders({});
    setEditingTemplate(null);
    setEditingName("");
    setEditingDescription("");
  };

  // 更新编辑态中某 Agent 的 provider（provider 变更会联动清空 model，避免脏数据）
  const updateAgentProvider = (agentId: string, providerId: string) => {
    const prov = availableProviders.find((p) => p.id === providerId);
    const firstModel = prov?.models[0]?.id || "";
    setEditingProviders((prev) => ({
      ...prev,
      [agentId]: { providerId, model: firstModel },
    }));
  };

  // 更新编辑态中某 Agent 的 model
  const updateAgentModel = (agentId: string, model: string) => {
    setEditingProviders((prev) => {
      const existing = prev[agentId];
      if (!existing) return prev;
      return { ...prev, [agentId]: { ...existing, model } };
    });
  };

  // 保存：若 editingTemplate 非空 → PUT 覆盖；若为空 → POST 另存为新模板
  const handleSaveTemplate = async (asNew: boolean) => {
    if (!editingName.trim()) {
      showToast("请填写模板名称", "error");
      return;
    }
    setSavingTemplate(true);
    try {
      if (!asNew && editingTemplate) {
        // PUT 更新已有用户模板
        const updated = await apiFetch<ProviderTemplate>(
          `/api/video/provider-templates/${editingTemplate.id}`,
          {
            method: "PUT",
            body: JSON.stringify({
              name: editingName.trim(),
              description: editingDescription.trim(),
              providers: editingProviders,
            }),
          }
        );
        showToast("模板已保存", "success");
        await loadTemplates();
        setSelectedTemplateId(updated.id);
      } else {
        // POST 新建
        const created = await apiFetch<ProviderTemplate>(
          "/api/video/provider-templates",
          {
            method: "POST",
            body: JSON.stringify({
              name: editingName.trim(),
              description: editingDescription.trim(),
              providers: editingProviders,
            }),
          }
        );
        showToast("模板已新建", "success");
        await loadTemplates();
        setSelectedTemplateId(created.id);
      }
      cancelEditing();
    } catch {
      // 已处理
    } finally {
      setSavingTemplate(false);
    }
  };

  // 删除用户模板（系统预设的删除按钮不会渲染，无需额外守护）
  const handleDeleteTemplate = async (id: string) => {
    if (!confirm("确定要删除这个模板吗？")) return;
    try {
      await apiFetch(`/api/video/provider-templates/${id}`, { method: "DELETE" });
      showToast("模板已删除", "success");
      if (selectedTemplateId === id) setSelectedTemplateId("");
      await loadTemplates();
    } catch {
      // 已处理
    }
  };

  // ─── 渲染 ──────────────────────────────────────────────────

  const presets = templates.filter((t) => t.isPreset);
  const userTemplates = templates.filter((t) => !t.isPreset);

  return (
    <div className="space-y-8">
      {/* 页面标题 */}
      <div>
        <h1 className="text-2xl font-bold text-white">视频工作室</h1>
        <p className="mt-1 text-sm text-zinc-400">
          一句话出片 — 输入主题，AI 自动编剧、绘图、配音、合成
        </p>
      </div>

      {/* ─── 创建任务卡片 ────────────────────────────────── */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <div className="flex items-center gap-3 mb-4">
          <Video className="h-5 w-5 text-blue-400" />
          <h2 className="text-lg font-semibold text-white">创建视频</h2>
        </div>

        {/* 主题输入 */}
        <div className="flex gap-3">
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !creating && handleCreate()}
            placeholder="输入视频主题，如：介绍咖啡因的短视频"
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            onClick={handleCreate}
            disabled={creating || !topic.trim()}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            开始生成
          </button>
        </div>

        {/* 模型配置折叠面板 */}
        <button
          onClick={() => setShowConfig(!showConfig)}
          className="mt-4 flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
        >
          {showConfig ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          模型配置
        </button>

        {showConfig && (
          <div className="mt-4 space-y-4">
            {/* 系统预设按钮：编辑态下切换预设意义不大，直接隐藏整个选择条 */}
            {!isEditing && (
              <div>
                <p className="text-xs text-zinc-500 mb-2">快速选择预设方案</p>
                <div className="flex flex-wrap gap-2">
                  {presets.map((tpl) => (
                    <button
                      key={tpl.id}
                      onClick={() => setSelectedTemplateId(tpl.id)}
                      className={cn(
                        "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border",
                        selectedTemplateId === tpl.id
                          ? "border-blue-500 bg-blue-600/10 text-blue-400"
                          : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-600"
                      )}
                    >
                      <Zap className="inline h-3 w-3 mr-1" />
                      {tpl.name}
                    </button>
                  ))}
                  <button
                    onClick={() => setSelectedTemplateId("")}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border",
                      !selectedTemplateId
                        ? "border-blue-500 bg-blue-600/10 text-blue-400"
                        : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-600"
                    )}
                  >
                    默认配置
                  </button>
                </div>
              </div>
            )}

            {/* ─── 编辑态卡片（克隆草稿 / 编辑用户模板） ─── */}
            {isEditing && (
              <div className="rounded-lg border border-blue-500/40 bg-blue-500/5 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Pencil className="h-4 w-4 text-blue-400" />
                  <span className="text-sm font-medium text-white">
                    {editingTemplate ? "编辑模板" : "自定义草稿"}
                  </span>
                  <span className="text-[10px] text-zinc-500 ml-auto">
                    {editingTemplate ? "保存后覆盖原模板" : "保存后会新建模板"}
                  </span>
                </div>

                {/* 名称 + 描述 */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <input
                    type="text"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    placeholder="模板名称"
                    className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none"
                  />
                  <input
                    type="text"
                    value={editingDescription}
                    onChange={(e) => setEditingDescription(e.target.value)}
                    placeholder="模板描述（可选）"
                    className="md:col-span-2 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none"
                  />
                </div>

                {/* 可编辑的 Agent × Provider/Model 矩阵 */}
                {availableProviders.length === 0 ? (
                  <div className="text-xs text-yellow-400 px-3 py-2 bg-yellow-500/10 rounded-md">
                    请先在"设置 → 模型配置"中至少配置一个 Provider 的 API Key，才能选择模型。
                  </div>
                ) : (
                  <div className="space-y-2">
                    {AGENT_IDS.map((agent) => {
                      const current = editingProviders[agent.id];
                      const selectedProv = availableProviders.find(
                        (p) => p.id === current?.providerId
                      );
                      return (
                        <div key={agent.id} className="grid grid-cols-1 md:grid-cols-[7rem_1fr_1fr] gap-2 items-center">
                          <div>
                            <p className="text-xs text-white">{agent.label.replace(" Agent", "")}</p>
                            <p className="text-[10px] text-zinc-500">{agent.desc}</p>
                          </div>
                          {/* Provider 下拉 */}
                          <select
                            value={current?.providerId || ""}
                            onChange={(e) => updateAgentProvider(agent.id, e.target.value)}
                            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
                          >
                            <option value="">— 使用默认 —</option>
                            {availableProviders.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                            {/* 模板中的 provider 若当前不在已配 Key 列表中，保留显示避免字段丢失 */}
                            {current?.providerId &&
                              !availableProviders.some((p) => p.id === current.providerId) && (
                                <option value={current.providerId}>
                                  {current.providerId}（未配 Key）
                                </option>
                              )}
                          </select>
                          {/* Model 下拉 */}
                          <select
                            value={current?.model || ""}
                            onChange={(e) => updateAgentModel(agent.id, e.target.value)}
                            disabled={!current?.providerId}
                            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none disabled:opacity-50"
                          >
                            {!current?.providerId && <option value="">— 先选 Provider —</option>}
                            {selectedProv?.models.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name || m.id}
                              </option>
                            ))}
                            {current?.model &&
                              selectedProv &&
                              !selectedProv.models.some((m) => m.id === current.model) && (
                                <option value={current.model}>{current.model}（不在列表）</option>
                              )}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* 操作栏 */}
                <div className="flex items-center gap-2 pt-2 border-t border-zinc-800">
                  <button
                    onClick={cancelEditing}
                    disabled={savingTemplate}
                    className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" />
                    取消
                  </button>
                  <div className="ml-auto flex items-center gap-2">
                    {/* 编辑用户模板时，额外提供"另存为新模板"入口 */}
                    {editingTemplate && (
                      <button
                        onClick={() => handleSaveTemplate(true)}
                        disabled={savingTemplate || !editingName.trim()}
                        className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                      >
                        <Copy className="h-3.5 w-3.5" />
                        另存为新模板
                      </button>
                    )}
                    <button
                      onClick={() => handleSaveTemplate(!editingTemplate)}
                      disabled={savingTemplate || !editingName.trim()}
                      className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                    >
                      {savingTemplate ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      {editingTemplate ? "保存" : "保存为新模板"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 当前选中预设详情（只读） */}
            {!isEditing && selectedTemplateId && (() => {
              const tpl = templates.find((t) => t.id === selectedTemplateId);
              if (!tpl) return null;
              return (
                <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-4">
                  <div className="flex items-center justify-between mb-3 gap-2">
                    <div className="min-w-0">
                      <h4 className="text-sm font-medium text-white truncate">{tpl.name}</h4>
                      <p className="text-xs text-zinc-500 truncate">{tpl.description}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {tpl.isPreset ? (
                        <>
                          <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-700 text-zinc-400">系统预设</span>
                          <button
                            onClick={() => enterEditingFromTemplate(tpl, true)}
                            className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                            title="基于此预设创建自定义模板"
                          >
                            <Copy className="h-3 w-3" />
                            基于此自定义
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => enterEditingFromTemplate(tpl, false)}
                            className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                          >
                            <Pencil className="h-3 w-3" />
                            编辑
                          </button>
                          <button
                            onClick={() => handleDeleteTemplate(tpl.id)}
                            className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/10 hover:border-red-500/40"
                          >
                            <Trash2 className="h-3 w-3" />
                            删除
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {/* Agent × Model 矩阵（只读） */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {AGENT_IDS.map((agent) => {
                      const override = tpl.providers[agent.id];
                      return (
                        <div key={agent.id} className="flex items-center gap-2 rounded-md bg-zinc-900/50 px-3 py-2">
                          <span className="text-xs text-zinc-400 w-16 shrink-0">{agent.label.replace(" Agent", "")}</span>
                          <span className="text-xs text-zinc-300 truncate">
                            {override ? `${override.providerId} / ${override.model}` : "—"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* 用户模板列表 */}
            {!isEditing && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-zinc-500">自定义模板</p>
                  <button
                    onClick={() => {
                      // 从当前选中的模板（或第一个预设）克隆一份作为新模板起点
                      const base =
                        templates.find((t) => t.id === selectedTemplateId) || presets[0];
                      if (base) enterEditingFromTemplate(base, true);
                    }}
                    disabled={templates.length === 0}
                    className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    <Copy className="h-3 w-3" />
                    新建模板
                  </button>
                </div>
                {userTemplates.length === 0 ? (
                  <p className="text-[11px] text-zinc-600">
                    暂无自定义模板。点击上方"基于此自定义"或"新建模板"开始配置。
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {userTemplates.map((tpl) => (
                      <button
                        key={tpl.id}
                        onClick={() => setSelectedTemplateId(tpl.id)}
                        className={cn(
                          "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border",
                          selectedTemplateId === tpl.id
                            ? "border-blue-500 bg-blue-600/10 text-blue-400"
                            : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-600"
                        )}
                      >
                        {tpl.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── 任务列表 ────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">任务列表</h2>
          <button
            onClick={loadJobs}
            className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
            刷新
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
            <Video className="h-10 w-10 mb-3 opacity-40" />
            <p className="text-sm">暂无视频任务</p>
            <p className="text-xs mt-1">输入主题开始创建第一个视频</p>
          </div>
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => {
              const status = STATUS_MAP[job.status] || STATUS_MAP.pending;
              const StatusIcon = status.icon;
              const input = (() => {
                try { return JSON.parse(job.input_json); } catch { return {}; }
              })();
              const isExpanded = expandedJob === job.id;
              const isRunning = job.status === "running";

              return (
                <div
                  key={job.id}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden"
                >
                  {/* 主行 */}
                  <div
                    className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-zinc-800/30 transition-colors"
                    onClick={() => setExpandedJob(isExpanded ? null : job.id)}
                  >
                    <StatusIcon
                      className={cn("h-5 w-5 shrink-0", status.color, isRunning && "animate-spin")}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">
                        {input.topic || "未知主题"}
                      </p>
                      <p className="text-xs text-zinc-500 mt-0.5">
                        {new Date(job.created_at).toLocaleString("zh-CN")} · {status.label}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {job.cost_estimate_cny > 0 && (
                        <span className="flex items-center gap-1 text-xs text-zinc-500">
                          <DollarSign className="h-3 w-3" />
                          ¥{job.cost_estimate_cny.toFixed(2)}
                        </span>
                      )}
                      {(job.status === "pending" || job.status === "queued" || job.status === "failed") && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(job.id); }}
                          className="p-1.5 rounded-md text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                          title="删除任务"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                      {isExpanded ? (
                        <ChevronUp className="h-4 w-4 text-zinc-500" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-zinc-500" />
                      )}
                    </div>
                  </div>

                  {/* 展开详情 */}
                  {isExpanded && (
                    <div className="border-t border-zinc-800 px-5 py-4 space-y-2 text-xs">
                      <div className="flex gap-2">
                        <span className="text-zinc-500 w-16">任务 ID</span>
                        <span className="text-zinc-300 font-mono">{job.id}</span>
                      </div>
                      <div className="flex gap-2">
                        <span className="text-zinc-500 w-16">状态</span>
                        <span className={status.color}>{status.label}</span>
                      </div>
                      {job.error && (
                        <div className="flex gap-2">
                          <span className="text-zinc-500 w-16">错误</span>
                          <span className="text-red-400">{job.error}</span>
                        </div>
                      )}
                      {job.output_json && (
                        <div className="flex gap-2">
                          <span className="text-zinc-500 w-16">产物</span>
                          <span className="text-green-400">
                            {(() => {
                              try {
                                const output = JSON.parse(job.output_json);
                                return output.mediaId ? `媒体 ID: ${output.mediaId}` : "已生成";
                              } catch { return "已生成"; }
                            })()}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
