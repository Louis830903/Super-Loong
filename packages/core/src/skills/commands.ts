/**
 * Skill Commands — 斜杠命令激活系统
 *
 * 对标 Hermes skill_commands.py (scan_skill_commands + build_skill_invocation_message)
 *
 * 核心功能:
 * 1. scanSkillCommands(loader) — 扫描所有技能，创建 /skill-name 命令映射
 * 2. buildSkillActivationMessage(entry, content) — 构建激活消息
 * 3. handleSlashCommand(input, commands, loader) — 处理斜杠命令
 */

import pino from "pino";
import type { SkillLoader } from "./loader.js";
import { applyConfigInjection, InMemoryConfigStore, type SkillConfigStore } from "./config-inject.js";

const logger = pino({ name: "skill-commands" });

// ─── 数据结构 ──────────────────────────────────────────────

/** 斜杠命令映射条目 (对标 Hermes SkillCommand) */
export interface SkillCommandEntry {
  /** 命令名称 (含 / 前缀，如 /git-commit) */
  command: string;
  /** 原始技能名 */
  skillName: string;
  /** 技能文件路径 */
  skillPath: string;
  /** 技能描述 */
  description: string;
}

/** 斜杠命令处理结果 */
export interface SlashCommandResult {
  handled: boolean;
  /** 注入到 Agent 对话的激活消息 */
  message?: string;
  /** 匹配的命令条目 */
  entry?: SkillCommandEntry;
  /** 用户额外输入（命令后的文本） */
  userArgs?: string;
}

// ─── 命令扫描 ───────────────────────────────────────────

/**
 * 扫描所有已加载技能，创建斜杠命令映射
 * 对标 Hermes scan_skill_commands()
 *
 * 规则: 技能名 "git-commit" → 命令 "/git-commit"
 */
export function scanSkillCommands(loader: SkillLoader): Map<string, SkillCommandEntry> {
  const commands = new Map<string, SkillCommandEntry>();
  const skills = loader.listSkills();

  for (const skill of skills) {
    if (!skill.enabled) continue;
    const name = skill.frontmatter.name;
    // 标准化命令名: 小写、空格→连字符、去除特殊字符
    const cmdName = `/${name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}`;

    if (cmdName.length <= 1) continue; // 跳过空命令

    commands.set(cmdName, {
      command: cmdName,
      skillName: name,
      skillPath: skill.filePath,
      description: skill.frontmatter.description || "",
    });
  }

  logger.debug({ count: commands.size }, "Skill commands scanned");
  return commands;
}

// ─── 激活消息构建 ───────────────────────────────────────

/**
 * 构建技能激活消息（注入到 Agent 对话中）
 * 对标 Hermes _build_skill_message()
 *
 * 格式:
 * [Skill activated: {name}]
 * {description}
 *
 * {skill content with config injected}
 *
 * [User request: {args}]
 */
export function buildSkillActivationMessage(
  entry: SkillCommandEntry,
  skillContent: string,
  userArgs?: string,
  configValues?: Record<string, string>,
): string {
  const parts: string[] = [];

  // 激活头
  parts.push(`[Skill activated: ${entry.skillName}]`);
  if (entry.description) {
    parts.push(entry.description);
  }
  parts.push("");

  // 技能内容（可能已注入配置）
  let content = skillContent;
  if (configValues && Object.keys(configValues).length > 0) {
    const configLines = Object.entries(configValues).map(([k, v]) => `${k} = ${v}`);
    content = `[Skill config]\n${configLines.join("\n")}\n\n${content}`;
  }
  parts.push(content);

  // 用户额外输入
  if (userArgs && userArgs.trim()) {
    parts.push("");
    parts.push(`[User request: ${userArgs.trim()}]`);
  }

  return parts.join("\n");
}

// ─── 命令检测与处理 ────────────────────────────────────

/**
 * 检查用户输入是否为斜杠命令
 */
export function isSlashCommand(input: string): boolean {
  return input.trim().startsWith("/") && /^\/[a-z][a-z0-9-]*/.test(input.trim());
}

/**
 * 处理斜杠命令
 * 对标 Hermes handle_slash_command()
 *
 * @param input 用户输入 (如 "/git-commit fix the login bug")
 * @param commands 命令映射 (来自 scanSkillCommands)
 * @param loader SkillLoader 实例
 * @param configStore 可选的配置存储
 */
export function handleSlashCommand(
  input: string,
  commands: Map<string, SkillCommandEntry>,
  loader: SkillLoader,
  configStore?: SkillConfigStore,
): SlashCommandResult {
  const trimmed = input.trim();
  if (!isSlashCommand(trimmed)) {
    return { handled: false };
  }

  // 解析命令和参数
  const spaceIdx = trimmed.indexOf(" ");
  const cmdName = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed;
  const userArgs = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : undefined;

  // 精确匹配
  let entry = commands.get(cmdName);

  // 模糊匹配: /git 匹配 /git-commit
  if (!entry) {
    for (const [cmd, e] of commands) {
      if (cmd.startsWith(cmdName)) {
        entry = e;
        break;
      }
    }
  }

  if (!entry) {
    // 列出可用命令
    const available = Array.from(commands.values())
      .slice(0, 20)
      .map((e) => `${e.command}: ${e.description.slice(0, 60)}`)
      .join("\n");
    return {
      handled: true,
      message: `Unknown command: ${cmdName}\n\nAvailable commands:\n${available || "(none)"}`,
    };
  }

  // 加载技能内容
  const skill = loader.findByName(entry.skillName) ?? loader.getSkill(entry.skillName);
  if (!skill) {
    return {
      handled: true,
      message: `Skill "${entry.skillName}" is no longer available.`,
      entry,
    };
  }

  // 配置注入
  const store = configStore ?? new InMemoryConfigStore();
  const injectedContent = applyConfigInjection(skill, store);

  // 构建激活消息
  const message = buildSkillActivationMessage(entry, injectedContent, userArgs);

  logger.info({ command: cmdName, skill: entry.skillName, hasArgs: !!userArgs }, "Slash command activated");

  return {
    handled: true,
    message,
    entry,
    userArgs,
  };
}

/**
 * 格式化可用斜杠命令列表（用于 prompt 注入）
 */
export function formatCommandsList(commands: Map<string, SkillCommandEntry>): string {
  if (commands.size === 0) return "";
  const lines = Array.from(commands.values()).map(
    (e) => `${e.command}: ${e.description.slice(0, 80)}`,
  );
  return `Slash commands:\n${lines.join("\n")}`;
}
