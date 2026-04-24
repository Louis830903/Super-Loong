import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

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
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const message = err.error || err.detail || res.statusText;
    showToast(message, "error");
    throw new Error(message);
  }
  return res.json();
}
