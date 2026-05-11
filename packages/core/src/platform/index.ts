/**
 * 跨平台适配层 — barrel export。
 *
 * 原先各工具模块通过相对路径直接 import adapter/cli-detector，
 * 现在统一通过此 barrel 导出，与项目其他模块保持一致的风格。
 */

// ── adapter ──────────────────────────────────────────
export {
  getPlatformInfo,
  getCommand,
  buildShellArgs,
  normalizePath,
  getAvailableCommands,
  _resetPlatformCache,
} from "./adapter.js";
export type {
  OSPlatform,
  PlatformInfo,
  PlatformCommand,
  PlatformCommandMap,
} from "./adapter.js";
export { PLATFORM_COMMANDS } from "./adapter.js";

// ── cli-detector ─────────────────────────────────────
export {
  hasBinary,
  scanInstalledCLIs,
  detectCLIsByCategory,
  detectCLIs,
  getInstalledCLISummary,
  _resetCLICache,
} from "./cli-detector.js";
export {
  SYSTEM_CLIS,
  DEV_CLIS,
  OPS_CLIS,
  DESKTOP_CLIS,
  EXTERNAL_CLIS,
  CLI_CATEGORIES,
} from "./cli-detector.js";
export type {
  CLICategory,
  CLIDetectionResult,
  CLIScanResult,
} from "./cli-detector.js";
