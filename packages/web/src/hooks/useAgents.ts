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

  const refresh = useCallback(() => {
    setLoading(true);
    return apiFetch<{
      agents: Array<{
        id: string;
        config?: {
          name?: string;
          description?: string;
          llmProvider?: { type?: string; model?: string };
          systemPrompt?: string;
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
        }));
        setAgents(list);
        return list;
      })
      .catch(() => [] as AgentInfo[])
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { agents, loading, refresh };
}
