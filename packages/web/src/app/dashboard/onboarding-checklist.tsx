"use client";

import { useState, useEffect, useCallback } from "react";
import { Check, ArrowRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Activity, Settings, Bot, MessageSquare, Radio, Puzzle,
  BookMarked, CheckCircle2,
} from "lucide-react";

interface CheckStep {
  /** 唯一标识，用于 localStorage 持久化 */
  id: string;
  /** 任务名称 */
  title: string;
  /** 任务说明 */
  description: string;
  /** 跳转链接 */
  href: string;
  /** 图标 */
  icon: LucideIcon;
}

const STORAGE_KEY = "super-agent.onboarding-checklist.v1";

/** 7 个任务步骤 */
const STEPS: CheckStep[] = [
  {
    id: "system-up",
    title: "启动系统",
    description: "确认系统 API 连接正常，所有服务已启动",
    href: "/dashboard",
    icon: Activity,
  },
  {
    id: "config-model",
    title: "配置模型",
    description: "前往设置页，选择 Provider 填入 API Key 并保存",
    href: "/settings",
    icon: Settings,
  },
  {
    id: "create-agent",
    title: "创建 Agent",
    description: "创建你的第一个 AI Agent，设定角色和能力",
    href: "/agents",
    icon: Bot,
  },
  {
    id: "start-chat",
    title: "开始对话",
    description: "与 Agent 对话测试基本能力和效果",
    href: "/chat",
    icon: MessageSquare,
  },
  {
    id: "connect-channel",
    title: "连接 IM 通道",
    description: "连接企微、飞书或钉钉，让 Agent 接入 IM 平台",
    href: "/channels",
    icon: Radio,
  },
  {
    id: "install-skill",
    title: "安装技能",
    description: "从技能市场安装第一个技能，扩展 Agent 能力",
    href: "/skills",
    icon: Puzzle,
  },
  {
    id: "explore-advanced",
    title: "探索高级功能",
    description: "了解知识库、定时任务、MCP 工具等高级模块",
    href: "/knowledge",
    icon: BookMarked,
  },
];

function loadCompleted(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {};
}

function saveCompleted(completed: Record<string, boolean>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(completed));
  } catch {
    /* ignore */
  }
}

interface OnboardingChecklistProps {
  /** 系统健康状态 — 用于自动检测「启动系统」步骤 */
  systemHealthy: boolean;
}

/**
 * 新用户任务清单
 *
 * 将 Dashboard 的 Quick Actions 替换为可追踪的步骤清单，
 * 帮助新用户一步步探索平台。勾选状态通过 localStorage 持久化。
 */
export function OnboardingChecklist({ systemHealthy }: OnboardingChecklistProps) {
  const [completed, setCompleted] = useState<Record<string, boolean>>({});

  // 加载持久化状态
  useEffect(() => {
    setCompleted(loadCompleted());
  }, []);

  // 自动检测「启动系统」步骤
  useEffect(() => {
    if (systemHealthy) {
      setCompleted((prev) => {
        if (prev["system-up"]) return prev; // 已勾选则不动
        const next = { ...prev, "system-up": true };
        saveCompleted(next);
        return next;
      });
    }
  }, [systemHealthy]);

  // 切换步骤完成状态
  const toggleStep = useCallback((stepId: string) => {
    setCompleted((prev) => {
      const next = { ...prev, [stepId]: !prev[stepId] };
      saveCompleted(next);
      return next;
    });
  }, []);

  const completedCount = STEPS.filter((s) => completed[s.id]).length;
  const totalCount = STEPS.length;
  const allDone = completedCount === totalCount;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">快速开始</h2>
        <span className="text-sm text-zinc-500">
          {allDone ? (
            <span className="flex items-center gap-1 text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              全部完成 🎉
            </span>
          ) : (
            `已完成 ${completedCount}/${totalCount}`
          )}
        </span>
      </div>

      {/* 进度条 */}
      <div className="mb-4 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${allDone ? "bg-emerald-500" : "bg-blue-500"}`}
          style={{ width: `${(completedCount / totalCount) * 100}%` }}
        />
      </div>

      {/* 步骤列表 */}
      <div className="space-y-1.5">
        {STEPS.map((step) => {
          const isComplete = completed[step.id] ?? false;
          return (
            <div
              key={step.id}
              className={`group flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${
                isComplete
                  ? "border-zinc-800/50 bg-zinc-900/40"
                  : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
              }`}
            >
              {/* 复选框 */}
              <button
                onClick={() => toggleStep(step.id)}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                  isComplete
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : "border-zinc-700 text-transparent hover:border-zinc-500"
                }`}
                title={isComplete ? "标记为未完成" : "标记为已完成"}
              >
                {isComplete && <Check className="h-3.5 w-3.5" />}
              </button>

              {/* 内容 */}
              <div className={`flex-1 min-w-0 ${isComplete ? "opacity-60" : ""}`}>
                <div className="flex items-center gap-2">
                  <step.icon
                    className={`h-4 w-4 shrink-0 ${isComplete ? "text-zinc-500" : "text-blue-400"}`}
                  />
                  <span
                    className={`font-medium text-sm ${isComplete ? "text-zinc-500 line-through" : "text-white"}`}
                  >
                    {step.title}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-zinc-500">{step.description}</p>
              </div>

              {/* 跳转链接 */}
              <a
                href={step.href}
                className="shrink-0 rounded-lg p-1.5 text-zinc-600 hover:bg-zinc-800 hover:text-white transition-colors"
                title="前往此功能"
              >
                <ArrowRight className="h-4 w-4" />
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
