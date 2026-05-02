/**
 * Runtime module — 运行时环境自举与依赖管理。
 *
 * 目前仅包含 video-forge 微服务的 bootstrap 逻辑，
 * 后续可扩展其他外部服务的环境管理。
 */
export {
  ensureVideoForgeDeps,
  detectPython,
  detectFfmpeg,
  downloadFfmpeg,
  ensureUvVenv,
  buildSpawnEnv,
} from "./bootstrap.js";

export type {
  VideoForgeDepsResult,
  BootstrapOptions,
} from "./bootstrap.js";

export {
  PythonNotFoundError,
  FfmpegDownloadError,
  VenvSetupError,
} from "./bootstrap.js";
