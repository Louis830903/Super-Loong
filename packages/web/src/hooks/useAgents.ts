"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/utils";

/**
 * Agent 基础信息接口 — 各页面共享
 * 从 /api/agents 返回的原始数据中提取并扁平化
 */
export interface AgentInfo {
  id: string;
  name: string;
  model: string;
  description: string;
  provider: string;
  systemPrompt: string;
  createdAt: string;
  // 内置专家 Agent 扩展字段（v3）
  isBuiltin: boolean;
  department: string;
  departmentLabel: string;
  color: string | null;
  // P2-2: 内置 Agent 的原始工具列表
  originalTools: string[];
}

/**
 * 共享 useAgents Hook — 统一 Agent 列表加载逻辑
 *
 * 消除 chat / collaboration / cron / agents 等页面中重复的
 * apiFetch("/api/agents") + 数据映射代码
 */
export function useAgents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  // P1-1: 增加 error 状态，区分「空列表」和「加载失败」
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    return apiFetch<{
      agents: Array<{
        id: string;
        config?: {
          name?: string;
          description?: string;
          llmProvider?: { type?: string; model?: string };
          systemPrompt?: string;
          metadata?: Record<string, unknown>;
        };
        status?: string;
        createdAt?: string;
      }>;
    }>("/api/agents")
      .then((data) => {
        const list: AgentInfo[] = (data.agents ?? []).map((a) => ({
          id: a.id,
          name: a.config?.name ?? "Unnamed",
          model: a.config?.llmProvider?.model ?? "",
          description: a.config?.description ?? "",
          provider: a.config?.llmProvider?.type ?? "openai",
          systemPrompt: a.config?.systemPrompt ?? "",
          createdAt: a.createdAt ?? "",
          // 内置专家 Agent 扩展字段
          isBuiltin: (a.config?.metadata as any)?.isBuiltin ?? false,
          department: (a.config?.metadata as any)?.department ?? "",
          departmentLabel: (a.config?.metadata as any)?.departmentLabel ?? "",
          color: (a.config?.metadata as any)?.color ?? null,
          // P2-2: 内置 Agent 原始工具列表
          originalTools: (() => {
            const ot = (a.config?.metadata as any)?.originalTools;
            if (Array.isArray(ot)) return ot;
            if (typeof ot === "string") return ot.split(",").map((s: string) => s.trim()).filter(Boolean);
            return [];
          })(),
        }));
        setAgents(list);
        return list;
      })
      .catch((err) => {
        // P1-1: 保留 error 信息供 UI 展示
        setError(err?.message || "加载 Agent 列表失败");
        return [] as AgentInfo[];
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { agents, loading, error, refresh };
}
