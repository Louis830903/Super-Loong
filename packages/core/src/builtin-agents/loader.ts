/**
 * 内置 Agent 启动加载器 — 系统启动时自动注册内置专家 Agent
 *
 * 幂等设计：已存在且版本相同则跳过，版本变更则增量更新。
 * v3 审查关键：必须在 setDefaultAgent() 之后调用，防止内置 Agent 抢占默认路由。
 */

import pino from "pino";
import { builtinAgentCatalog } from "./catalog.js";
import type { AgentManager } from "../agent/manager.js";
import { saveAgentConfig, deleteAgentConfig } from "../persistence/sqlite.js";
import { logConfigChange, sanitizeForAudit } from "../persistence/sqlite.js";
import type { AgentConfig } from "../types/index.js";

const logger = pino({ name: "builtin-agents" });

/**
 * P0-2 迁移辅助：从新格式 ID (builtin_dept-slug) 提取旧格式 ID (builtin_slug)
 * 用于检测是否存在旧 ID 的 Agent 需要迁移
 */
function legacyIdFromEntry(tpl: (typeof builtinAgentCatalog)[number]): string {
  return `builtin_${tpl.metadata.slug}`;
}

/**
 * 确保所有内置专家 Agent 已注册到 AgentManager 和 SQLite。
 *
 * P0-3: 移除 as unknown as 双重断言，使用 Partial<AgentConfig> 安全构造
 * P1-3: 版本比对增量更新，保留用户修改的 llmProvider
 * P2-3: 始终输出摘要日志
 * P3-4: 创建/更新时写入审计日志
 *
 * @param agentManager - Agent 管理器实例
 * @param defaultLlmConfig - 系统当前活跃 Provider 配置
 * @returns 创建、更新和跳过的数量统计
 */
export function ensureBuiltinAgents(
  agentManager: AgentManager,
  defaultLlmConfig: Record<string, unknown>,
): { created: number; updated: number; skipped: number } {
  // 已存在的 Agent ID → 实例映射
  const existingMap = new Map<string, ReturnType<typeof agentManager.getAgent>>();
  for (const a of agentManager.listAgents()) {
    existingMap.set(a.id, agentManager.getAgent(a.id));
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let migrated = 0;

  for (const tpl of builtinAgentCatalog) {
    const existing = existingMap.get(tpl.id);

    // P0-2 迁移：检查是否存在旧格式 ID (builtin_slug) 的 Agent
    const legacyId = legacyIdFromEntry(tpl);
    const legacyAgent = !existing ? existingMap.get(legacyId) : undefined;
    if (legacyAgent && !existing) {
      // 旧 ID 存在、新 ID 不存在 → 删除旧的，用新 ID 重新创建
      try {
        agentManager.deleteAgent(legacyId);
        deleteAgentConfig(legacyId); // 同时清理 SQLite 中的旧记录
        logger.info({ legacyId, newId: tpl.id }, "Migrating builtin agent to new ID format");
        migrated++;
      } catch (err) {
        logger.warn({ legacyId, err }, "Failed to delete legacy builtin agent during migration");
      }
      // 继续执行下方的 createAgent 逻辑（不 continue）
    } else if (existing) {
      // P1-3: 版本比对 — 仅当版本变更时增量更新
      const existingMeta = (existing as any).config?.metadata as Record<string, unknown> | undefined;
      const existingVersion = existingMeta?.version as string | undefined;
      const tplVersion = tpl.metadata.version;
      if (existingVersion === tplVersion) {
        skipped++;
        continue;
      }

      // 版本变更：更新 systemPrompt/description/metadata，保留用户配置的 llmProvider
      try {
        agentManager.updateAgent(tpl.id, {
          systemPrompt: tpl.systemPrompt,
          description: tpl.description,
          metadata: { ...tpl.metadata },
        } as Record<string, unknown>);
        // 持久化更新后的配置
        const updatedAgent = agentManager.getAgent(tpl.id);
        if (updatedAgent) {
          saveAgentConfig(tpl.id, (updatedAgent as any).config as Record<string, unknown>);
        }
        // P3-4: 审计日志
        logConfigChange("config.builtin-agent.update", sanitizeForAudit({
          agentId: tpl.id, oldVersion: existingVersion, newVersion: tplVersion,
        }));
        updated++;
      } catch (err) {
        logger.warn({ agentId: tpl.id, err }, "Failed to update builtin agent");
        skipped++;
      }
      continue;
    }

    // P0-3: 安全构造 Partial<AgentConfig>，不使用 as unknown as
    const config: Partial<AgentConfig> & { name: string } = {
      id: tpl.id,
      name: tpl.name,
      description: tpl.description,
      systemPrompt: tpl.systemPrompt,
      tools: [...tpl.tools],           // readonly → mutable
      skills: [...tpl.skills],
      channels: [...tpl.channels],
      memoryEnabled: tpl.memoryEnabled,
      maxToolIterations: tpl.maxToolIterations,
      metadata: { ...tpl.metadata },    // readonly → mutable
      llmProvider: defaultLlmConfig as unknown as AgentConfig["llmProvider"],
    };

    try {
      agentManager.createAgent(config);
      saveAgentConfig(config.id!, config as Record<string, unknown>);
      // P3-4: 审计日志
      logConfigChange("config.builtin-agent.create", sanitizeForAudit({
        agentId: tpl.id, version: tpl.metadata.version,
      }));
      created++;
    } catch (err) {
      logger.warn({ agentId: tpl.id, err }, "Failed to register builtin agent");
    }
  }

  // P2-3: 始终输出摘要日志
  logger.info({ created, updated, skipped, migrated, total: builtinAgentCatalog.length }, "Builtin expert agents check complete");

  return { created, updated, skipped };
}
