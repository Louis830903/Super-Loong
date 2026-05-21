"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

/**
 * AuthGuard — 客户端认证守卫。
 *
 * 功能：
 * 1. 检查 localStorage 中是否有 JWT token
 * 2. 未认证时重定向到 /login（/login 页面本身除外）
 * 3. 监听 sa:auth-expired 事件（由 apiFetch 401 / WebSocket 4001 触发），自动跳转登录页
 * 4. 控制 Sidebar 的显示：登录页不显示侧边栏
 */
export function AuthGuard({
  children,
  sidebar,
}: {
  children: ReactNode;
  sidebar: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // 用三态来避免 SSR/CSR 闪烁：null = 加载中, true = 已认证, false = 未认证
  const [authed, setAuthed] = useState<boolean | null>(null);

  const isLoginPage = pathname === "/login";

  // 初始检查 + 监听 auth-expired 事件
  useEffect(() => {
    const checkAuth = () => {
      const token = localStorage.getItem("super-agent.auth-token");
      setAuthed(!!token);
    };

    checkAuth();

    // apiFetch 遇到 401 时清除 token 并触发此事件
    const handleExpired = () => {
      localStorage.removeItem("super-agent.auth-token");
      setAuthed(false);
    };

    window.addEventListener("sa:auth-expired", handleExpired);
    // storage 事件：其他 tab 清除 token 时同步
    window.addEventListener("storage", checkAuth);

    return () => {
      window.removeEventListener("sa:auth-expired", handleExpired);
      window.removeEventListener("storage", checkAuth);
    };
  }, []);

  // 未认证且不在登录页时 → 跳转登录页
  useEffect(() => {
    if (authed === false && !isLoginPage) {
      router.replace("/login");
    }
  }, [authed, isLoginPage, router]);

  // 已认证但在登录页 → 跳转到 dashboard
  useEffect(() => {
    if (authed === true && isLoginPage) {
      router.replace("/dashboard");
    }
  }, [authed, isLoginPage, router]);

  // SSR → CSR 过渡：还在检查 token 时显示空白（避免闪烁）
  if (authed === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-600 border-t-blue-500" />
      </div>
    );
  }

  // 登录页：不显示侧边栏，直接渲染 children（即 LoginPage）
  if (isLoginPage) {
    return <>{children}</>;
  }

  // 未认证：不渲染任何内容（useEffect 会跳转）
  if (!authed) {
    return null;
  }

  // 已认证：显示侧边栏 + 主内容
  return (
    <>
      {sidebar}
      <main className="main-content min-h-screen transition-all duration-200">
        <div className="p-6 lg:p-8">{children}</div>
      </main>
    </>
  );
}
