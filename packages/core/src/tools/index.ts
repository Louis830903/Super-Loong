/**
 * Built-in Tools Module — 核心同步工具 + 可选模块延迟加载。
 *
 * 同步加载（始终可用）：
 * - Filesystem: read_file, write_file, list_directory, search_files
 * - Code Execution: run_python, run_javascript, run_shell
 * - Web: http_request, scrape_url, web_search
 * - System/Data: get_current_time, json_parse, base64_encode, calculate, generate_uuid
 * - Config: configure_service
 * - Git: git_status, git_log, git_diff, git_commit
 * - Productivity: todo_manage, timer_set, clipboard_copy, env_info
 *
 * 延迟加载（依赖就绪时可用）：
 * - Browser: browser_navigate, browser_snapshot, browser_click, browser_type, browser_screenshot, browser_close
 * - Image: image_generate, image_edit, image_config
 * - Voice: tts_speak, stt_transcribe, voice_status
 * - Data Transform: csv_parse, xlsx_read, regex_extract, text_diff, hash_digest
 * - Media: pdf_extract, markdown_render, qrcode_generate
 * - Vision: vision_analyze, ocr_extract, vision_config
 */

import pino from "pino";
import type { ToolDefinition } from "../types/index.js";
import { filesystemTools } from "./filesystem.js";
import { codeExecTools } from "./code-exec.js";
import { webTools } from "./web.js";
import { systemDataTools } from "./system.js";
import { configureTools } from "./configure.js";
import { gitTools } from "./git-tools.js";
import { productivityTools } from "./productivity.js";
// P2-2: SQLite 持久化依赖
import { getDatabase } from "../persistence/sqlite.js";
import type { SqlJsDatabase } from "../persistence/sqlite/constants.js";

const logger = pino({ name: "tools" });

// ── 动态工具注册（Evolution Phase 4）──────────────────

/** 运行时动态注册的工具记录 */
const _dynamicToolDefs: Map<string, ToolDefinition[]> = new Map();

/** P2-2: 确保 dynamic_tools 表存在（懒初始化） */
let _dynamicToolsTableReady = false;
function ensureDynamicToolsTable(db: SqlJsDatabase): void {
  if (_dynamicToolsTableReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS dynamic_tools (
      name TEXT PRIMARY KEY,
      tool_defs TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  _dynamicToolsTableReady = true;
}

/** P2-2: 从 SQLite 恢复动态工具（模块加载时调用） */
function loadDynamicToolsFromDB(): void {
  try {
    const db = getDatabase();
    ensureDynamicToolsTable(db);
    const rows = db.prepare("SELECT name, tool_defs FROM dynamic_tools").all() as Array<{
      name: string;
      tool_defs: string;
    }>;
    for (const row of rows) {
      try {
        const toolDefs: ToolDefinition[] = JSON.parse(row.tool_defs);
        _dynamicToolDefs.set(row.name, toolDefs);
        logger.info({ name: row.name, count: toolDefs.length }, "动态工具已从 SQLite 恢复");
      } catch (parseErr: any) {
        logger.warn({ name: row.name, err: parseErr.message }, "动态工具 JSON 解析失败，跳过");
      }
    }
    if (rows.length > 0) {
      invalidateToolCache();
    }
  } catch (err: any) {
    // SQLite 读取失败不阻塞，静默降级到空 Map
    logger.debug({ err: err.message }, "无法从 SQLite 恢复动态工具（数据库可能未就绪）");
  }
}

// 模块加载时尝试恢复
loadDynamicToolsFromDB();

/**
 * 运行时动态注册工具（无需重启）。
 * 调用 invalidateToolCache() 后下次 getAllBuiltinTools() 会包含此工具。
 * P2-2: 同时持久化到 SQLite dynamic_tools 表。
 *
 * @param name — 工具唯一名
 * @param toolDefs — ToolDefinition 数组
 */
export function registerDynamicTool(name: string, toolDefs: ToolDefinition[]): void {
  _dynamicToolDefs.set(name, toolDefs);
  invalidateToolCache();
  logger.info({ name, count: toolDefs.length }, "动态工具已注册");

  // P2-2: 持久化到 SQLite
  try {
    const db = getDatabase();
    ensureDynamicToolsTable(db);
    const json = JSON.stringify(toolDefs);
    db.prepare(`
      INSERT OR REPLACE INTO dynamic_tools (name, tool_defs, updated_at)
      VALUES (?, ?, datetime('now'))
    `).run(name, json);
  } catch (err: any) {
    logger.warn({ name, err: err.message }, "动态工具 SQLite 持久化失败（非致命）");
  }
}

/**
 * 取消注册动态工具。
 * P2-2: 同时从 SQLite 删除。
 *
 * @param name — 工具唯一名
 * @returns 是否成功取消
 */
export function unregisterDynamicTool(name: string): boolean {
  const existed = _dynamicToolDefs.has(name);
  if (existed) {
    _dynamicToolDefs.delete(name);
    invalidateToolCache();
    logger.info({ name }, "动态工具已取消注册");

    // P2-2: 从 SQLite 删除
    try {
      const db = getDatabase();
      ensureDynamicToolsTable(db);
      db.prepare("DELETE FROM dynamic_tools WHERE name = ?").run(name);
    } catch (err: any) {
      logger.warn({ name, err: err.message }, "动态工具 SQLite 删除失败（非致命）");
    }
  }
  return existed;
}

/** 获取当前所有动态注册的工具定义 */
export function getDynamicToolDefs(): ToolDefinition[] {
  const all: ToolDefinition[] = [];
  for (const defs of _dynamicToolDefs.values()) {
    all.push(...defs);
  }
  return all;
}

/** 核心同步工具（含 configure_service + git + productivity） */
export const builtinTools: ToolDefinition[] = [
  ...filesystemTools,
  ...codeExecTools,
  ...webTools,
  ...systemDataTools,
  ...configureTools,
  ...gitTools,           // +4: git_status, git_log, git_diff, git_commit
  ...productivityTools,  // +4: todo_manage, timer_set, clipboard_copy, env_info
];

// ── 可选模块延迟加载缓存 ──────────────────────────

let _cachedOptionalTools: ToolDefinition[] | null = null;

/**
 * 清除可选工具缓存，使下次调用 getAllBuiltinTools() 重新评估 Feature Flag。
 * 用于 Settings UI 修改 Flag 后触发工具热加载。
 */
export function invalidateToolCache(): void {
  _cachedOptionalTools = null;
  logger.info("Optional tools cache invalidated — will reload on next getAllBuiltinTools()");
}

/**
 * 异步获取全部工具（核心 + 可选模块延迟加载）。
 * 每个可选模块独立 try/catch，加载失败静默降级。
 */
export async function getAllBuiltinTools(): Promise<ToolDefinition[]> {
  if (_cachedOptionalTools) {
    // Phase 4: 合并动态注册的工具
    return [...builtinTools, ...getDynamicToolDefs(), ..._cachedOptionalTools];
  }

  const optionalTools: ToolDefinition[] = [];

  // 每个可选模块独立 try/catch，失败不影响其他模块
  const loaders: Array<{ name: string; load: () => Promise<ToolDefinition[]> }> = [
    { name: "browser",        load: () => import("./browser.js").then(m => m.browserTools) },
    { name: "image-gen",      load: () => import("./image-gen.js").then(m => m.imageGenTools) },
    { name: "voice",          load: () => import("./voice-tools.js").then(m => m.voiceTools) },
    { name: "data-transform", load: () => import("./data-transform.js").then(m => m.dataTransformTools) },
    { name: "media",          load: () => import("./media.js").then(m => m.mediaTools) },
    { name: "vision",         load: () => import("./vision.js").then(m => m.visionTools) },
    { name: "video-forge",    load: () => import("./video-forge.js").then(m => m.videoForgeTools) },
    { name: "excel",          load: () => import("./excel-write.js").then(m => m.excelTools) },
    { name: "insight",        load: () => import("./data-insight.js").then(m => m.insightTools) },
  ];

  // ── SysOps 系统操作工具 (Feature Flag 控制) ──
  // 总开关: SUPER_AGENT_SYSOPS_ENABLED=true 才注册任何系统操作工具
  if (process.env.SUPER_AGENT_SYSOPS_ENABLED === "true") {
    // 终端引擎 — P0核心(总开关开启即可用)
    loaders.push({
      name: "terminal",
      load: () => import("./terminal-engine.js").then(m => m.terminalTools),
    });

    // 运维工具 — P1
    if (process.env.SUPER_AGENT_OPS_TOOLS === "true") {
      loaders.push(
        { name: "ops-docker",   load: () => import("./ops/docker-manage.js").then(m => m.dockerTools) },
        { name: "ops-service",  load: () => import("./ops/service-manage.js").then(m => m.serviceTools) },
        { name: "ops-network",  load: () => import("./ops/network-diagnose.js").then(m => m.networkTools) },
        { name: "ops-monitor",  load: () => import("./ops/system-monitor.js").then(m => m.monitorTools) },
        { name: "ops-deploy",   load: () => import("./ops/deploy-execute.js").then(m => m.deployTools) },
      );
    }

    // 开发辅助 — P1
    if (process.env.SUPER_AGENT_DEV_TOOLS === "true") {
      loaders.push(
        { name: "dev-git",      load: () => import("./git-tools.js").then(m => m.gitAdvancedTools) },
        { name: "dev-package",  load: () => import("./dev/package-manage.js").then(m => m.packageTools) },
        { name: "dev-test",     load: () => import("./dev/test-build.js").then(m => m.testBuildTools) },
        { name: "dev-env",      load: () => import("./dev/env-manage.js").then(m => m.envManageTools) },
      );
    }

    // 桌面控制 — P1
    if (process.env.SUPER_AGENT_DESKTOP_TOOLS === "true") {
      loaders.push(
        { name: "desktop-gui",     load: () => import("./desktop/gui-control.js").then(m => m.guiTools) },
        { name: "desktop-screen",  load: () => import("./desktop/screen-capture.js").then(m => m.screenTools) },
        { name: "desktop-app",     load: () => import("./desktop/app-control.js").then(m => m.appTools) },
      );
    }

    // Computer Use Loop — 独立开关
    if (process.env.SUPER_AGENT_COMPUTER_USE === "true") {
      loaders.push({
        name: "computer-use",
        load: () => import("./desktop/computer-use.js").then(m => m.computerUseTools),
      });
    }
  }

  for (const { name, load } of loaders) {
    try {
      const tools = await load();
      optionalTools.push(...tools);
      logger.info({ module: name, count: tools.length }, "可选工具模块加载成功");
    } catch {
      // 静默跳过：依赖未安装或配置缺失时不影响核心功能
      logger.debug({ module: name }, "可选工具模块跳过（依赖未就绪）");
    }
  }

  _cachedOptionalTools = optionalTools;
  return [...builtinTools, ...getDynamicToolDefs(), ...optionalTools];
}

/** 按品类获取工具 */
export function getToolsByCategory(category: "filesystem" | "code" | "web" | "system" | "config" | "git" | "productivity"): ToolDefinition[] {
  switch (category) {
    case "filesystem": return filesystemTools;
    case "code": return codeExecTools;
    case "web": return webTools;
    case "system": return systemDataTools;
    case "config": return configureTools;
    case "git": return gitTools;
    case "productivity": return productivityTools;
  }
}

export { filesystemTools } from "./filesystem.js";
export { codeExecTools } from "./code-exec.js";
export { webTools } from "./web.js";
export { systemDataTools } from "./system.js";
export { configureTools } from "./configure.js";
export { gitTools } from "./git-tools.js";
export { productivityTools } from "./productivity.js";
export { ConfigStore, SERVICE_CATALOG, getConfigStore, initConfigStore, syncEnvVarToFile } from "./config-store.js";
export type { ServiceCatalogEntry, ServiceKeyDef, ServiceInfo } from "./config-store.js";
