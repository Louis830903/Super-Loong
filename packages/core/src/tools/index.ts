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

const logger = pino({ name: "tools" });

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
    return [...builtinTools, ..._cachedOptionalTools];
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
  return [...builtinTools, ...optionalTools];
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
