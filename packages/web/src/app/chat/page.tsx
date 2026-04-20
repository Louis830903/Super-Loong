"use client";

import { useEffect, useRef, useState, useCallback, memo } from "react";
import { useAgents } from "@/hooks/useAgents";
import { apiFetch, API_BASE } from "@/lib/utils";
import { cn } from "@/lib/utils";
import {
  Send, Bot, User, Loader2, Trash2,
  Paperclip, X, Image as ImageIcon, FileText, Mic, MicOff,
  Settings2, Plus, MessageSquare, Search, Pencil, Check,
  PanelLeftClose, PanelLeftOpen,
  CheckCircle2, XCircle, ChevronRight, Wrench,
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
}

interface Attachment {
  id: string;
  file: File;
  preview?: string;
  type: "image" | "file";
}

// Text-based extensions whose content can be read and sent to LLM
const TEXT_EXTENSIONS = new Set([
  ".txt", ".csv", ".json", ".md", ".py", ".js", ".ts", ".tsx", ".jsx",
  ".html", ".css", ".xml", ".yaml", ".yml", ".log", ".sh", ".bat",
  ".sql", ".env", ".ini", ".conf", ".toml", ".cfg", ".properties",
]);

// 服务端可解析的二进制文件类型（PDF/DOCX/XLSX）
const PARSEABLE_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".xls", ".pptx"]);

function isTextFile(file: File): boolean {
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || file.type.startsWith("text/");
}

function isParseableFile(file: File): boolean {
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  return PARSEABLE_EXTENSIONS.has(ext);
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // 去掉 data URL 前缀 (e.g. "data:application/pdf;base64,")
      const base64 = result.split(",")[1] || result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
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

export default function ChatPage() {
  // ─── State ───────────────────────────────────────────────
  const { agents } = useAgents();
  const [selectedAgent, setSelectedAgent] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingConvId, setEditingConvId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [panelCollapsed, setPanelCollapsed] = useState(false);
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
      setSelectedAgent(agents[0].id);
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
  }, [loadMessages]);

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
  const [voiceStatus, setVoiceStatus] = useState("");

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") mediaRecorderRef.current.stop();
    setIsRecording(false);
  }, []);

  const toggleVoice = useCallback(async () => {
    if (isRecording) { stopRecording(); return; }
    let stream: MediaStream;
    try {
      if (!window.isSecureContext) { alert("语音输入需要安全连接（HTTPS 或 localhost）"); return; }
      if (!navigator.mediaDevices?.getUserMedia) { alert("当前浏览器不支持麦克风访问 API"); return; }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      alert(`麦克风访问失败: ${err?.name || "未知错误"}\n${err?.message || ""}`);
      return;
    }
    setIsRecording(true); setVoiceStatus("录音中...");
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
        const result = await apiFetch<{ text: string }>("/api/voice/transcribe", {
          method: "POST", body: JSON.stringify({ audio: base64, language: "zh", format }),
        });
        if (result.text) { setInput((prev) => (prev ? prev + " " + result.text : result.text)); setVoiceStatus("识别完成"); }
        else setVoiceStatus("未识别到语音");
      } catch (err: any) { setVoiceStatus("识别失败"); }
      setTimeout(() => setVoiceStatus(""), 2000); setIsRecording(false);
    };
    recorder.onerror = () => { stream.getTracks().forEach((t) => t.stop()); setVoiceStatus("录音失败"); setIsRecording(false); setTimeout(() => setVoiceStatus(""), 2000); };
    recorder.start();
  }, [isRecording, stopRecording]);

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

  // ─── Send message ──────────────────────────────────────
  const sendMessage = async () => {
    if ((!input.trim() && attachments.length === 0) || !selectedAgent || loading) return;

    const attachmentFiles = [...attachments]; // snapshot before clearing
    const msgAttachments = attachments.map((a) => ({ name: a.file.name, type: a.file.type, preview: a.preview }));
    const userMsg: Message = {
      role: "user",
      content: input.replace(/\u200B/g, ""),
      attachments: msgAttachments.length > 0 ? msgAttachments : undefined,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput(""); setAttachments([]); setLoading(true);
    if (isRecording) stopRecording();

    // Read file contents for text-based attachments so LLM can actually see them
    let messageContent = userMsg.content;
    // 图片 base64 收集数组 — 用于多模态传递给后端
    const imagePayloads: { data: string; mimeType: string }[] = [];
    if (attachmentFiles.length > 0) {
      const parts: string[] = [];
      for (const att of attachmentFiles) {
        if (isTextFile(att.file)) {
          try {
            const text = await readFileAsText(att.file);
            const truncated = text.length > 30000 ? text.slice(0, 30000) + "\n...(内容过长已截断)" : text;
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
        // SSE 流式请求直连 API 后端，绕过 Next.js rewrite 代理
        // 避免代理层超时截断长时间运行的 LLM 流式响应
        const streamBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
        const res = await fetch(`${streamBase}/api/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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

  // Filter conversations by search
  const filteredConversations = searchQuery
    ? conversations.filter((c) =>
        (c.title ?? "").toLowerCase().includes(searchQuery.toLowerCase()) ||
        (c.lastMessagePreview ?? "").toLowerCase().includes(searchQuery.toLowerCase())
      )
    : conversations;

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

        {/* Agent selector */}
        <div className="px-3 py-2 border-b border-zinc-800/50">
          <select
            value={selectedAgent}
            onChange={(e) => { setSelectedAgent(e.target.value); }}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        {/* Search */}
        <div className="px-3 py-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索对话..."
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
            <div className="mt-0.5 flex items-center gap-2">
              {(() => {
                const agent = agents.find((a) => a.id === selectedAgent);
                if (agent?.model) {
                  return (
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-xs text-blue-400 border border-blue-500/20">
                      {agent.model}
                    </span>
                  );
                }
                return (
                  <a href="/settings" className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400 border border-amber-500/20 hover:bg-amber-500/20">
                    <Settings2 className="h-3 w-3" /> 请先配置模型
                  </a>
                );
              })()}
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
          {messages.length === 0 && (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <Bot className="mx-auto h-12 w-12 text-zinc-600" />
                <p className="mt-4 text-lg text-zinc-500">
                  {activeConvId ? "开始对话吧" : "选择或新建一个对话"}
                </p>
                <p className="mt-2 text-sm text-zinc-600">支持文字、图片、文件、语音输入</p>
              </div>
            </div>
          )}
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
                disabled={!selectedAgent || loading}
                rows={1}
                className={cn(
                  "w-full resize-none rounded-xl border bg-zinc-900 px-4 py-3 pr-12 text-lg text-white placeholder-zinc-500 focus:outline-none disabled:opacity-50 transition-colors",
                  isRecording ? "border-red-500/50 focus:border-red-500" : "border-zinc-800 focus:border-blue-500"
                )}
                style={{ maxHeight: 200 }}
              />
              <button type="button" onClick={sendMessage} disabled={(!input.trim() && attachments.length === 0) || loading} className="absolute bottom-2.5 right-2.5 rounded-lg bg-blue-600 p-1.5 text-white transition-colors hover:bg-blue-700 disabled:opacity-30 disabled:hover:bg-blue-600">
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between text-xs text-zinc-600 px-1">
            <span>{isRecording && <span className="inline-flex items-center gap-1 text-red-400"><span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />正在录音...</span>}</span>
            <span>Enter 发送 · Shift+Enter 换行 · 支持拖拽/粘贴文件</span>
          </div>
        </div>
      </div>
    </div>
  );
}
