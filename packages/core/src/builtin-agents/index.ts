/**
 * 内置专家 Agent 模块 — 统一导出入口
 *
 * 提供 211 个来自 agency-agents-zh 的内置专家 Agent 目录和启动加载器。
 */

export { builtinAgentCatalog, builtinAgentCatalogMeta, getBuiltinSystemPrompt, getCachedSystemPrompt, DEPT_LABELS, DEPARTMENTS } from "./catalog.js";
export type { BuiltinAgentEntry, BuiltinAgentMeta } from "./catalog.js";
export { ensureBuiltinAgents } from "./loader.js";
