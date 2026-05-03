"use client";

import { useState, useCallback, useEffect } from "react";
import { ChevronDown, ChevronUp, Info } from "lucide-react";

interface FeatureBannerProps {
  /** 页面唯一标识，用于 localStorage 持久化折叠状态 */
  pageId: string;
  /** 功能图标（lucide-react 组件） */
  icon: React.ElementType;
  /** 功能名称 */
  title: string;
  /** 一句话解释 */
  description: string;
  /** 典型使用场景 */
  useCases: string[];
  /** 使用技巧/注意事项（可选） */
  tips?: string[];
}

const STORAGE_KEY = "super-agent.feature-banners.v1";

/**
 * 可折叠功能介绍横幅
 *
 * 在复杂功能页面顶部显示，帮助新用户理解功能价值和典型用法。
 * 首次访问默认展开，收起状态通过 localStorage 持久化。
 */
export function FeatureBanner({
  pageId,
  icon: Icon,
  title,
  description,
  useCases,
  tips,
}: FeatureBannerProps) {
  const [expanded, setExpanded] = useState(true);

  // 从 localStorage 读取初始折叠状态
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const prefs = JSON.parse(raw);
        if (typeof prefs[pageId] === "boolean") {
          setExpanded(prefs[pageId]);
        }
      }
    } catch {
      /* ignore parse errors */
    }
  }, [pageId]);

  // 持久化折叠状态
  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const prefs = raw ? JSON.parse(raw) : {};
        prefs[pageId] = next;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      } catch {
        /* ignore storage errors */
      }
      return next;
    });
  }, [pageId]);

  return (
    <div className="rounded-xl border border-blue-500/20 bg-gradient-to-b from-blue-500/10 to-transparent overflow-hidden">
      {/* 标题栏 */}
      <button
        onClick={toggle}
        className="flex w-full items-center justify-between px-5 py-3.5 text-left hover:bg-blue-500/5 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <Icon className="h-5 w-5 shrink-0 text-blue-400" />
          <span className="font-medium text-white truncate">{title}</span>
          {!expanded && (
            <span className="text-sm text-zinc-500 truncate hidden sm:inline">
              — {description}
            </span>
          )}
        </div>
        <span className="shrink-0 text-zinc-500 ml-3">
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </span>
      </button>

      {/* 展开内容 */}
      {expanded && (
        <div className="px-5 pb-5 border-t border-blue-500/10">
          {/* 描述 */}
          <p className="mt-4 text-sm text-zinc-300 leading-relaxed max-w-3xl">
            <Info className="inline h-4 w-4 mr-1.5 text-blue-400 -mt-0.5" />
            {description}
          </p>

          {/* 典型使用场景 */}
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
              典型使用场景
            </h4>
            <ul className="mt-2 space-y-1.5">
              {useCases.map((uc, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-sm text-zinc-300"
                >
                  <span className="mt-1.5 block h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500/60" />
                  {uc}
                </li>
              ))}
            </ul>
          </div>

          {/* 使用技巧 */}
          {tips && tips.length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
                使用技巧
              </h4>
              <ul className="mt-2 space-y-1.5">
                {tips.map((tip, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-sm text-zinc-400"
                  >
                    <span className="mt-1.5 block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500/60" />
                    {tip}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
