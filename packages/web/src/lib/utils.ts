import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

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
  const headers: HeadersInit = {
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
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

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const message = err.error || err.detail || res.statusText;
    showToast(message, "error");
    throw new Error(message);
  }
  return res.json();
}
