"use client";

import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface GuidedEmptyStateProps {
  /** 功能图标（lucide-react 组件） */
  icon: React.ElementType;
  /** 标题，如 "还没有记忆数据" */
  title: string;
  /** 功能一句话解释 */
  description: string;
  /** 操作引导步骤（3-5 条），每条简短说明 */
  steps: string[];
  /** 主要操作按钮 */
  action?: { label: string; onClick: () => void };
  /** 次要操作链接 */
  secondaryAction?: { label: string; href?: string; onClick?: () => void };
  /** 变体：default=灰色调, success=绿色调（如矛盾检测无结果） */
  variant?: "default" | "success";
}

/**
 * 引导式空状态组件
 *
 * 将"暂无数据"升级为"这是什么 + 能做什么 + 怎么开始"，
 * 帮助新用户理解每个功能的价值和上手方式。
 */
export function GuidedEmptyState({
  icon: Icon,
  title,
  description,
  steps,
  action,
  secondaryAction,
  variant = "default",
}: GuidedEmptyStateProps) {
  const isSuccess = variant === "success";

  return (
    <div
      className={cn(
        "rounded-xl border border-dashed p-10 text-center",
        isSuccess
          ? "border-emerald-700/40 bg-emerald-950/10"
          : "border-zinc-700 bg-zinc-900/20"
      )}
    >
      {/* 图标 */}
      <Icon
        className={cn(
          "mx-auto h-12 w-12",
          isSuccess ? "text-emerald-500" : "text-zinc-600"
        )}
      />

      {/* 标题 */}
      <h3 className="mt-4 text-lg font-semibold text-white">{title}</h3>

      {/* 描述 */}
      <p className="mt-2 text-sm text-zinc-400 max-w-md mx-auto leading-relaxed">
        {description}
      </p>

      {/* 操作步骤 */}
      <div className="mt-6 mx-auto max-w-sm text-left space-y-2">
        {steps.map((step, i) => (
          <div key={i} className="flex items-start gap-3">
            <span
              className={cn(
                "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                isSuccess
                  ? "bg-emerald-600/20 text-emerald-400"
                  : "bg-blue-600/20 text-blue-400"
              )}
            >
              {i + 1}
            </span>
            <span className="text-sm text-zinc-300 leading-relaxed">{step}</span>
          </div>
        ))}
      </div>

      {/* 操作按钮区 */}
      <div className="mt-6 flex items-center justify-center gap-3">
        {action && (
          <button
            onClick={action.onClick}
            className={cn(
              "rounded-lg px-4 py-2 text-sm font-medium transition-colors",
              isSuccess
                ? "bg-emerald-600 text-white hover:bg-emerald-700"
                : "bg-blue-600 text-white hover:bg-blue-700"
            )}
          >
            {action.label}
          </button>
        )}
        {secondaryAction && (secondaryAction.href ? (
          <a
            href={secondaryAction.href}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            {secondaryAction.label}
            <ChevronRight className="h-3.5 w-3.5" />
          </a>
        ) : (
          <button
            onClick={secondaryAction.onClick}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            {secondaryAction.label}
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        ))}
      </div>
    </div>
  );
}
