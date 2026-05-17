/**
 * Vitest 全局初始化
 *
 * Mock Next.js 专用模块（next/font, next/script, next/navigation 等），
 * 使其在 jsdom 环境中可运行。
 */

import { vi } from "vitest";

// Mock next/font/google — 返回返回 CSS 变量名的无操作函数
vi.mock("next/font/google", () => ({
  Geist: () => ({
    variable: "--font-geist-sans",
    subsets: ["latin"],
  }),
  Geist_Mono: () => ({
    variable: "--font-geist-mono",
    subsets: ["latin"],
  }),
}));

// Mock next/script — 返回空 script 标签
vi.mock("next/script", () => ({
  default: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// Mock next/navigation — 提供 usePathname / useRouter
vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/dashboard"),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

// Mock next/link — 渲染为普通 <a> 标签
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => {
    // eslint-disable-next-line jsx-a11y/anchor-is-valid
    return <a href={href} {...props}>{children}</a>;
  },
}));
