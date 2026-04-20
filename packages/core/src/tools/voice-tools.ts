/**
 * Voice Tools — 阿里云语音工具 × 3（tts_speak / stt_transcribe / voice_status）。
 *
 * 复用 AliyunVoiceProvider，通过 ConfigStore 优先级链路读取配置。
 * 本地声卡播放：Windows PowerShell / macOS afplay / Linux paplay。
 */

import { z } from "zod";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import pino from "pino";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import { AliyunVoiceProvider } from "../voice/aliyun.js";
import { getConfigStore } from "./config-store.js";

const logger = pino({ name: "voice-tools" });

// ── 发音人预设列表 ──────────────────────────────────

const VOICES = [
  { id: "xiaoyun", name: "小云", type: "标准女声" },
  { id: "xiaogang", name: "小刚", type: "标准男声" },
  { id: "ruoxi", name: "若兮", type: "温柔女声" },
  { id: "siqi", name: "思琪", type: "温柔女声" },
  { id: "aijia", name: "艾佳", type: "标准女声" },
  { id: "aicheng", name: "艾诚", type: "标准男声" },
  { id: "aida", name: "艾达", type: "标准男声" },
  { id: "ninger", name: "宁儿", type: "标准女声" },
  { id: "xiaobei", name: "小北", type: "萝莉女声" },
  { id: "yina", name: "伊娜", type: "浙普女声" },
];

// ── 配置读取（ConfigStore → 环境变量 → 空） ──

function getVoiceConfig(): { accessKeyId: string; accessKeySecret: string; appKey: string } {
  const store = getConfigStore();
  return {
    accessKeyId: store.get("aliyun_voice", "access_key_id") || process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || "",
    accessKeySecret: store.get("aliyun_voice", "access_key_secret") || process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || "",
    appKey: store.get("aliyun_voice", "appkey") || process.env.ALIBABA_CLOUD_APPKEY || "",
  };
}

/** 获取 AliyunVoiceProvider 实例（每次读取最新配置） */
function getProvider(): AliyunVoiceProvider | null {
  const cfg = getVoiceConfig();
  if (!cfg.accessKeyId || !cfg.accessKeySecret || !cfg.appKey) return null;
  return new AliyunVoiceProvider(cfg);
}

/** 未配置时返回的提示信息 */
function notConfiguredResult(): ToolResult {
  return {
    success: false,
    output:
      "❌ 阿里云语音服务未配置。请提供以下信息：\n\n" +
      "1. AccessKey ID — 阿里云 RAM 用户的 AccessKey\n" +
      "2. AccessKey Secret — 对应的 Secret\n" +
      "3. AppKey — 在阿里云智能语音交互控制台创建项目获取\n\n" +
      "你可以直接告诉我这些信息，我会自动保存配置。\n" +
      "或访问 https://nls-portal.console.aliyun.com/ 获取。",
    error: "not_configured",
  };
}

// ── 本地声卡播放 ──────────────────────────────────

function playLocalAudio(filePath: string): { success: boolean; message: string } {
  const platform = process.platform;
  const ext = path.extname(filePath).toLowerCase();

  try {
    if (platform === "win32") {
      if (ext === ".wav") {
        // PowerShell SoundPlayer 播放 WAV（参数数组形式避免命令注入）
        const script = `$p = New-Object System.Media.SoundPlayer '${filePath.replace(/'/g, "''")}'; $p.PlaySync()`;
        const res = spawnSync("powershell", ["-NoProfile", "-Command", script], { timeout: 60000, stdio: "ignore" });
        if (res.error) throw res.error;
      } else {
        // PowerShell MediaPlayer 播放 MP3 等格式
        const script = `$mp = New-Object System.Windows.Media.MediaPlayer; $mp.Open([Uri]'${filePath.replace(/'/g, "''")}'); $mp.Play(); Start-Sleep -Seconds 1; while($mp.NaturalDuration.HasTimeSpan -and $mp.Position -lt $mp.NaturalDuration.TimeSpan){Start-Sleep -Milliseconds 200}; $mp.Close()`;
        const res = spawnSync("powershell", ["-NoProfile", "-Command", script], { timeout: 60000, stdio: "ignore" });
        if (res.error) throw res.error;
      }
    } else if (platform === "darwin") {
      const res = spawnSync("afplay", [filePath], { timeout: 60000, stdio: "ignore" });
      if (res.error) throw res.error;
    } else {
      // Linux: 依次尝试 paplay → aplay → ffplay
      const players: Array<[string, string[]]> = [
        ["paplay", [filePath]],
        ["aplay", [filePath]],
        ["ffplay", ["-autoexit", "-nodisp", filePath]],
      ];
      let played = false;
      for (const [cmd, args] of players) {
        const res = spawnSync(cmd, args, { timeout: 60000, stdio: "ignore" });
        if (!res.error && res.status === 0) {
          played = true;
          break;
        }
      }
      if (!played) throw new Error("未找到可用的音频播放器");
    }
    return { success: true, message: "播放完成" };
  } catch (err: any) {
    logger.warn({ error: err.message }, "本地声卡播放失败");
    return { success: false, message: `播放失败：${err.message}。音频文件已保存，你可以手动打开播放。` };
  }
}

// ── 工具定义 ─────────────────────────────────────

/** tts_speak — 文字转语音 */
const ttsSpeakTool: ToolDefinition = {
  name: "tts_speak",
  description:
    "文字转语音：将文字合成为音频文件，可选通过本地声卡播放。" +
    "支持多种发音人（xiaoyun/xiaogang/ruoxi 等），输出 mp3/wav/pcm 格式。",
  parameters: z.object({
    text: z.string().describe("要合成的文字内容"),
    voice: z.string().default("xiaoyun").describe("发音人 ID，如 xiaoyun/xiaogang/ruoxi"),
    playLocal: z.boolean().default(false).describe("是否通过本地声卡播放"),
    savePath: z.string().optional().describe("保存路径（默认临时目录）"),
    format: z.enum(["mp3", "wav", "pcm"]).default("mp3").describe("输出格式"),
    speed: z.number().min(-500).max(500).default(0).describe("语速 (-500~500)"),
    volume: z.number().min(0).max(100).default(50).describe("音量 (0~100)"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { text, voice, playLocal, savePath, format, speed, volume } = params as {
      text: string; voice: string; playLocal: boolean; savePath?: string;
      format: "mp3" | "wav" | "pcm"; speed: number; volume: number;
    };

    const provider = getProvider();
    if (!provider) return notConfiguredResult();

    try {
      const audioBuffer = await provider.synthesize(text, { voice, format, speed, volume });
      // 保存文件
      const outPath = savePath || path.join(os.tmpdir(), `sa_tts_${Date.now()}.${format}`);
      const dir = path.dirname(outPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outPath, audioBuffer);

      let playMsg = "";
      if (playLocal) {
        const result = playLocalAudio(outPath);
        playMsg = result.success ? " 🔊 已通过声卡播放。" : ` ⚠️ ${result.message}`;
      }

      return {
        success: true,
        output: `✅ 语音合成完成（${voice}，${format}，${audioBuffer.length} 字节）\n文件：${outPath}${playMsg}`,
        data: { filePath: outPath, size: audioBuffer.length, voice, format },
      };
    } catch (err: any) {
      return { success: false, output: `语音合成失败：${err.message}`, error: err.message };
    }
  },
};

/** stt_transcribe — 音频转文字 */
const sttTranscribeTool: ToolDefinition = {
  name: "stt_transcribe",
  description: "音频转文字：将音频文件转录为文字。支持 wav/mp3/pcm 格式，默认中文识别。",
  parameters: z.object({
    audioPath: z.string().describe("音频文件路径"),
    language: z.string().default("zh-CN").describe("识别语言（默认 zh-CN）"),
    format: z.enum(["wav", "mp3", "pcm"]).optional().describe("音频格式（自动检测）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { audioPath, language, format } = params as {
      audioPath: string; language: string; format?: string;
    };

    const provider = getProvider();
    if (!provider) return notConfiguredResult();

    // 校验文件
    if (!fs.existsSync(audioPath)) {
      return { success: false, output: `文件不存在：${audioPath}`, error: "file_not_found" };
    }

    try {
      const audioBuffer = fs.readFileSync(audioPath);
      const audioFormat = format || path.extname(audioPath).replace(".", "") || "wav";
      const result = await provider.transcribe(audioBuffer, { language, format: audioFormat });

      return {
        success: true,
        output: `✅ 语音识别完成：\n\n"${result.text}"`,
        data: { text: result.text, language: result.language },
      };
    } catch (err: any) {
      return { success: false, output: `语音识别失败：${err.message}`, error: err.message };
    }
  },
};

/** voice_status — 查看语音服务状态 */
const voiceStatusTool: ToolDefinition = {
  name: "voice_status",
  description: "查看阿里云语音服务的配置状态、可用发音人列表。",
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const cfg = getVoiceConfig();
    const configured = !!(cfg.accessKeyId && cfg.accessKeySecret && cfg.appKey);

    const voiceList = VOICES.map(v => `  ${v.id} — ${v.name}（${v.type}）`).join("\n");
    const statusIcon = configured ? "✅ 已配置" : "⚠️ 未配置";

    const lines = [
      `阿里云语音服务状态：${statusIcon}`,
      "",
      configured
        ? `AccessKey ID: ${cfg.accessKeyId.slice(0, 4)}***\nAppKey: ${cfg.appKey}`
        : "请提供 AccessKey ID、Secret 和 AppKey 以启用语音功能。\n获取地址：https://nls-portal.console.aliyun.com/",
      "",
      "可用发音人：",
      voiceList,
    ];

    return {
      success: true,
      output: lines.join("\n"),
      data: { configured, voices: VOICES },
    };
  },
};

export const voiceTools: ToolDefinition[] = [ttsSpeakTool, sttTranscribeTool, voiceStatusTool];
