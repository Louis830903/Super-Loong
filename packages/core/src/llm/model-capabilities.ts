/**
 * C-1: 模型能力检测 — 学 Hermes models_dev.py + CrewAI supports_multimodal()
 * 根据模型名称推断是否支持 vision / PDF / audio
 */

// 支持视觉输入的模型前缀列表（按厂商分组）
const VISION_MODELS = [
  // OpenAI
  "gpt-4o", "gpt-4-turbo", "gpt-4-vision", "gpt-4.1", "gpt-5",
  "o1", "o3", "o4",
  // Anthropic
  "claude-3", "claude-4", "claude-sonnet", "claude-opus", "claude-haiku",
  // Google
  "gemini",
  // xAI
  "grok",
  // 千问 (Qwen) — qwen3.6/3.5-plus 为统一多模态，VL 系列为专用视觉
  "qwen-vl", "qwen2-vl", "qwen3-vl", "qwen3.6", "qwen3.5-plus",
  // Mistral
  "pixtral",
  // 智谱 (GLM) — 带 V 后缀的是视觉模型
  "glm-5v", "glm-4.6v", "glm-4.1v", "glm-4v",
  // Moonshot (Kimi) — 特定视觉型号
  "kimi-k2.5",
];

// 明确不支持视觉的纯文本模型（优先匹配，覆盖上面的宽泛前缀）
const TEXT_ONLY_MODELS = [
  "o3-mini", "o1-mini", "o1-preview",
  // 千问 3.5-flash 不支持视觉（避免被前缀误匹配）
  "qwen3.5-flash",
];

// 支持原生 PDF 输入的模型
const NATIVE_PDF_MODELS = [
  "claude-3", "claude-4",  // Anthropic 支持原生 PDF
  "gemini",                // Google 支持原生 PDF
];

/**
 * 根据模型名称推断是否支持图片视觉输入
 */
export function supportsVision(model: string): boolean {
  const m = model.toLowerCase();
  // 先检查排除列表
  if (TEXT_ONLY_MODELS.some(t => m.startsWith(t) || m.includes(`/${t}`))) return false;
  // 再检查支持列表
  return VISION_MODELS.some(v => m.startsWith(v) || m.includes(`/${v}`));
}

/**
 * 根据模型名称推断是否支持原生 PDF 输入
 */
export function supportsNativePdf(model: string): boolean {
  const m = model.toLowerCase();
  return NATIVE_PDF_MODELS.some(v => m.startsWith(v) || m.includes(`/${v}`));
}
