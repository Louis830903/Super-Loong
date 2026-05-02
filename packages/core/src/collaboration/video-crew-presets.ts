/**
 * video-crew-presets.ts — ShortVideoCrew 预设定义
 *
 * 导出 `buildShortVideoCrew()` 函数，根据用户参数构建完整的 CrewConfig。
 *
 * 设计要点（Spec §4.3）：
 * - 6 Agent + 7 Task 的依赖图
 * - Task 1/2/3 挂载 Zod guardrail（via buildGuardrail 适配器）
 * - T4/T5 标记 async=true，T2.0 改造后自动并行
 * - process: "sequential"（orchestrator 内部处理 async 分组）
 * - Agent tools 按角色分配（Writer/Designer/Storyboard 纯 LLM，Voice/Video/Editor 带工具）
 *
 * @see Spec §4.3 ShortVideoCrew Agent 编排
 * @see video-crew-prompts.ts 6 Agent 系统提示词
 * @see video-crew-schemas.ts Zod Schema 契约 + buildGuardrail
 */

import type { CrewConfig, CrewTask } from "./orchestrator.js";
import type { AgentConfig } from "../types/index.js";
import {
  scriptGuardrail,
  imagePromptsGuardrail,
  storyboardGuardrail,
  voiceGuardrail,
  videoGuardrail,
} from "./video-crew-schemas.js";
import {
  WRITER_AGENT_PROMPT,
  DESIGNER_AGENT_PROMPT,
  STORYBOARD_AGENT_PROMPT,
  VIDEO_AGENT_PROMPT,
  VOICE_AGENT_PROMPT,
  EDITOR_AGENT_PROMPT,
} from "./video-crew-prompts.js";
// P0-D：T4/T5/T6/T7 改由 Code Node 执行（确定性代码 + 顺序调工具），
// 彻底消除 LLM 路径幻觉 / 不调工具 / JSON 解析失败三类不确定性。
import {
  voiceSynthesisHandler,
  visualProductionHandler,
  frameCompositionHandler,
  finalMergeHandler,
} from "./video-crew-handlers.js";

// ─── Agent ID 常量 ──────────────────────────────────────
// CTR-P1-01：单一数据源迁至 @super-agent/web-types，此处仅做 re-export
// 保持 API 兼容（所有外部 import VIDEO_AGENT_IDS 零改动），同时让前端能直接 import 纯常量
import { VIDEO_AGENT_IDS } from "@super-agent/web-types";
export { VIDEO_AGENT_IDS };
export type { VideoAgentId } from "@super-agent/web-types";

// ─── Task ID 常量 ───────────────────────────────────────

export const VIDEO_TASK_IDS = {
  SCRIPT_GENERATION: "t1-script-generation",
  IMAGE_PROMPTS: "t2-image-prompts",
  STORYBOARD_INIT: "t3-storyboard-init",
  AUDIO_SYNTHESIS: "t4-audio-synthesis",
  VISUAL_PRODUCTION: "t5-visual-production",
  FRAME_COMPOSITION: "t6-frame-composition",
  FINAL_MERGE: "t7-final-merge",
} as const;

// ─── 入参类型 ───────────────────────────────────────────

export interface ShortVideoCrewParams {
  /** 用户输入的主题 */
  topic: string;
  /** 可选：每个 Agent 的模型覆盖（providerId + model），null 表示跟随默认 */
  agent_providers?: Record<string, { providerId: string; model: string; baseUrl?: string; apiKey?: string } | null>;
  /** 工作区目录（用于产物存储，默认自动生成） */
  workspace_dir?: string;
}

// ─── AgentConfig 构建 ───────────────────────────────────

/**
 * [CORE-P1-04] 视频 Crew Agent 模型有效性校验
 *
 * 【背景】buildShortVideoAgents() 构造时写死 llmProvider.model = "default"
 *   作为占位符，期望运行期由 agent_providers 或全局默认 provider 覆盖。
 *
 * 【风险】若覆盖链路失效（用户未选模型、未建 provider、applyAllAgentProviders
 *   未命中等），会带着 model="default" 继续调用 LLM，触发
 *   "Connection error / 无效模型" 类失败。
 *
 * 【修复】在视频任务入队后、Agent 注册前强制校验：任意 Agent 的
 *   model 为空或仍为 "default" 时直接 throw，让任务尽早进入 failed
 *   状态并给出可操作的错误提示。
 */
export function validateVideoCrewModel(agents: AgentConfig[]): void {
  for (const agent of agents) {
    const model = agent.llmProvider?.model;
    if (!model || model === "default") {
      throw new Error(
        `视频工作室 Agent "${agent.id}" 未配置有效模型（当前 model="${model ?? ""}"）。` +
          "请在设置页为对应 LLM Provider 选择模型后再启动视频任务。",
      );
    }
  }
}

/** 构建 6 个 Agent 的 AgentConfig（用于临时注册到 AgentManager） */
export function buildShortVideoAgents(): AgentConfig[] {
  const baseConfig = {
    skills: [],
    channels: [],
    memoryEnabled: false,
    maxToolIterations: 10,
    metadata: { crew: "short-video" },
    llmProvider: {
      type: "openai" as const,
      model: "default", // 运行时由 agent_providers 或全局默认覆盖
    },
  };

  return [
    {
      ...baseConfig,
      id: VIDEO_AGENT_IDS.WRITER,
      name: "WriterAgent",
      description: "短视频脚本创作专家",
      role: "writer",
      goal: "基于用户主题生成 6 段短视频脚本",
      backstory: "你是一位经验丰富的内容创作者，擅长将复杂话题转化为引人入胜的短视频脚本。",
      systemPrompt: WRITER_AGENT_PROMPT,
      tools: [], // 纯 LLM 生成
      toolPolicy: "configured-only" as const, // P0-Qwen400-ROOT: 阻止全局工具泄露
    },
    {
      ...baseConfig,
      id: VIDEO_AGENT_IDS.DESIGNER,
      name: "DesignerAgent",
      description: "视觉创意设计师",
      role: "designer",
      goal: "为每段脚本生成英文图像生成提示词",
      backstory: "你是一位专业的视觉设计师，擅长将文字描述转化为精确的图像生成提示词。",
      systemPrompt: DESIGNER_AGENT_PROMPT,
      tools: [], // 纯 LLM 生成
      toolPolicy: "configured-only" as const, // P0-Qwen400-ROOT: 阻止全局工具泄露
    },
    {
      ...baseConfig,
      id: VIDEO_AGENT_IDS.STORYBOARD,
      name: "StoryboardAgent",
      description: "分镜聚合师",
      role: "storyboard",
      goal: "将脚本和图像提示词聚合为完整分镜表",
      backstory: "你是一位专业的分镜师，擅长将各种素材整合为结构清晰的分镜表。",
      systemPrompt: STORYBOARD_AGENT_PROMPT,
      tools: [], // 纯 LLM 生成
      toolPolicy: "configured-only" as const, // P0-Qwen400-ROOT: 阻止全局工具泄露
    },
    {
      ...baseConfig,
      id: VIDEO_AGENT_IDS.VOICE,
      name: "VoiceAgent",
      description: "语音制作人",
      role: "voice",
      goal: "将旁白文字转化为自然流畅的语音音频",
      backstory: "你是一位专业的语音制作人，负责 TTS 语音合成。",
      systemPrompt: VOICE_AGENT_PROMPT,
      tools: ["forge_tts"],
      toolPolicy: "configured-only" as const, // Code Node, 仅需 forge_tts
    },
    {
      ...baseConfig,
      id: VIDEO_AGENT_IDS.VIDEO,
      name: "VideoAgent",
      description: "视频视觉制作人",
      role: "video",
      goal: "基于分镜表生成图像和视频片段",
      backstory: "你是一位专业的视频制作人，擅长使用 AI 工具生成高质量视觉素材。",
      systemPrompt: VIDEO_AGENT_PROMPT,
      tools: ["forge_image", "forge_video", "forge_video_status"],
      toolPolicy: "configured-only" as const, // Code Node, 仅需 forge 系列
      // [P2-1] 6 帧 × (forge_image + forge_video + 至少 1 次 status 轮询) 约 18-24 次调用，
      // 上限给到 30 为重试/降级留出余量。
      maxToolIterations: 30,
    },
    {
      ...baseConfig,
      id: VIDEO_AGENT_IDS.EDITOR,
      name: "EditorAgent",
      description: "视频剪辑师",
      role: "editor",
      goal: "将视觉素材和音频合成为完整短视频",
      backstory: "你是一位专业的剪辑师，擅长精确编排工具调用完成视频合成。",
      systemPrompt: EDITOR_AGENT_PROMPT,
      tools: ["forge_compose_frame", "forge_concat", "forge_add_bgm"],
      toolPolicy: "configured-only" as const, // Code Node, 仅需 compose/concat/bgm
      maxToolIterations: 15, // 6 帧合成 + 拼接 + BGM
    },
  ];
}

// ─── CrewConfig 构建 ────────────────────────────────────

/**
 * 构建 ShortVideoCrew 完整编排配置。
 *
 * @param params - 用户输入参数
 * @returns CrewConfig，可直接传入 CrewExecutor.run()
 */
export function buildShortVideoCrew(params: ShortVideoCrewParams): CrewConfig {
  const { topic, workspace_dir } = params;

  // 注入 topic 到 Task 描述中的占位符
  const topicHint = `\n\n用户主题：${topic}`;
  const wsHint = workspace_dir ? `\n工作区目录：${workspace_dir}` : "";

  const tasks: CrewTask[] = [
    // ─── T1: 脚本生成（Writer, 无依赖） ───
    {
      id: VIDEO_TASK_IDS.SCRIPT_GENERATION,
      agentId: VIDEO_AGENT_IDS.WRITER,
      description:
        `请根据以下主题创作一个 30 秒短视频脚本（6 段 × 5 秒）。` +
        `输出必须严格符合 JSON 格式，包含 title、narration_full 和 scenes 数组。` +
        topicHint,
      expectedOutput: "符合 ScriptSchema 的 JSON（title + narration_full + 6 个 scenes）",
      guardrail: scriptGuardrail,
    },

    // ─── T2: 图生提示词（Designer, 依赖 T1） ───
    {
      id: VIDEO_TASK_IDS.IMAGE_PROMPTS,
      agentId: VIDEO_AGENT_IDS.DESIGNER,
      description:
        `基于上游脚本，为每段旁白创建对应的英文图像生成提示词。` +
        `输出必须包含全局 style_tag 和 6 个 prompts。`,
      expectedOutput: "符合 ImagePromptsSchema 的 JSON（style_tag + 6 个 prompts）",
      context: [VIDEO_TASK_IDS.SCRIPT_GENERATION],
      guardrail: imagePromptsGuardrail,
    },

    // ─── T3: 分镜聚合（Storyboard, 依赖 T1+T2） ───
    {
      id: VIDEO_TASK_IDS.STORYBOARD_INIT,
      agentId: VIDEO_AGENT_IDS.STORYBOARD,
      description:
        `将上游脚本和图生提示词聚合为完整的 6 帧分镜表。` +
        `按 index 一一对应合并 narration_text、image_prompt 和 duration_s。`,
      expectedOutput: "符合 StoryboardSchema 的 JSON（title + style_tag + 6 个 frames）",
      context: [VIDEO_TASK_IDS.SCRIPT_GENERATION, VIDEO_TASK_IDS.IMAGE_PROMPTS],
      guardrail: storyboardGuardrail,
    },

    // ─── T4: 音频合成（Voice, Code Node, 依赖 T1, async=true） ───
    // P0-D：不再依赖 LLM 推理，由 voiceSynthesisHandler 确定性顺序调用 forge_tts
    {
      id: VIDEO_TASK_IDS.AUDIO_SYNTHESIS,
      agentId: VIDEO_AGENT_IDS.VOICE, // 保留 agentId 以兼容前端展示，executor=code 时不触发 LLM
      description:
        `[Code Node] 顺序为 T1 脚本的每段 narration_text 调用 forge_tts 生成 mp3。` +
        `失败单段记 errors 不中断，由 guardrail 判定是否放行。`,
      expectedOutput: "包含 6 段音频路径的 JSON（audio_segments 数组）",
      context: [VIDEO_TASK_IDS.SCRIPT_GENERATION],
      async: true,
      executor: "code",
      codeHandler: voiceSynthesisHandler,
      // [P0-C] 硬校验：audio_path 必须真实存在于磁盘
      guardrail: voiceGuardrail,
    },

    // ─── T5: 视觉制作（Video, Code Node, 依赖 T3, async=true） ───
    // P0-D：MVP 策略只出图不出视频（video_path=null），稳定性优先
    {
      id: VIDEO_TASK_IDS.VISUAL_PRODUCTION,
      agentId: VIDEO_AGENT_IDS.VIDEO,
      description:
        `[Code Node] 顺序为 T3 storyboard 的每帧 image_prompt 调用 forge_image。` +
        `MVP 阶段 video_path 固定为 null，仅产出 6 张图像。` +
        wsHint,
      expectedOutput: "包含 6 帧视觉素材路径的 JSON（frames 数组，含 image_path）",
      context: [VIDEO_TASK_IDS.STORYBOARD_INIT],
      async: true,
      executor: "code",
      codeHandler: visualProductionHandler,
      // [P0-C] 硬校验：image_path 必须真实存在于磁盘
      guardrail: videoGuardrail,
    },

    // ─── T6: 帧合成（Editor, Code Node, 依赖 T4+T5） ───
    // P0-D：按 index 对齐音频 + 图像，顺序调 forge_compose_frame
    {
      id: VIDEO_TASK_IDS.FRAME_COMPOSITION,
      agentId: VIDEO_AGENT_IDS.EDITOR,
      description:
        `[Code Node] 按 index 对齐 T4 音频 + T5 图像，逐帧调 forge_compose_frame 合成视频片段。` +
        `任一帧缺素材跳过记 errors，至少 1 段成功即放行。` +
        wsHint,
      expectedOutput: "包含至少 1 段视频片段路径的 JSON（segments 数组）",
      context: [VIDEO_TASK_IDS.AUDIO_SYNTHESIS, VIDEO_TASK_IDS.VISUAL_PRODUCTION],
      executor: "code",
      codeHandler: frameCompositionHandler,
    },

    // ─── T7: 最终拼接（Editor, Code Node, 依赖 T6） ───
    // P0-D：按 index 升序 concat 所有 segments，不加 BGM（E2E 先求通）
    {
      id: VIDEO_TASK_IDS.FINAL_MERGE,
      agentId: VIDEO_AGENT_IDS.EDITOR,
      description:
        `[Code Node] 收集 T6 segments，按 index 升序调 forge_concat 拼接为最终视频。` +
        `少于 2 段时直接失败。` +
        wsHint,
      expectedOutput: "包含最终视频路径的 JSON（final_video_path + segment_count）",
      context: [VIDEO_TASK_IDS.FRAME_COMPOSITION],
      executor: "code",
      codeHandler: finalMergeHandler,
    },
  ];

  return {
    id: `short-video-crew-${Date.now()}`,
    name: "ShortVideoCrew",
    description: `短视频生成 Crew：${topic}`,
    process: "sequential",
    tasks,
    maxRetries: 2,
    verbose: true,
    // [P0-1] 单任务 timeout 放宽到 60 分钟。
    // 理由：VideoAgent 6 帧 × (forge_image ~90s + 可选 forge_video 60-150s) 叠加 LLM 思考，
    // 实测 17-31 分钟，10 分钟必超时。60 分钟留足缓冲。
    taskTimeoutMs: 3_600_000,
    inputs: {
      topic,
      workspace_dir: workspace_dir || "",
    },
  };
}
