/**
 * 环境变量统一访问入口（P2 集中化）。
 *
 * 设计原则：
 *   - 所有 process.env 读取必须通过此模块，便于测试 mock 和配置审计
 *   - getter 形式（非一次性快照）：支持运行时动态注入（如 dotenv 事后加载）
 *   - 默认值写死在 getter 中，消除散落的 `?? "default"` 模式
 *
 * 使用方式：
 *   import { Env } from "../config/env.js";
 *   const key = Env.DASHSCOPE_API_KEY;
 *
 * 渐进式迁移：优先替换高频 env key，后续版本逐步覆盖全量。
 */

export const Env = {
  // ── 服务端口 ──────────────────────────────────────────
  /** API 服务端口，默认 3001 */
  get PORT() { return parseInt(process.env.PORT ?? "3001", 10); },

  // ── LLM 密钥 ──────────────────────────────────────────
  /** 百炼（通义千问）API Key */
  get DASHSCOPE_API_KEY() { return process.env.DASHSCOPE_API_KEY ?? ""; },

  /** OpenAI API Key */
  get OPENAI_API_KEY() { return process.env.OPENAI_API_KEY ?? ""; },

  /** 通用 LLM API Key（provider-store 用） */
  get LLM_API_KEY() { return process.env.LLM_API_KEY ?? ""; },

  /** 通用 LLM Base URL */
  get LLM_BASE_URL() { return process.env.LLM_BASE_URL ?? ""; },

  /** 通用 LLM 模型名 */
  get LLM_MODEL() { return process.env.LLM_MODEL ?? ""; },

  // ── 凭据加密 ──────────────────────────────────────────
  /** 凭据加密主密钥 */
  get CREDENTIAL_MASTER_KEY() { return process.env.CREDENTIAL_MASTER_KEY ?? ""; },

  // ── 数据目录 ──────────────────────────────────────────
  /** 数据存储目录，默认 ./data */
  get DATA_DIR() { return process.env.DATA_DIR ?? "./data"; },

  // ── 调试与运行模式 ────────────────────────────────────
  /** 是否启用调试模式 */
  get DEBUG() { return process.env.DEBUG === "1" || process.env.NODE_ENV === "development"; },

  // ── 沙箱配置 ──────────────────────────────────────────
  /** 是否启用 Docker 沙箱 */
  get ENABLE_DOCKER_SANDBOX() { return process.env.ENABLE_DOCKER_SANDBOX === "1"; },

  // ── LLM 提供商 ────────────────────────────────────────
  /** LLM 提供商，默认通义千问 */
  get LLM_PROVIDER() { return process.env.LLM_PROVIDER ?? "qwen"; },

  // ── 下载镜像 ──────────────────────────────────────────
  /** FFmpeg 下载地址 */
  get FFMPEG_DOWNLOAD_URL() { return process.env.FFMPEG_DOWNLOAD_URL ?? ""; },

  /** FFprobe 下载地址 */
  get FFPROBE_DOWNLOAD_URL() { return process.env.FFPROBE_DOWNLOAD_URL ?? ""; },

  // ── Python/venv ───────────────────────────────────────
  /** UV pip index URL，默认阿里云镜像 */
  get UV_INDEX_URL() { return process.env.UV_INDEX_URL || "https://mirrors.aliyun.com/pypi/simple/"; },

  // ── Node 环境 ─────────────────────────────────────────
  /** Node 环境，默认 development */
  get NODE_ENV() { return process.env.NODE_ENV ?? "development"; },
} as const;
