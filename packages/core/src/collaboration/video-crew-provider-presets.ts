/**
 * video-crew-provider-presets.ts — ShortVideoCrew 模型配置预设
 *
 * 4 套系统预设，对应 migrateV16 中 INSERT 的 agent_provider_templates：
 * - balanced: 平衡方案（Qwen Plus 主力）
 * - cheap: 成本优先（Qwen Turbo + DeepSeek Chat）
 * - zh_best: 中文最优（Qwen Max + GLM-5V）
 * - local: 本地部署（Ollama 全量，零成本）
 *
 * 每个预设是一个 Record<AgentId, { providerId, model }>，
 * 可直接传入 POST /api/video/jobs 的 agent_providers 字段。
 *
 * @see Spec §4.6 模型配置
 * @see migrateV16() 系统预设初始数据
 */

import { VIDEO_AGENT_IDS } from "./video-crew-presets.js";

// ─── 预设类型 ──────────────────────────────────────────────

export interface AgentProviderOverride {
  providerId: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export type ProviderPresetMap = Record<string, AgentProviderOverride>;

export interface ProviderPreset {
  id: string;
  name: string;
  description: string;
  providers: ProviderPresetMap;
}

// ─── 4 套系统预设 ──────────────────────────────────────────

const { WRITER, DESIGNER, STORYBOARD, VOICE, VIDEO, EDITOR } = VIDEO_AGENT_IDS;

/** 平衡方案：性价比最优，Qwen Plus 主力 + DeepSeek Chat 辅助 */
export const PRESET_BALANCED: ProviderPreset = {
  id: "preset_balanced",
  name: "平衡方案",
  description: "性价比最优：Qwen Plus 主力 + DeepSeek Chat 辅助，适合大多数场景",
  providers: {
    [WRITER]:     { providerId: "qwen", model: "qwen-plus" },
    [DESIGNER]:   { providerId: "qwen", model: "qwen-plus" },
    [STORYBOARD]: { providerId: "qwen", model: "qwen-plus" },
    [VOICE]:      { providerId: "qwen", model: "qwen-plus" },
    [VIDEO]:      { providerId: "qwen", model: "qwen-plus" },
    [EDITOR]:     { providerId: "deepseek", model: "deepseek-chat" },
  },
};

/** 成本优先：最低成本，Qwen Turbo + DeepSeek Chat */
export const PRESET_CHEAP: ProviderPreset = {
  id: "preset_cheap",
  name: "成本优先",
  description: "最低成本：Qwen Turbo + DeepSeek Chat，牺牲部分质量换取低开销",
  providers: {
    [WRITER]:     { providerId: "qwen", model: "qwen-turbo" },
    [DESIGNER]:   { providerId: "deepseek", model: "deepseek-chat" },
    [STORYBOARD]: { providerId: "deepseek", model: "deepseek-chat" },
    [VOICE]:      { providerId: "qwen", model: "qwen-turbo" },
    [VIDEO]:      { providerId: "deepseek", model: "deepseek-chat" },
    [EDITOR]:     { providerId: "deepseek", model: "deepseek-chat" },
  },
};

/** 中文最优：顶级中文模型，Qwen Max + GLM-5V */
export const PRESET_ZH_BEST: ProviderPreset = {
  id: "preset_zh_best",
  name: "中文最优",
  description: "顶级中文模型：Qwen Max 生成 + GLM-5V 视觉，追求最高中文质量",
  providers: {
    [WRITER]:     { providerId: "qwen", model: "qwen3-max" },
    [DESIGNER]:   { providerId: "zhipu", model: "GLM-5V-Turbo" },
    [STORYBOARD]: { providerId: "qwen", model: "qwen3-max" },
    [VOICE]:      { providerId: "qwen", model: "qwen3-max" },
    [VIDEO]:      { providerId: "zhipu", model: "GLM-5V-Turbo" },
    [EDITOR]:     { providerId: "qwen", model: "qwen3-max" },
  },
};

/** 本地部署：Ollama 全量，零成本（需本地 GPU） */
export const PRESET_LOCAL: ProviderPreset = {
  id: "preset_local",
  name: "本地部署",
  description: "Ollama 全量本地推理，零 API 费用但需 GPU（建议 ≥16GB VRAM）",
  providers: {
    [WRITER]:     { providerId: "ollama", model: "qwen2.5:14b" },
    [DESIGNER]:   { providerId: "ollama", model: "qwen2.5:14b" },
    [STORYBOARD]: { providerId: "ollama", model: "qwen2.5:14b" },
    [VOICE]:      { providerId: "ollama", model: "qwen2.5:14b" },
    [VIDEO]:      { providerId: "ollama", model: "qwen2.5:14b" },
    [EDITOR]:     { providerId: "ollama", model: "qwen2.5:14b" },
  },
};

/** 所有系统预设列表 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  PRESET_BALANCED,
  PRESET_CHEAP,
  PRESET_ZH_BEST,
  PRESET_LOCAL,
];
