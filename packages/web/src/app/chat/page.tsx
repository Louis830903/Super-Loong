"use client";

import { useEffect, useRef, useState, useCallback, memo, useMemo } from "react";
import { useAgents } from "@/hooks/useAgents";
import { apiFetch, API_BASE } from "@/lib/utils";
import { cn } from "@/lib/utils";
import {
  Send, Bot, User, Loader2, Trash2,
  Paperclip, X, Image as ImageIcon, FileText, Mic, MicOff,
  Settings2, Plus, MessageSquare, Search, Pencil, Check,
  PanelLeftClose, PanelLeftOpen,
  CheckCircle2, XCircle, ChevronRight, Wrench,
  Volume2, VolumeX, ChevronDown,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────

interface Conversation {
  id: string;
  agentId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
  lastMessageRole: string | null;
  modelOverride?: string | null;
}

interface Attachment {
  id: string;
  file: File;
  preview?: string;
  type: "image" | "file";
}

interface ToolCallEntry {
  toolCallId: string;
  name: string;
  args?: string;
  status: "calling" | "success" | "error";
  output?: string;
  error?: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  attachments?: { name: string; type: string; preview?: string }[];
  toolCalls?: ToolCallEntry[];
}

// ─── C-2: ToolCallCard 提取为独立 memo 组件，避免父组件重渲染时重建 ───
const ToolCallCard = memo(({ tc }: { tc: ToolCallEntry }) => {
  const [expanded, setExpanded] = useState(false);
  const statusIcon = tc.status === "calling"
    ? <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />
    : tc.status === "success"
      ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
      : <XCircle className="h-4 w-4 text-red-400" />;
  const statusLabel = tc.status === "calling" ? "执行中..." : tc.status === "success" ? "完成" : "失败";
  const statusColor = tc.status === "calling" ? "text-blue-400" : tc.status === "success" ? "text-emerald-400" : "text-red-400";
  const borderColor = tc.status === "calling" ? "border-blue-500/30" : tc.status === "success" ? "border-emerald-500/20" : "border-red-500/30";

  let argsDisplay = tc.args ?? "";
  try { if (argsDisplay) argsDisplay = JSON.stringify(JSON.parse(argsDisplay), null, 2); } catch { /* keep raw */ }

  return (
    <div className={cn("my-2 rounded-lg border bg-zinc-900/60", borderColor)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-800/40 transition-colors rounded-lg"
      >
        <Wrench className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
        <span className="font-medium text-zinc-200 truncate">{tc.name}</span>
        <span className={cn("ml-auto flex items-center gap-1.5 shrink-0 text-xs", statusColor)}>
          {statusIcon}
          {statusLabel}
        </span>
        <ChevronRight className={cn("h-3.5 w-3.5 text-zinc-500 shrink-0 transition-transform", expanded && "rotate-90")} />
      </button>
      {expanded && (
        <div className="border-t border-zinc-800 px-3 py-2 space-y-2 text-xs">
          {argsDisplay && (
            <div>
              <p className="mb-1 font-medium text-zinc-500">输入参数</p>
              <pre className="max-h-40 overflow-auto rounded bg-zinc-950 p-2 text-zinc-400 whitespace-pre-wrap break-all">{argsDisplay}</pre>
            </div>
          )}
          {tc.output && (
            <div>
              <p className="mb-1 font-medium text-zinc-500">执行结果</p>
              <pre className="max-h-40 overflow-auto rounded bg-zinc-950 p-2 text-zinc-400 whitespace-pre-wrap break-all">{tc.output}</pre>
            </div>
          )}
          {tc.error && (
            <div>
              <p className="mb-1 font-medium text-red-400/80">错误</p>
              <pre className="rounded bg-red-950/30 p-2 text-red-300 whitespace-pre-wrap break-all">{tc.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
ToolCallCard.displayName = "ToolCallCard";

/**
 * P1-5: 可搜索的 Agent 选择器 Combobox
 * - 支持按名称/部门搜索过滤
 * - 自建 Agent 置顶，内置按部门分组
 * - 点击外部自动关闭
 */
import type { AgentInfo } from "@/hooks/useAgents";
// P3-17: 文件工具函数提取到独立模块
import { isTextFile, isParseableFile, readFileAsText, readFileAsBase64 } from "@/lib/file-utils";
function AgentCombobox({ agents, selectedAgent, onSelect }: {
  agents: AgentInfo[];
  selectedAgent: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const comboRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // 搜索过滤
  const filtered = useMemo(() => {
    if (!query) return agents;
    const q = query.toLowerCase();
    return agents.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.departmentLabel?.toLowerCase().includes(q) ||
      a.department?.toLowerCase().includes(q)
    );
  }, [agents, query]);

  // 分组：自建置顶 + 内置按部门
  const groups = useMemo(() => {
    const userAgents = filtered.filter(a => !a.isBuiltin);
    const builtinAgents = filtered.filter(a => a.isBuiltin);
    const deptMap = new Map<string, AgentInfo[]>();
    for (const a of builtinAgents) {
      const dept = a.department || "other";
      if (!deptMap.has(dept)) deptMap.set(dept, []);
      deptMap.get(dept)!.push(a);
    }
    return { userAgents, deptGroups: Array.from(deptMap.entries()) };
  }, [filtered]);

  const selectedName = agents.find(a => a.id === selectedAgent)?.name || "选择 Agent";

  return (
    <div ref={comboRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm text-white text-left flex items-center justify-between hover:border-zinc-700 focus:border-blue-500 focus:outline-none"
      >
        <span className="truncate">{selectedName}</span>
        <ChevronDown className="h-3.5 w-3.5 text-zinc-500 flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl max-h-80 flex flex-col">
          {/* 搜索框 */}
          <div className="p-2 border-b border-zinc-800/50">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索 Agent..."
                className="w-full rounded border border-zinc-800 bg-zinc-900 pl-7 pr-2 py-1 text-xs text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>

          {/* 列表区域 */}
          <div className="overflow-y-auto flex-1">
            {filtered.length === 0 ? (
              <div className="p-3 text-xs text-zinc-500 text-center">无匹配结果</div>
            ) : (
              <>
                {/* 自建 Agent */}
                {groups.userAgents.length > 0 && (
                  <div>
                    <div className="px-2 py-1 text-xs font-medium text-zinc-500 uppercase tracking-wider">我的 Agent</div>
                    {groups.userAgents.map(a => (
                      <button
                        key={a.id}
                        onClick={() => { onSelect(a.id); setOpen(false); setQuery(""); }}
                        className={cn(
                          "w-full px-2 py-1.5 text-left text-xs hover:bg-zinc-800/50 flex items-center gap-2",
                          selectedAgent === a.id && "bg-blue-600/10 text-blue-400"
                        )}
                      >
                        <Bot className="h-3.5 w-3.5 flex-shrink-0 text-zinc-400" />
                        <span className="truncate">{a.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                {/* 内置按部门 */}
                {groups.deptGroups.map(([dept, deptAgents]) => (
                  <div key={dept}>
                    <div className="px-2 py-1 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                      {deptAgents[0]?.departmentLabel || dept} ({deptAgents.length})
                    </div>
                    {deptAgents.map(a => (
                      <button
                        key={a.id}
                        onClick={() => { onSelect(a.id); setOpen(false); setQuery(""); }}
                        className={cn(
                          "w-full px-2 py-1.5 text-left text-xs hover:bg-zinc-800/50 flex items-center gap-2",
                          selectedAgent === a.id && "bg-blue-600/10 text-blue-400"
                        )}
                      >
                        <Bot className="h-3.5 w-3.5 flex-shrink-0 text-zinc-400" />
                        <span className="truncate">{a.name}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ChatPage() {
  // ─── State ───────────────────────────────────────────────
  const { agents } = useAgents();
  const [selectedAgent, setSelectedAgent] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // 消息排队：Agent 回复期间用户可继续输入，消息自动排队依次发送
  const [messageQueue, setMessageQueue] = useState<Array<{ text: string; atts: Attachment[] }>>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingConvId, setEditingConvId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [searchResults, setSearchResults] = useState<Conversation[] | null>(null);
  // TTS 状态
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // [WEB-P1-03] TTS blob URL 生命周期：用 ref 跟踪当前 ObjectURL，
  // 所有退出路径（pause/ended/error/unmount/切换播放）统一 revoke，避免内存泄漏。
  const ttsUrlRef = useRef<string | null>(null);
  // 组件卸载时兜底释放（路由切换 / 快速关闭 chat 页场景）
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
      if (ttsUrlRef.current) {
        URL.revokeObjectURL(ttsUrlRef.current);
        ttsUrlRef.current = null;
      }
    };
  }, []);
  // 模型切换
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>>([]); 
  // P2: 当前对话的 modelOverride（用于 UI 显示）
  const [convModelOverride, setConvModelOverride] = useState<string | null>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── C-3: 使用共享 useAgents hook，加载后恢复 localStorage 选中状态 ───
  useEffect(() => {
    if (agents.length === 0 || selectedAgent) return;
    const savedAgent = localStorage.getItem("super-agent.selected-agent");
    if (savedAgent && agents.some((a) => a.id === savedAgent)) {
      setSelectedAgent(savedAgent);
    } else {
      // P2-7: 优先选择自建 Agent，其次 fallback 到第一个
      const userAgents = agents.filter(a => !a.isBuiltin);
      setSelectedAgent(userAgents.length > 0 ? userAgents[0].id : agents[0].id);
    }
  }, [agents, selectedAgent]);

  // Persist selected agent to localStorage
  useEffect(() => {
    if (selectedAgent) {
      localStorage.setItem("super-agent.selected-agent", selectedAgent);
    }
  }, [selectedAgent]);

  // ─── Load conversations when agent changes ──────────────
  const loadConversations = useCallback(async (agentId: string) => {
    if (!agentId) return;
    try {
      const data = await apiFetch<{ conversations: Conversation[] }>(`/api/conversations?agentId=${agentId}`);
      setConversations(data.conversations ?? []);
    } catch {
      setConversations([]);
    }
  }, []);

  useEffect(() => {
    if (selectedAgent) {
      loadConversations(selectedAgent);
      setActiveConvId(null);
      setMessages([]);
      // 切换 Agent 时重置模型覆盖状态
      setConvModelOverride(null);
      setShowModelPicker(false);
    }
  }, [selectedAgent, loadConversations]);

  // ─── Load messages when conversation is selected ────────
  const loadMessages = useCallback(async (convId: string) => {
    try {
      const data = await apiFetch<{ messages: Array<{ role: string; content: string | null }> }>(
        `/api/conversations/${convId}/messages?limit=200`
      );
      const msgs: Message[] = (data.messages ?? [])
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: typeof m.content === "string" ? m.content : (m.content ? String(m.content) : "") }));
      setMessages(msgs);
    } catch {
      setMessages([]);
    }
  }, []);

  const selectConversation = useCallback((convId: string) => {
    setActiveConvId(convId);
    loadMessages(convId);
    // P2: 切换对话时读取该对话的 modelOverride
    const conv = conversations.find((c) => c.id === convId);
    setConvModelOverride(conv?.modelOverride ?? null);
  }, [loadMessages, conversations]);

  // Auto-select the most recent conversation on load (or restore last active)
  useEffect(() => {
    if (conversations.length > 0 && !activeConvId) {
      const savedConv = localStorage.getItem("super-agent.active-conv");
      if (savedConv && conversations.some((c) => c.id === savedConv)) {
        selectConversation(savedConv);
      } else {
        selectConversation(conversations[0].id);
      }
    }
  }, [conversations, activeConvId, selectConversation]);

  // Persist active conversation to localStorage
  useEffect(() => {
    if (activeConvId) {
      localStorage.setItem("super-agent.active-conv", activeConvId);
    }
  }, [activeConvId]);

  // ─── Scroll to bottom ────────────────────────────────────
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // ─── Auto-resize textarea ──────────────────────────────
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);
  useEffect(() => { autoResize(); }, [input, autoResize]);

  // ─── File handling ──────────────────────────────────────
  const addFiles = useCallback((files: FileList | File[]) => {
    const newAttachments: Attachment[] = [];
    for (const file of Array.from(files)) {
      const id = crypto.randomUUID();
      const isImage = file.type.startsWith("image/");
      const att: Attachment = { id, file, type: isImage ? "image" : "file" };
      if (isImage) {
        const reader = new FileReader();
        reader.onload = (e) => {
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, preview: e.target?.result as string } : a))
          );
        };
        reader.readAsDataURL(file);
      }
      newAttachments.push(att);
    }
    setAttachments((prev) => [...prev, ...newAttachments]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // ─── Drag & Drop ───────────────────────────────────────
  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") { const f = item.getAsFile(); if (f) files.push(f); }
    }
    if (files.length > 0) { e.preventDefault(); addFiles(files); }
  }, [addFiles]);

  // ─── Voice ─────────────────────────────────────────────
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const rmsPeakRef = useRef<number>(0); // 录音期间 RMS 峰值，传给服务端做幻觉过滤 context guard
  const [voiceStatus, setVoiceStatus] = useState("");
  // 波形条高度（5 条，每条约 50ms 更新一次，用于 Task 3 波形可视化）
  const [waveHeights, setWaveHeights] = useState<number[]>([1, 1, 1, 1, 1]);

  const stopRecording = useCallback(() => {
    // 停止 AudioContext 分析循环
    if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close().catch(() => {});
    }
    audioContextRef.current = null;
    analyserRef.current = null;
    // 停止 MediaRecorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") mediaRecorderRef.current.stop();
    setIsRecording(false);
  }, []);

  // ─── SpeechRecognition 连通性探针 ────────────────────────
  // 快速验证浏览器内置语音识别是否可用（2s 超时，避免在中国大陆等受限网络白白等待）
  function probeSpeechRecognition(): Promise<boolean> {
    return new Promise((resolve) => {
      const api = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!api) { resolve(false); return; }
      const r = new api();
      r.continuous = false;
      r.interimResults = false;
      const timeout = setTimeout(() => { try { r.abort(); } catch {} resolve(false); }, 2000);
      r.onstart = () => { clearTimeout(timeout); r.stop(); };
      r.onresult = () => { clearTimeout(timeout); resolve(true); };
      r.onerror = () => { clearTimeout(timeout); resolve(false); };
      r.onend = () => { clearTimeout(timeout); resolve(true); };
      try { r.start(); } catch { clearTimeout(timeout); resolve(false); }
    });
  }

  // ─── MediaRecorder 录音流程（从 toggleVoice 中抽取，供降级复用）───
  const startMediaRecorderFlow = useCallback((stream: MediaStream) => {
    setIsRecording(true); setVoiceStatus("录音中..."); rmsPeakRef.current = 0;

    // ─── AudioContext + AnalyserNode：三段式静音自动停止 ───
    // 与 MediaRecorder 共享同一个 MediaStream，互不干扰
    const audioCtx = new AudioContext();
    audioContextRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    analyserRef.current = analyser;

    // 三段式静音检测状态机（参考 Hermes AudioRecorder）
    // ⚠️ 使用 performance.now() 做时间基准，而非帧计数（rAF 帧率随显示器 60-144Hz 变化）
    const RMS_THRESHOLD = 8; // Web Audio byte data (0-255, center 128), RMS 基于 sample-128
    const VOICE_CONFIRM_MS = 300;    // 0.3s 语音确认
    const GAP_TOLERANCE_MS = 300;    // 0.3s 间隙容忍
    const SILENCE_TRIGGER_MS = 3000;  // 3s 静音触发
    const TIMEOUT_MS = 15000;         // 15s 超时

    let voiceConfirmed = false;
    let voiceTime = 0;        // 累计语音时间（ms）
    let silenceTime = 0;      // 累计静音时间（ms）
    let gapTime = 0;          // 累计间隙时间（ms）
    let totalTime = 0;        // 总运行时间（ms）
    let lastFrameTime = performance.now();
    let lastWaveUpdate = 0;   // 波形上次更新时间戳

    const checkSilence = () => {
      const now = performance.now();
      const elapsed = now - lastFrameTime;
      lastFrameTime = now;
      totalTime += elapsed;

      const dataArray = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(dataArray);

      // 计算 RMS（基于 sample-128 中心偏移）
      let sumSq = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const normalized = dataArray[i] - 128; // 偏移量，范围 -128 ~ 127
        sumSq += normalized * normalized;
      }
      const rms = Math.sqrt(sumSq / dataArray.length); // 范围 0 ~ 128

      // 追踪 RMS 峰值（传给服务端做幻觉过滤 context guard）
      if (rms > rmsPeakRef.current) rmsPeakRef.current = rms;

      const isVoice = rms > RMS_THRESHOLD;

      if (!voiceConfirmed) {
        // 语音确认期：连续 RMS > 阈值 300ms 才确认「用户在说话」
        if (isVoice) {
          voiceTime += elapsed;
          if (voiceTime >= VOICE_CONFIRM_MS) {
            voiceConfirmed = true;
            silenceTime = 0;
          }
        } else {
          voiceTime = 0;
        }
      } else {
        // 已确认说话：检测静音
        if (isVoice) {
          silenceTime = 0;
          gapTime = 0;
        } else {
          gapTime += elapsed;
          // 间隙容忍：300ms 内短暂低于阈值不重置（处理辅音/气声等自然停顿）
          if (gapTime >= GAP_TOLERANCE_MS) {
            silenceTime += elapsed;
          }
        }
        // 静音触发：连续 3s 低于阈值 → 自动停止
        if (silenceTime >= SILENCE_TRIGGER_MS) {
          stopRecording();
          return;
        }
      }

      // 超时保护：15s 无人声自动终止
      if (totalTime >= TIMEOUT_MS) {
        stopRecording();
        return;
      }

      // ─── 波形可视化：每 40ms 更新一次频域数据（高刷屏避免过频渲染）───
      if (now - lastWaveUpdate >= 40) {
        lastWaveUpdate = now;
        const freqData = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(freqData);
        // 将频域数据分为 5 段，每段取平均值作为对应条的高度
        const bandSize = Math.floor(freqData.length / 5);
        const heights: number[] = [];
        for (let b = 0; b < 5; b++) {
          const start = b * bandSize;
          const end = (b === 4) ? freqData.length : (b + 1) * bandSize;
          let sum = 0;
          for (let j = start; j < end; j++) sum += freqData[j];
          const avg = sum / (end - start);
          // 映射 0-255 → 1-32px（不录音时 1px 基线）
          heights.push(Math.max(1, Math.round((avg / 255) * 32)));
        }
        setWaveHeights(heights);
      }

      animFrameRef.current = requestAnimationFrame(checkSilence);
    };

    animFrameRef.current = requestAnimationFrame(checkSilence);

    // ─── MediaRecorder：实际录音编码（与 AudioContext 共享 stream）───
    const chunks: Blob[] = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
    const recorder = new MediaRecorder(stream, { mimeType });
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      mediaRecorderRef.current = null;
      if (chunks.length === 0) { setVoiceStatus(""); setIsRecording(false); return; }
      setVoiceStatus("识别中...");
      const blob = new Blob(chunks, { type: mimeType });
      try {
        const arrayBuf = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuf);
        let binary = ""; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const base64 = btoa(binary);
        const format = mimeType.includes("webm") ? "webm" : "mp4";
        const reqBody: any = { audio: base64, language: "zh", format };
        // 传递 RMS 峰值给服务端，用于幻觉过滤的 context guard
        if (rmsPeakRef.current > 0) reqBody.rmsPeak = Math.round(rmsPeakRef.current * 100) / 100;
        const result = await apiFetch<{ text: string; filtered?: boolean }>("/api/voice/transcribe", {
          method: "POST", body: JSON.stringify(reqBody),
        });
        if (result.text) { setInput((prev) => (prev ? prev + " " + result.text : result.text)); setVoiceStatus("识别完成"); }
        else if (result.filtered) setVoiceStatus("未识别到有效语音");
        else setVoiceStatus("未识别到语音");
      } catch (err: any) { setVoiceStatus("识别失败"); }
      setTimeout(() => setVoiceStatus(""), 2000); setIsRecording(false);
    };

    recorder.onerror = () => {
      stream.getTracks().forEach((t) => t.stop());
      setVoiceStatus("录音失败"); setIsRecording(false);
      setTimeout(() => setVoiceStatus(""), 2000);
    };

    recorder.start();
  }, [stopRecording]);

  // ─── toggleVoice 入口：探针优先，浏览器识别 → 降级 MediaRecorder ──
  const toggleVoice = useCallback(async () => {
    if (isRecording) { stopRecording(); return; }

    // 尝试浏览器内置语音识别（连通性探针，2s 超时）
    const canUseBrowserSpeech = await probeSpeechRecognition();
    if (canUseBrowserSpeech) {
      setIsRecording(true);
      setVoiceStatus("浏览器语音识别中...");
      const api = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      const rec = new api();
      rec.lang = "zh-CN";
      rec.continuous = false;
      rec.interimResults = false;
      rec.onresult = (e: any) => {
        const text = e.results[0]?.[0]?.transcript || "";
        if (text) { setInput((prev) => (prev ? prev + " " + text : text)); setVoiceStatus("识别完成"); }
        else setVoiceStatus("未识别到语音");
      };
      rec.onerror = () => {
        // 浏览器识别失败 → 降级到 MediaRecorder 录音 + 服务端转写
        setVoiceStatus("");
        setIsRecording(false);
        navigator.mediaDevices.getUserMedia({ audio: true })
          .then(startMediaRecorderFlow)
          .catch(() => { alert("语音识别不可用，请检查麦克风权限或网络连接"); });
      };
      rec.onend = () => { setIsRecording(false); setTimeout(() => setVoiceStatus(""), 2000); };
      rec.start();
      return;
    }

    // 浏览器语音不可用 → 直接走 MediaRecorder 流程
    let stream: MediaStream;
    try {
      if (!window.isSecureContext) { alert("语音输入需要安全连接（HTTPS 或 localhost）"); return; }
      if (!navigator.mediaDevices?.getUserMedia) { alert("当前浏览器不支持麦克风访问 API"); return; }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      alert(`麦克风访问失败: ${err?.name || "未知错误"}\n${err?.message || ""}`);
      return;
    }
    startMediaRecorderFlow(stream);
  }, [isRecording, stopRecording, startMediaRecorderFlow]);

  // ─── New conversation ──────────────────────────────────
  const createNewConversation = useCallback(async () => {
    if (!selectedAgent) return;
    try {
      const data = await apiFetch<{ conversation: Conversation }>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ agentId: selectedAgent }),
      });
      setConversations((prev) => [data.conversation, ...prev]);
      setActiveConvId(data.conversation.id);
      setMessages([]);
    } catch { /* ignore */ }
  }, [selectedAgent]);

  // ─── Delete conversation ───────────────────────────────
  const handleDeleteConversation = useCallback(async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("确定删除此对话？")) return;
    try {
      await apiFetch(`/api/conversations/${convId}`, { method: "DELETE" });
      setConversations((prev) => prev.filter((c) => c.id !== convId));
      if (activeConvId === convId) { setActiveConvId(null); setMessages([]); }
    } catch { /* ignore */ }
  }, [activeConvId]);

  // ─── Rename conversation ───────────────────────────────
  const startRename = useCallback((convId: string, currentTitle: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingConvId(convId);
    setEditTitle(currentTitle || "");
  }, []);

  const confirmRename = useCallback(async (convId: string) => {
    if (!editTitle.trim()) { setEditingConvId(null); return; }
    try {
      await apiFetch(`/api/conversations/${convId}`, {
        method: "PATCH", body: JSON.stringify({ title: editTitle.trim() }),
      });
      setConversations((prev) => prev.map((c) => c.id === convId ? { ...c, title: editTitle.trim() } : c));
    } catch { /* ignore */ }
    setEditingConvId(null);
  }, [editTitle]);

  // P1-3: BroadcastChannel for cross-page skill sync
  const skillChannelRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    skillChannelRef.current = new BroadcastChannel("skill-sync");
    return () => { skillChannelRef.current?.close(); };
  }, []);

  // ─── 核心发送逻辑（供 sendMessage 和队列消费复用）─────────
  // 将 text 和 atts 作为参数传入，不再依赖组件 state
  const doSend = async (text: string, atts: Attachment[]) => {
    const msgAttachments = atts.map((a) => ({ name: a.file.name, type: a.file.type, preview: a.preview }));
    const userMsg: Message = {
      role: "user",
      content: text,
      attachments: msgAttachments.length > 0 ? msgAttachments : undefined,
    };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    // Read file contents for text-based attachments so LLM can actually see them
    let messageContent = userMsg.content;
    // 图片 base64 收集数组 — 用于多模态传递给后端
    const imagePayloads: { data: string; mimeType: string }[] = [];
    if (atts.length > 0) {
      const parts: string[] = [];
      for (const att of atts) {
        if (isTextFile(att.file)) {
          try {
            const fileText = await readFileAsText(att.file);
            const truncated = fileText.length > 30000 ? fileText.slice(0, 30000) + "\n...(内容过长已截断)" : fileText;
            parts.push(`<file name="${att.file.name}">\n${truncated}\n</file>`);
          } catch {
            parts.push(`[附件: ${att.file.name} (读取失败)]`);
          }
        } else if (isParseableFile(att.file)) {
          // PDF/DOCX/XLSX — 发送到服务端解析提取文本
          try {
            const base64 = await readFileAsBase64(att.file);
            const result = await apiFetch<{ text: string; truncated: boolean; meta?: Record<string, unknown> }>("/api/files/parse", {
              method: "POST",
              body: JSON.stringify({ filename: att.file.name, data: base64 }),
            });
            if (result.text) {
              parts.push(`<file name="${att.file.name}">${"\n"}${result.text}${"\n"}</file>`);
            } else {
              parts.push(`[附件: ${att.file.name} (解析结果为空)]`);
            }
          } catch {
            parts.push(`[附件: ${att.file.name} (${(att.file.size / 1024).toFixed(1)}KB, 解析失败)]`);
          }
        } else if (att.type === "image" && att.preview) {
          // 图片附件 — 读取 base64 用于多模态传递，同时保留占位文字
          try {
            const base64 = await readFileAsBase64(att.file);
            imagePayloads.push({ data: base64, mimeType: att.file.type || "image/png" });
            parts.push(`[图片附件: ${att.file.name}]`);
          } catch {
            parts.push(`[图片: ${att.file.name} (读取失败)]`);
          }
        } else {
          // 不支持的文件类型
          parts.push(`[附件: ${att.file.name} (${(att.file.size / 1024).toFixed(1)}KB, 不支持的文件类型)]`);
        }
      }
      const fileBlock = parts.join("\n");
      messageContent = messageContent ? `${messageContent}\n\n${fileBlock}` : fileBlock;
    }

    // P1-1: Retry logic for network errors
    const MAX_RETRIES = 2;
    const RETRY_DELAY = 3000;

    const attemptStream = async (attempt: number): Promise<void> => {
      // P0-2: 活动超时 — 每收到 SSE 数据重置 120s 计时器
      // 解决大上下文(32K+ tokens)下 LLM 首次响应慢导致的误超时
      const controller = new AbortController();
      const STREAM_TIMEOUT = 120_000;
      let timeoutId = setTimeout(() => controller.abort(), STREAM_TIMEOUT);
      const resetTimeout = () => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => controller.abort(), STREAM_TIMEOUT);
      };

      try {
        // SSE 流式请求走 Next.js proxy（proxyTimeout 已设为 5 分钟）
        // 保留直连 fallback 以防代理超时：process.env.NEXT_PUBLIC_API_URL
        // [WEB-P1-04] 手动注入 Authorization（相对路径不走 apiFetch，但需与后端鉴权对齐）
        const token = typeof window !== "undefined" ? localStorage.getItem("super-agent.auth-token") : null;
        const res = await fetch(`/api/chat/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            agentId: selectedAgent,
            message: messageContent,
            conversationId: activeConvId || undefined,
            metadata: imagePayloads.length > 0 ? { images: imagePayloads } : undefined,
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("请求失败");

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let assistantContent = "";
        let toolCalls: ToolCallEntry[] = [];
        setMessages((prev) => {
          // Replace existing empty assistant msg or add new one
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && !last.content) return prev;
          return [...prev, { role: "assistant", content: "" }];
        });

        // C-1: 使用 requestAnimationFrame 节流 SSE 流式更新，减少 React 渲染次数
        const updateAssistantMsg = () => {
          setMessages((prev) => {
            const newMsgs = [...prev];
            newMsgs[newMsgs.length - 1] = {
              role: "assistant",
              content: assistantContent,
              toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
            };
            return newMsgs;
          });
        };
        let rafHandle: number | null = null;
        const scheduleUpdate = () => {
          if (rafHandle !== null) return; // 已有排队的帧更新，合并
          rafHandle = requestAnimationFrame(() => {
            rafHandle = null;
            updateAssistantMsg();
          });
        };
        const flushUpdate = () => {
          if (rafHandle !== null) { cancelAnimationFrame(rafHandle); rafHandle = null; }
          updateAssistantMsg();
        };

        if (reader) {
          let isDone = false; // P0-1: flag to break both inner and outer loops
          while (true) {
            const { done, value } = await reader.read();
            if (done || isDone) break;
            resetTimeout(); // 收到数据，重置超时计时器
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n");
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]") { isDone = true; break; }
                try {
                  const parsed = JSON.parse(data);
                  // Capture conversation ID from first event
                  if (parsed.conversationId && !activeConvId) {
                    setActiveConvId(parsed.conversationId);
                    loadConversations(selectedAgent);
                    // P0: 新建对话后，如果有待持久化的 modelOverride，立即写入
                    if (convModelOverride) {
                      apiFetch(`/api/conversations/${parsed.conversationId}`, {
                        method: "PATCH",
                        body: JSON.stringify({ modelOverride: convModelOverride }),
                      }).catch(() => {});
                    }
                  }
                  if (parsed.type === "content" && parsed.content) {
                    assistantContent += parsed.content;
                    scheduleUpdate(); // C-1: 节流内容更新
                  }
                  if (parsed.type === "tool_call" && parsed.name) {
                    toolCalls = [...toolCalls, {
                      toolCallId: parsed.toolCallId || `tc-${Date.now()}`,
                      name: parsed.name,
                      args: parsed.args,
                      status: "calling",
                    }];
                    flushUpdate(); // 工具调用需要即时显示
                  }
                  if (parsed.type === "tool_result" && parsed.name) {
                    const tcId = parsed.toolCallId;
                    toolCalls = toolCalls.map((tc) =>
                      (tcId && tc.toolCallId === tcId) || (!tcId && tc.name === parsed.name && tc.status === "calling")
                        ? { ...tc, status: parsed.success ? "success" : "error", output: parsed.output, error: parsed.error }
                        : tc
                    );
                    flushUpdate(); // 工具结果需要即时显示

                    // P1-3: Notify skill page when a skill is installed via chat
                    if (parsed.name === "skill_install" && parsed.success) {
                      skillChannelRef.current?.postMessage({ type: "skill-installed" });
                    }
                  }
                  // Legacy: support old { content } format for backward compat
                  if (!parsed.type && parsed.content) {
                    assistantContent += parsed.content;
                    scheduleUpdate(); // C-1: 节流内容更新
                  }
                } catch { /* ignore parse errors */ }
              }
            }
            if (isDone) break; // P0-1: break outer loop when [DONE] received
          }
        }
        flushUpdate(); // C-1: 流结束时确保最终状态渲染

        // Refresh conversation list after message sent
        loadConversations(selectedAgent);
      } catch (e: unknown) {
        // P1-1: Auto-retry on network errors (TypeError with fetch message)
        const isNetworkError = e instanceof TypeError && e.message.includes("fetch");
        if (isNetworkError && attempt < MAX_RETRIES) {
          setMessages((prev) => {
            const newMsgs = [...prev];
            newMsgs[newMsgs.length - 1] = { role: "assistant", content: `网络中断，正在重连...(${attempt + 1}/${MAX_RETRIES})` };
            return newMsgs;
          });
          await new Promise((r) => setTimeout(r, RETRY_DELAY));
          return attemptStream(attempt + 1);
        }

        // P0-2: distinguish AbortError (timeout) from other errors
        const errMsg = e instanceof DOMException && e.name === "AbortError"
          ? "请求超时(120秒无响应)，可能上下文过长导致LLM处理缓慢，请清理历史对话后重试"
          : isNetworkError
            ? "网络连接失败，已重试多次，请检查后端服务是否运行"
            : e instanceof Error ? e.message : "未知错误";
        setMessages((prev) => {
          const newMsgs = [...prev];
          const last = newMsgs[newMsgs.length - 1];
          if (last?.role === "assistant") {
            newMsgs[newMsgs.length - 1] = { role: "assistant", content: `错误：${errMsg}` };
          } else {
            newMsgs.push({ role: "assistant", content: `错误：${errMsg}` });
          }
          return newMsgs;
        });
      } finally {
        clearTimeout(timeoutId); // P0-2: clean up timeout
      }
    };

    try {
      await attemptStream(0);
    } finally {
      setLoading(false);
    }
  };

  // 用 ref 保存最新 doSend，供 useEffect 消费队列时调用（避免闭包过期问题）
  const doSendRef = useRef(doSend);
  doSendRef.current = doSend;

  // ─── Send message（支持排队）───────────────────────
  const sendMessage = async () => {
    if ((!input.trim() && attachments.length === 0) || !selectedAgent) return;

    const text = input.replace(/\u200B/g, "");
    const atts = [...attachments];
    setInput(""); setAttachments([]);

    // Agent 正在回复中 → 消息加入排队队列，用户可继续输入
    if (loading) {
      setMessageQueue((prev) => [...prev, { text, atts }]);
      return;
    }

    if (isRecording) stopRecording();
    await doSend(text, atts);
  };

  // ─── 队列消费：当前回复结束后自动发送排队中的下一条 ──────
  useEffect(() => {
    if (loading || messageQueue.length === 0) return;
    const [next, ...rest] = messageQueue;
    setMessageQueue(rest);
    doSendRef.current(next.text, next.atts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, messageQueue]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "昨天";
    return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  };

  // 对话搜索: 输入时先本地过滤，Enter 触发 API 全文搜索
  const handleConvSearch = useCallback(async () => {
    if (!searchQuery.trim()) { setSearchResults(null); return; }
    try {
      const data = await apiFetch<{ results: Array<{ conversationId: string; snippet: string }> }>(
        `/api/conversations/search?q=${encodeURIComponent(searchQuery)}`
      );
      // 将搜索结果映射为对话列表
      const matchedIds = new Set((data.results ?? []).map((r) => r.conversationId));
      setSearchResults(conversations.filter((c) => matchedIds.has(c.id)));
    } catch { setSearchResults(null); }
  }, [searchQuery, conversations]);

  const filteredConversations = searchResults
    ? searchResults
    : searchQuery
      ? conversations.filter((c) =>
          (c.title ?? "").toLowerCase().includes(searchQuery.toLowerCase()) ||
          (c.lastMessagePreview ?? "").toLowerCase().includes(searchQuery.toLowerCase())
        )
      : conversations;

  // 模型目录获取
  useEffect(() => {
    apiFetch<{ providers: Array<{ id: string; name: string; isEnabled: boolean; models: Array<{ id: string; name: string }> }> }>("/api/models/providers")
      .then((data) => setModelCatalog((data.providers ?? []).filter((p) => p.isEnabled || p.models.length > 0)))
      .catch(() => {});
  }, []);

  // P3: 点击 model picker 外部时自动关闭
  useEffect(() => {
    if (!showModelPicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showModelPicker]);

  // TTS 语音合成
  const handleTTS = useCallback(async (text: string, msgIdx: number) => {
    // [WEB-P1-03] 统一释放前一次 blob URL，避免任一退出路径遗漏
    const revokePrevUrl = () => {
      if (ttsUrlRef.current) {
        URL.revokeObjectURL(ttsUrlRef.current);
        ttsUrlRef.current = null;
      }
    };

    // 如果正在播放同一条，停止并释放资源
    if (playingIdx === msgIdx) {
      audioRef.current?.pause();
      audioRef.current = null;
      revokePrevUrl();
      setPlayingIdx(null);
      return;
    }

    // 切换到另一条前先释放上一次的 audio + url
    audioRef.current?.pause();
    audioRef.current = null;
    revokePrevUrl();

    setPlayingIdx(msgIdx);
    try {
      // TTS 返回二进制 blob，不能用 apiFetch（它假定 JSON），但需要手动附加认证头
      const token = typeof window !== "undefined" ? localStorage.getItem("super-agent.auth-token") : null;
      const res = await fetch(`${API_BASE}/api/voice/synthesize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text: text.slice(0, 2000) }),
      });
      if (!res.ok) throw new Error("TTS 合成失败");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      ttsUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      // 所有结束路径（正常/错误）统一回收
      const cleanup = () => {
        setPlayingIdx(null);
        audioRef.current = null;
        revokePrevUrl();
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      await audio.play();
    } catch {
      // play() 拒绝或网络失败：回收已创建的 url
      revokePrevUrl();
      audioRef.current = null;
      setPlayingIdx(null);
    }
  }, [playingIdx]);

  // 模型切换 — 修复 P0/P1/P2
  const handleModelSwitch = useCallback(async (providerId: string, modelId: string) => {
    // P1: 使用 "providerId:modelId" 格式，让后端能查找到 provider 的 API Key
    const overrideValue = `${providerId}:${modelId}`;

    if (!activeConvId) {
      // P0: 无活跃对话时，将 override 暂存到本地状态
      // 发送第一条消息创建对话后再持久化
      setConvModelOverride(overrideValue);
      setShowModelPicker(false);
      return;
    }
    try {
      await apiFetch(`/api/conversations/${activeConvId}`, {
        method: "PATCH",
        body: JSON.stringify({ modelOverride: overrideValue }),
      });
      // P2: 更新本地 UI 状态
      setConvModelOverride(overrideValue);
      setShowModelPicker(false);
    } catch { /* ignore */ }
  }, [activeConvId]);

  return (
    <div className="flex h-[calc(100vh-4rem)]" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {/* ─── Left Panel: Conversation List ──────────────── */}
      <div className={cn(
        "flex flex-col border-r border-zinc-800 bg-zinc-950/50 transition-all duration-300 overflow-hidden",
        panelCollapsed ? "w-0 border-r-0" : "w-72"
      )}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 min-w-[18rem]">
          <h2 className="text-lg font-semibold text-white">对话</h2>
          <div className="flex items-center gap-1.5">
            <button
              onClick={createNewConversation}
              className="rounded-lg bg-blue-600 p-1.5 text-white hover:bg-blue-700 transition-colors"
              title="新建对话"
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              onClick={() => setPanelCollapsed(true)}
              className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
              title="收起面板"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* P1-5: Agent 选择器 — 可搜索 Combobox，支持按名称/部门搜索 */}
        <div className="px-3 py-2 border-b border-zinc-800/50">
          <AgentCombobox
            agents={agents}
            selectedAgent={selectedAgent}
            onSelect={(id) => setSelectedAgent(id)}
          />
        </div>

        {/* Search */}
        <div className="px-3 py-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索对话... (Enter 搜索)"
              onKeyDown={(e) => { if (e.key === "Enter") handleConvSearch(); }}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-8 pr-3 py-1.5 text-sm text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5">
          {filteredConversations.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
              <MessageSquare className="h-8 w-8 mb-2" />
              <p className="text-sm">暂无对话</p>
              <p className="text-xs mt-1">点击上方 + 新建对话</p>
            </div>
          )}
          {filteredConversations.map((conv) => (
            <div
              key={conv.id}
              onClick={() => selectConversation(conv.id)}
              className={cn(
                "group cursor-pointer rounded-lg px-3 py-2.5 transition-colors",
                activeConvId === conv.id
                  ? "bg-blue-600/10 border border-blue-500/20"
                  : "hover:bg-zinc-800/60 border border-transparent"
              )}
            >
              {editingConvId === conv.id ? (
                <div className="flex items-center gap-1">
                  <input
                    autoFocus
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") confirmRename(conv.id); if (e.key === "Escape") setEditingConvId(null); }}
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 rounded bg-zinc-800 px-2 py-0.5 text-sm text-white focus:outline-none"
                  />
                  <button onClick={(e) => { e.stopPropagation(); confirmRename(conv.id); }} className="p-0.5 text-green-400 hover:text-green-300">
                    <Check className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <p className={cn("text-sm font-medium truncate max-w-[160px]",
                      activeConvId === conv.id ? "text-blue-400" : "text-white"
                    )}>
                      {conv.title || "新对话"}
                    </p>
                    <span className="text-xs text-zinc-500 shrink-0 ml-2">{formatTime(conv.updatedAt)}</span>
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <p className="text-xs text-zinc-500 truncate max-w-[160px]">
                      {conv.lastMessagePreview || "暂无消息"}
                    </p>
                    {/* Action buttons on hover */}
                    <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                      <button onClick={(e) => startRename(conv.id, conv.title || "", e)} className="p-0.5 text-zinc-500 hover:text-white" title="重命名">
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button onClick={(e) => handleDeleteConversation(conv.id, e)} className="p-0.5 text-zinc-500 hover:text-red-400" title="删除">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ─── Right Panel: Chat Area ────────────────────── */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
          <div className="flex items-center gap-3">
            {panelCollapsed && (
              <button
                onClick={() => setPanelCollapsed(false)}
                className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
                title="展开对话列表"
              >
                <PanelLeftOpen className="h-5 w-5" />
              </button>
            )}
            <div>
            <h1 className="text-2xl font-bold text-white">
              {activeConvId
                ? (conversations.find((c) => c.id === activeConvId)?.title || "新对话")
                : "对话"}
            </h1>
            <div className="mt-0.5 flex items-center gap-2 relative" ref={modelPickerRef}>
              {(() => {
                const agent = agents.find((a) => a.id === selectedAgent);
                // P2: 优先显示当前对话的 modelOverride，其次显示 Agent 默认模型
                const displayModel = convModelOverride
                  ? convModelOverride.split(":").pop() // 从 "providerId:modelId" 取 modelId 部分
                  : agent?.model;
                const isOverridden = !!convModelOverride;
                if (displayModel) {
                  return (
                    <button
                      onClick={() => setShowModelPicker(!showModelPicker)}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs border hover:opacity-80 ${
                        isOverridden
                          ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
                          : "bg-blue-500/10 text-blue-400 border-blue-500/20"
                      }`}
                    >
                      {isOverridden && <span className="text-[10px] opacity-60">●</span>}
                      {displayModel} <ChevronDown className="h-3 w-3" />
                    </button>
                  );
                }
                return (
                  <a href="/settings" className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400 border border-amber-500/20 hover:bg-amber-500/20">
                    <Settings2 className="h-3 w-3" /> 请先配置模型
                  </a>
                );
              })()}
              {showModelPicker && modelCatalog.length > 0 && (
                <div className="absolute top-8 left-0 z-50 w-72 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl max-h-72 overflow-y-auto">
                  {/* 清除 override 按钮 */}
                  {convModelOverride && (
                    <button
                      onClick={() => {
                        // 清除当前对话的模型覆盖，回到 Agent 默认
                        if (activeConvId) {
                          apiFetch(`/api/conversations/${activeConvId}`, {
                            method: "PATCH",
                            body: JSON.stringify({ modelOverride: null }),
                          }).catch(() => {});
                        }
                        setConvModelOverride(null);
                        setShowModelPicker(false);
                      }}
                      className="w-full px-3 py-2 text-left text-xs text-amber-400 hover:bg-zinc-800 border-b border-zinc-800"
                    >
                      ← 恢复 Agent 默认模型
                    </button>
                  )}
                  {modelCatalog.map((provider) => (
                    <div key={provider.id}>
                      <p className="px-3 py-1.5 text-xs font-semibold text-zinc-500 uppercase">{provider.name}</p>
                      {provider.models.slice(0, 8).map((m) => {
                        // 高亮当前已选中的模型
                        const isActive = convModelOverride === `${provider.id}:${m.id}`;
                        return (
                          <button
                            key={m.id}
                            onClick={() => handleModelSwitch(provider.id, m.id)}
                            className={`w-full px-3 py-1.5 text-left text-sm hover:bg-zinc-800 ${
                              isActive ? "text-purple-400 bg-purple-500/10" : "text-zinc-300"
                            }`}
                          >
                            {isActive && <span className="mr-1">✓</span>}
                            {m.name}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
            </div>
          </div>
        </div>

        {/* Drag overlay */}
        {isDragOver && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm rounded-xl border-2 border-dashed border-blue-500">
            <div className="text-center">
              <Paperclip className="mx-auto h-12 w-12 text-blue-400" />
              <p className="mt-3 text-xl font-medium text-blue-400">拖放文件到此处上传</p>
              <p className="mt-1 text-sm text-zinc-400">支持图片、文档等文件</p>
            </div>
          </div>
        )}

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto py-6 px-6 space-y-4">
          {messages.length === 0 && (() => {
            const agent = agents.find((a) => a.id === selectedAgent);
            // 未配置模型时显示首次引导卡片
            if (!agent?.model) {
              return (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-md w-full rounded-2xl border border-blue-500/20 bg-gradient-to-b from-blue-500/10 to-transparent p-8 text-center">
                    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-blue-600/20 mb-4">
                      <Bot className="h-7 w-7 text-blue-400" />
                    </div>
                    <h2 className="text-xl font-semibold text-white">欢迎使用 Super Agent</h2>
                    <p className="mt-3 text-sm text-zinc-400 leading-relaxed">
                      只需两步即可开始：
                    </p>
                    <ol className="mt-3 text-sm text-zinc-300 text-left space-y-2 pl-4">
                      <li className="flex items-start gap-2">
                        <span className="shrink-0 mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-blue-600/30 text-xs text-blue-400 font-medium">1</span>
                        <span>前往<strong className="text-blue-400">设置页面</strong></span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="shrink-0 mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-blue-600/30 text-xs text-blue-400 font-medium">2</span>
                        <span>选择 Provider → 填入 API Key → 保存</span>
                      </li>
                    </ol>
                    <a
                      href="/settings"
                      className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
                    >
                      <Settings2 className="h-4 w-4" /> 前往设置
                    </a>
                    <p className="mt-4 text-xs text-zinc-500">
                      支持 Kimi / 智谱GLM / 千问 / DeepSeek / MiniMax / 豆包 / 自定义
                    </p>
                    <p className="text-xs text-zinc-600">配置后无需重启，立即可用</p>
                  </div>
                </div>
              );
            }
            // 已配置模型时显示默认占位符
            return (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <Bot className="mx-auto h-12 w-12 text-zinc-600" />
                  <p className="mt-4 text-lg text-zinc-500">
                    {activeConvId ? "开始对话吧" : "选择或新建一个对话"}
                  </p>
                  <p className="mt-2 text-sm text-zinc-600">支持文字、图片、文件、语音输入</p>
                </div>
              </div>
            );
          })()}
          {messages.map((msg, i) => (
            <div key={i} className={cn("flex gap-3", msg.role === "user" ? "justify-end" : "")}>
              {msg.role === "assistant" && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600/20">
                  <Bot className="h-4 w-4 text-blue-400" />
                </div>
              )}
              <div className={cn(
                "max-w-[70%] rounded-xl px-4 py-3 text-lg",
                msg.role === "user" ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-200"
              )}>
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {msg.attachments.map((att, j) =>
                      att.preview ? (
                        <img key={j} src={att.preview} alt={att.name} className="max-h-40 rounded-lg border border-white/20 object-cover" />
                      ) : (
                        <div key={j} className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-1.5 text-base">
                          <FileText className="h-3.5 w-3.5" /><span className="max-w-[150px] truncate">{att.name}</span>
                        </div>
                      )
                    )}
                  </div>
                )}
                <p className="whitespace-pre-wrap">{msg.content}</p>
                {msg.role === "assistant" && msg.content && (
                  <button
                    onClick={() => handleTTS(msg.content, i)}
                    className="mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50"
                    title={playingIdx === i ? "停止播放" : "朗读"}
                  >
                    {playingIdx === i ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                    {playingIdx === i ? "停止" : "朗读"}
                  </button>
                )}
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <div className="mt-2">
                    {msg.toolCalls.map((tc) => (
                      <ToolCallCard key={tc.toolCallId} tc={tc} />
                    ))}
                  </div>
                )}
              </div>
              {msg.role === "user" && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-800">
                  <User className="h-4 w-4 text-zinc-400" />
                </div>
              )}
            </div>
          ))}
          {loading && messages[messages.length - 1]?.role === "assistant" && messages[messages.length - 1]?.content === "" && !messages[messages.length - 1]?.toolCalls?.length && (
            <div className="flex gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600/20">
                <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />
              </div>
              <div className="rounded-xl bg-zinc-800 px-4 py-3 text-lg text-zinc-400">思考中...</div>
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="border-t border-zinc-800 px-6 pt-4 pb-3 space-y-3">
          {/* Attachment previews */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((att) => (
                <div key={att.id} className="group relative flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/80 p-1.5">
                  {att.type === "image" && att.preview ? (
                    <img src={att.preview} alt={att.file.name} className="h-16 w-16 rounded object-cover" />
                  ) : (
                    <div className="flex h-16 w-16 items-center justify-center rounded bg-zinc-700">
                      <FileText className="h-6 w-6 text-zinc-400" />
                    </div>
                  )}
                  <div className="max-w-[120px] pr-5">
                    <p className="truncate text-sm text-white">{att.file.name}</p>
                    <p className="text-xs text-zinc-500">{formatSize(att.file.size)}</p>
                  </div>
                  <button onClick={() => removeAttachment(att.id)} className="absolute -right-1.5 -top-1.5 rounded-full bg-zinc-600 p-0.5 text-zinc-300 hover:bg-red-600 hover:text-white transition-colors">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Input row */}
          <div className="flex items-end gap-2">
            <div className="flex items-center gap-1 pb-1.5">
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={loading} className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors disabled:opacity-50" title="上传文件">
                <Paperclip className="h-5 w-5" />
              </button>
              <input ref={fileInputRef} type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.json,.md,.py,.js,.ts,.html,.css,.xml,.yaml,.yml,.zip,.rar,.7z" className="hidden" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
              <button type="button" onClick={() => { const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*"; inp.multiple = true; inp.onchange = () => { if (inp.files) addFiles(inp.files); }; inp.click(); }} disabled={loading} className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors disabled:opacity-50" title="上传图片">
                <ImageIcon className="h-5 w-5" />
              </button>
              <button type="button" onClick={toggleVoice} disabled={loading} className={cn("relative rounded-lg p-2 transition-colors disabled:opacity-50", isRecording ? "bg-red-600/20 text-red-400 hover:bg-red-600/30" : "text-zinc-400 hover:bg-zinc-800 hover:text-white")} title={isRecording ? "停止录音" : "语音输入"}>
                {/* 波形可视化：录音时显示 5 条波形，不录音时隐藏 */}
                {isRecording && (
                  <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 flex items-end gap-[2px]">
                    {waveHeights.map((h, wi) => {
                      // 低音量 zinc-500 → 高音量 red-400
                      const ratio = Math.min(1, h / 32);
                      const color = ratio < 0.3 ? "bg-zinc-500" : ratio < 0.6 ? "bg-amber-500" : "bg-red-400";
                      return (
                        <span key={wi} className={`inline-block w-[3px] rounded-full ${color}`}
                          style={{ height: `${h}px` }}
                        />
                      );
                    })}
                  </span>
                )}
                {isRecording ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                {voiceStatus && <span className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-xs text-emerald-400 bg-zinc-900 px-2 py-0.5 rounded">{voiceStatus}</span>}
              </button>
            </div>

            <div className="relative flex-1">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={isRecording ? (voiceStatus || "录音中...") : "输入消息... (Shift+Enter 换行)"}
                disabled={!selectedAgent}
                rows={1}
                className={cn(
                  "w-full resize-none rounded-xl border bg-zinc-900 px-4 py-3 pr-12 text-lg text-white placeholder-zinc-500 focus:outline-none disabled:opacity-50 transition-colors",
                  isRecording ? "border-red-500/50 focus:border-red-500" : "border-zinc-800 focus:border-blue-500"
                )}
                style={{ maxHeight: 200 }}
              />
              <button
                type="button"
                onClick={sendMessage}
                disabled={!input.trim() && attachments.length === 0}
                className="absolute bottom-2.5 right-2.5 rounded-lg bg-blue-600 p-1.5 text-white transition-colors hover:bg-blue-700 disabled:opacity-30 disabled:hover:bg-blue-600"
                title={loading ? "加入排队队列" : "发送消息"}
              >
                {loading && messageQueue.length > 0 ? (
                  <span className="relative">
                    <Send className="h-4 w-4 opacity-50" />
                    <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center h-3.5 min-w-[14px] rounded-full bg-amber-500 text-[9px] font-bold text-white px-0.5 leading-none">
                      {messageQueue.length + 1}
                    </span>
                  </span>
                ) : loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between text-xs text-zinc-600 px-1">
            <span>
              {isRecording && <span className="inline-flex items-center gap-1 text-red-400"><span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />正在录音...</span>}
              {!isRecording && loading && messageQueue.length > 0 && (
                <span className="inline-flex items-center gap-1 text-amber-400">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  排队中 ({messageQueue.length + 1}条)
                </span>
              )}
              {!isRecording && loading && messageQueue.length === 0 && (
                <span className="inline-flex items-center gap-1 text-blue-400">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  回复中...
                </span>
              )}
            </span>
            <span>Enter 发送 · Shift+Enter 换行 · 支持拖拽/粘贴文件</span>
          </div>
        </div>
      </div>
    </div>
  );
}
