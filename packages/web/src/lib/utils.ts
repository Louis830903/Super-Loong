import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { describeErrorCode } from "@super-agent/web-types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

// WebSocket 基地址: 必须直连后端（Next.js rewrites 不支持 WebSocket 升级）
export const WS_BASE = (() => {
  // 如果配置了 NEXT_PUBLIC_API_URL，将 http(s) 替换为 ws(s)
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (apiUrl) return apiUrl.replace(/^http/, "ws");
  // 开发环境默认直连后端端口 3001
  if (typeof window !== "undefined") {
    return `ws://${window.location.hostname}:3001`;
  }
  return "";
})();

// ─── Toast Event System ─────────────────────────────────────

export type ToastType = "error" | "success" | "info";
type ToastListener = (message: string, type: ToastType) => void;
const toastListeners = new Set<ToastListener>();

export function onToast(fn: ToastListener): () => void {
  toastListeners.add(fn);
  return () => { toastListeners.delete(fn); };
}

export function showToast(message: string, type: ToastType = "error"): void {
  toastListeners.forEach((fn) => fn(message, type));
}

// ─── API Fetch ──────────────────────────────────────────────

export async function apiFetch<T = unknown>(
  path: string,
  options?: RequestInit
): Promise<T> {
  // 仅在有 body 时才添加 Content-Type，避免 DELETE/POST 空 body 触发 Fastify JSON 解析错误
  const hasBody = options?.body !== undefined && options?.body !== null;

  // 认证层: 从 localStorage 读取 token，存在则自动附加 Authorization 头
  const token = typeof window !== "undefined"
    ? localStorage.getItem("super-agent.auth-token")
    : null;

  const headers: HeadersInit = {
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options?.headers,
  };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch (e: any) {
    // 网络错误（服务不可达、DNS 失败、超时等）
    const message = e?.message?.includes("fetch")
      ? "无法连接到服务器，请检查网络或服务是否启动"
      : (e?.message || "网络请求失败");
    showToast(message, "error");
    throw new Error(message);
  }

  // 401 响应时清除失效 token 并提示重新登录
  if (res.status === 401 && token) {
    localStorage.removeItem("super-agent.auth-token");
    showToast("认证已过期，请重新登录", "error");
    throw new Error("认证已过期");
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // P4-T2: 支持新格式 { success: false, error: { code, message } } 和旧格式 { error: "..." }
    // v3 Task 11：优先用 error.code 查字典得到中文提示，message 作 fallback。
    //   脱敏后端在生产环境可能返回“内部服务器错误”等通用文案，前端按 code 可还原详细的中文语义。
    const code = err?.error?.code;
    const rawMessage = err?.error?.message || err?.error || err?.detail || res.statusText;
    const message = typeof code === "string" && code.length > 0
      ? describeErrorCode(code, rawMessage)
      : rawMessage;
    showToast(message, "error");
    throw new Error(message);
  }
  const json = await res.json();
  // P4-T2: 自动解包标准化响应 { success: true, data: ... }
  // 如果响应包含 success: true 和 data 字段，自动提取 data；否则返回原始 json（向后兼容）
  if (json && typeof json === "object" && (json as any).success === true && "data" in json) {
    return (json as any).data as T;
  }
  return json as T;
}

// ─── API Fetch Raw（非 JSON 场景统一认证层）─────────────────
//
// 返回原始 Response，不强制解析 JSON。
// 统一处理：
// 1. Authorization 头自动附加（从 localStorage 读 token）
// 2. Content-Type 仅在有 body 时添加
// 3. 401 自动清理过期 token 并提示
// 4. 网络错误（服务不可达）统一 toast
//
// 非 401 的 HTTP 错误由调用方自行处理（便于读 blob / stream / SSE）。
export async function apiFetchRaw(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const hasBody = options?.body !== undefined && options?.body !== null;
  const token = typeof window !== "undefined"
    ? localStorage.getItem("super-agent.auth-token")
    : null;

  const headers: HeadersInit = {
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options?.headers,
  };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch (e: any) {
    // 透传 AbortError，调用方可区分主动中断和网络错误
    if (e?.name === "AbortError") throw e;
    const message = e?.message?.includes("fetch")
      ? "无法连接到服务器，请检查网络或服务是否启动"
      : (e?.message || "网络请求失败");
    showToast(message, "error");
    throw new Error(message);
  }

  if (res.status === 401 && token) {
    localStorage.removeItem("super-agent.auth-token");
    showToast("认证已过期，请重新登录", "error");
    throw new Error("认证已过期");
  }

  return res;
}

// ─── 授权下载 ─────────────────────────────────────────────
//
// [WEB-P1-01] 替代 `<a href={...} download>` 模式。
// 浏览器 <a> 下载无法附加 Authorization 头，在启用鉴权的后端会被 401 拦截。
// 本函数：走 fetch 携 token → blob → 临时 URL → 触发下载 → 延后 revoke。
export async function downloadAuthorized(
  path: string,
  filename: string,
): Promise<void> {
  const res = await apiFetchRaw(path);
  if (!res.ok) {
    // 尝试解析服务器返回的错误体（API-P1-03 脱敏后为通用文案）
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // v3 Task 11：优先用 error.code 查字典，无码回退原始 message
    const code = err?.error?.code;
    const rawMsg = err?.error?.message || err?.error || err?.detail || `下载失败 (${res.status})`;
    const msg = typeof code === "string"
      ? describeErrorCode(code, rawMsg)
      : String(rawMsg);
    showToast(msg, "error");
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    // 部分浏览器要求 anchor 已入 DOM 才触发下载
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // 浏览器下载启动后再释放，避免某些浏览器下载中断
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// ─── SSE 流式读取（替代 EventSource）──────────────────────
//
// [WEB-P1-02] EventSource 原生不能附加 Authorization 头，JWT 鉴权端点无法连接。
// 本函数：用 fetch + ReadableStream 读 text/event-stream，自动带 token，
// 支持断线重连与主动中断；onEvent 收到已 JSON.parse 的 payload。
export interface SseOptions<T = any> {
  onEvent: (data: T) => void;
  onOpen?: () => void;
  onError?: (err: unknown) => void;
  /** 断线重连间隔（ms），默认 3000；传 0 则不重连 */
  reconnectDelayMs?: number;
}

export function apiFetchSse<T = any>(
  path: string,
  opts: SseOptions<T>,
): () => void {
  const reconnectDelay = opts.reconnectDelayMs ?? 3000;
  let controller: AbortController | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = async () => {
    if (stopped) return;
    controller = new AbortController();
    try {
      const res = await apiFetchRaw(path, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`SSE 连接失败 (${res.status})`);
      }
      opts.onOpen?.();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE 事件以空行（\n\n）分隔
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const rawLine of chunk.split("\n")) {
            if (!rawLine.startsWith("data: ")) continue;
            const data = rawLine.slice(6);
            if (data === "[DONE]") continue;
            try {
              opts.onEvent(JSON.parse(data) as T);
            } catch {
              /* 非 JSON 行静默忽略 */
            }
          }
        }
      }
    } catch (err: any) {
      if (stopped || err?.name === "AbortError") return;
      opts.onError?.(err);
      if (reconnectDelay > 0) {
        reconnectTimer = setTimeout(connect, reconnectDelay);
      }
    }
  };

  void connect();

  // 返回取消函数：主动中断 + 阻止重连
  return () => {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    controller?.abort();
  };
}
