"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Bot,
  MessageSquare,
  Radio,
  Puzzle,
  Brain,
  Settings,
  Menu,
  X,
  Clock,
  Plug,
  Shield,
  Users,
  Sparkles,
  Image,
  Globe,
  Video,
  BookMarked,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { VersionFooter } from "./version-footer";

const navigation = [
  { name: "仪表盘", href: "/dashboard", icon: LayoutDashboard, testid: "nav-dashboard" },
  { name: "Agent 管理", href: "/agents", icon: Bot, testid: "nav-agents" },
  { name: "对话", href: "/chat", icon: MessageSquare, testid: "nav-chat" },
  { name: "通道管理", href: "/channels", icon: Radio, testid: "nav-channels" },
  { name: "技能市场", href: "/skills", icon: Puzzle, testid: "nav-skills" },
  { name: "记忆管理", href: "/memory", icon: Brain, testid: "nav-memory" },
  { name: "知识库", href: "/knowledge", icon: BookMarked, testid: "nav-knowledge" },
  { name: "MCP 工具", href: "/mcp", icon: Plug, testid: "nav-mcp" },
  { name: "定时任务", href: "/cron", icon: Clock, testid: "nav-cron" },
  { name: "多 Agent 协作", href: "/collaboration", icon: Users, testid: "nav-collaboration" },
  { name: "进化引擎", href: "/evolution", icon: Sparkles, testid: "nav-evolution" },
  { name: "A2A 协议", href: "/a2a", icon: Globe, testid: "nav-a2a" },
  { name: "媒体管理", href: "/media", icon: Image, testid: "nav-media" },
  { name: "视频工作室", href: "/video-studio", icon: Video, testid: "nav-video-studio" },
  { name: "安全管理", href: "/security", icon: Shield, testid: "nav-security" },
  { name: "系统设置", href: "/settings", icon: Settings, testid: "nav-settings" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile toggle */}
      <button
        className="fixed top-4 left-4 z-50 rounded-lg bg-zinc-900 p-2 text-white lg:hidden"
        onClick={() => setOpen(!open)}
      >
        {open ? <X size={20} /> : <Menu size={20} />}
      </button>

      {/* Overlay */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Sidebar — always w-64 on desktop, no collapse */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-zinc-800 bg-zinc-950 transition-transform duration-200 lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Logo */}
        <div className="flex h-16 items-center gap-2 border-b border-zinc-800 px-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="Super Loong" width={36} height={36} className="shrink-0 rounded-lg" />
          <span className="text-2xl font-extrabold text-white">Super Loong</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-4">
          {navigation.map((item) => {
            const active =
              pathname === item.href || pathname?.startsWith(item.href + "/");
            return (
              <Link
                key={item.name}
                href={item.href}
                onClick={() => setOpen(false)}
                data-testid={item.testid}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-blue-600/10 text-blue-400"
                    : "text-zinc-400 hover:bg-zinc-800/60 hover:text-white"
                )}
              >
                <item.icon className="h-5 w-5 shrink-0" />
                {item.name}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="border-t border-zinc-800 px-4 py-4">
          <VersionFooter variant="footer" />
        </div>
      </aside>
    </>
  );
}
