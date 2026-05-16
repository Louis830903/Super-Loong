/**
 * 内置 Agent 启动加载器 — 系统启动时自动注册内置专家 Agent
 *
 * 幂等设计：已存在且版本相同则跳过，版本变更则增量更新。
 * v3 审查关键：必须在 setDefaultAgent() 之后调用，防止内置 Agent 抢占默认路由。
 *
 * 🔧 P0 修复：SQLite 事务批处理 — 211 次写入合并为 1 个事务，
 *    避免逐次 fsync 导致的 I/O 风暴卡死（better-sqlite3 同步 WAL 写瓶颈）。
 */

import pino from "pino";
import { builtinAgentCatalogMeta, getBuiltinSystemPrompt } from "./catalog.js";
import type { AgentManager } from "../agent/manager.js";
import {
  saveAgentConfig,
  deleteAgentConfig,
  logConfigChange,
  sanitizeForAudit,
  getDatabase,
} from "../persistence/sqlite.js";
import type { AgentConfig } from "../types/index.js";

const logger = pino({ name: "builtin-agents" });

/** 每 N 个 Agent 输出一次进度日志（诊断卡死位置） */
const PROGRESS_INTERVAL = 50;

/**
 * P0-2 迁移辅助：从新格式 ID (builtin_dept-slug) 提取旧格式 ID (builtin_slug)
 * 用于检测是否存在旧 ID 的 Agent 需要迁移
 */
function legacyIdFromEntry(tpl: (typeof builtinAgentCatalogMeta)[number]): string {
  return `builtin_${tpl.metadata.slug}`;
}

/**
 * 确保所有内置专家 Agent 已注册到 AgentManager 和 SQLite。
 *
 * P0-3: 移除 as unknown as 双重断言，使用 Partial<AgentConfig> 安全构造
 * P1-3: 版本比对增量更新，保留用户修改的 llmProvider
 * P2-3: 始终输出摘要日志
 * P3-4: 创建/更新时写入审计日志
 * 🔧 P0 修复：轻量模式 + 事务批处理 + 惰性 existingMap，
 *    消除 211 Agent 同步构造时的 I/O 风暴（execSync、Markdown 快照、双重 LLMProvider）。
 *
 * @param agentManager - Agent 管理器实例
 * @param defaultLlmConfig - 系统当前活跃 Provider 配置
 * @returns 创建、更新和跳过的数量统计
 */
export async function ensureBuiltinAgents(
  agentManager: AgentManager,
  defaultLlmConfig: Record<string, unknown>,
): Promise<{ created: number; updated: number; skipped: number }> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let migrated = 0;
  let failed = 0;
  const total = builtinAgentCatalogMeta.length;

  // 🔧 事务批处理：211 次 SQLite 写入合并为 1 个事务
  // better-sqlite3 同步 WAL 模式下，逐条 INSERT 都会触发 fsync，
  // 211 次串行 I/O 在 Windows 上可导致数秒~数十秒的阻塞卡死。
  // BEGIN 后所有写入暂存内存，COMMIT 时一次性落盘。
  let inTransaction = false;
  try {
    const db = getDatabase();
    db.exec("BEGIN");
    inTransaction = true;
    logger.debug("SQLite transaction BEGIN for builtin agents batch");
  } catch (err) {
    logger.warn({ err }, "Cannot start SQLite transaction, falling back to individual writes");
  }

  for (let i = 0; i < total; i++) {
    const tpl = builtinAgentCatalogMeta[i];

    // 🔧 每 PROGRESS_INTERVAL 个 Agent 输出进度日志
    if (i > 0 && i % PROGRESS_INTERVAL === 0) {
      logger.info(
        { progress: `${i}/${total}`, created, updated, skipped, failed },
        "Builtin agents registration progress",
      );
    }

    // 🔧 P5 修复：直接通过 agentManager.getAgent() 惰性查询，
    // 不再预构建全量 existingMap（O(n) 遍历 + O(n) 内存）
    try {
      const existing = agentManager.getAgent(tpl.id);

      // P0-2 迁移：检查是否存在旧格式 ID (builtin_slug) 的 Agent
      const legacyId = legacyIdFromEntry(tpl);
      const legacyAgent = !existing ? agentManager.getAgent(legacyId) : undefined;
      if (legacyAgent && !existing) {
        // 旧 ID 存在、新 ID 不存在 → 删除旧的，用新 ID 重新创建
        try {
          agentManager.deleteAgent(legacyId);
          deleteAgentConfig(legacyId);
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
        // P4-T4: 按需加载 systemPrompt
        const sysPrompt = await getBuiltinSystemPrompt(tpl.id);
        agentManager.updateAgent(tpl.id, {
          systemPrompt: sysPrompt ?? "",
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
        continue;
      }

      // P0-3: 安全构造 Partial<AgentConfig>，不使用 as unknown as
      // P4-T4: 按需加载 systemPrompt
      const sysPrompt = await getBuiltinSystemPrompt(tpl.id);
      const config: Partial<AgentConfig> & { name: string } = {
        id: tpl.id,
        name: tpl.name,
        description: tpl.description,
        systemPrompt: sysPrompt ?? "",
        tools: [...tpl.tools],
        skills: [...tpl.skills],
        channels: [...tpl.channels],
        memoryEnabled: tpl.memoryEnabled,
        maxToolIterations: tpl.maxToolIterations,
        metadata: { ...tpl.metadata },
        llmProvider: defaultLlmConfig as unknown as AgentConfig["llmProvider"],
      };

      // 🔧 P0 修复：轻量模式创建 Agent，跳过重型初始化
      agentManager.createAgent(config, { lightweight: true });
      saveAgentConfig(config.id!, config as Record<string, unknown>);
      // P3-4: 审计日志
      logConfigChange("config.builtin-agent.create", sanitizeForAudit({
        agentId: tpl.id, version: tpl.metadata.version,
      }));
      created++;
    } catch (err) {
      logger.warn({ agentId: tpl.id, err }, "Failed to register builtin agent");
      failed++;
    }
  }

  // 提交事务
  if (inTransaction) {
    try {
      const db = getDatabase();
      db.exec("COMMIT");
      logger.debug("SQLite transaction COMMIT for builtin agents batch");
    } catch (err) {
      logger.warn({ err }, "Failed to commit builtin agents transaction, attempting rollback");
      try { getDatabase().exec("ROLLBACK"); } catch { /* best-effort */ }
    }
  }

  // P2-3: 始终输出摘要日志
  logger.info(
    { created, updated, skipped, migrated, failed, total },
    "Builtin expert agents check complete",
  );

  return { created, updated, skipped };
}
