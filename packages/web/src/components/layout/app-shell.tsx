import type { ReactNode } from "react";
import Sidebar from "@/components/layout/sidebar";
import { ToastContainer } from "@/components/ui/toast";
import { AuthGuard } from "@/components/auth/auth-guard";

/**
 * AppShell — 应用外壳：认证守卫 + 侧边栏 + 主内容 + 全局 Toast。
 *
 * @why 从 RootLayout 的 <body> 内部抽出。RootLayout 必须返回完整的
 * <html>，无法被 React Testing Library 直接挂载（React 19 拒绝把
 * <html> 塞进 <div>）；把可测试的结构抽到 AppShell，layout 只保留
 * <html><body><AppShell/></body></html> 的骨架。输出 DOM 完全一致。
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <AuthGuard sidebar={<Sidebar />}>{children}</AuthGuard>
      <ToastContainer />
    </>
  );
}
