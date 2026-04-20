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
  ];

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
export { ConfigStore, SERVICE_CATALOG, getConfigStore, initConfigStore } from "./config-store.js";
export type { ServiceCatalogEntry, ServiceKeyDef, ServiceInfo } from "./config-store.js";
