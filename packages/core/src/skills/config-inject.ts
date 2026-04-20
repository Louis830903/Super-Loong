/**
 * Skill Config Injection — 技能配置变量注入
 *
 * 对标 Hermes _inject_skill_config() + resolve_skill_config_values() + extract_skill_config_vars()
 *
 * 核心流程:
 * 1. 技能在 frontmatter 声明配置变量: metadata.config: [{key, description, default, prompt}]
 * 2. 用户在配置文件中设置值: skills.config.{skill}.{key} = value
 * 3. Agent 加载技能时自动注入: [Skill config: key=value]
 */

import pino from "pino";
import type { SkillFrontmatter, Skill } from "../types/index.js";
import type { SkillLoader } from "./loader.js";

const logger = pino({ name: "skill-config-inject" });

// ─── 数据结构 ──────────────────────────────────────────────

/** 配置变量规格（对标 Hermes SkillConfigVar） */
export interface ConfigVarSpec {
  key: string;
  description: string;
  defaultValue?: string;
  prompt?: string;
  required?: boolean;
}

/** 用户级配置存储接口 */
export interface SkillConfigStore {
  /** 获取配置值，key 格式: "skills.config.{skillName}.{varKey}" */
  get(key: string): string | undefined;
  /** 获取所有技能配置 */
  getAll(): Record<string, string>;
}

/** 简单内存配置存储（默认实现） */
export class InMemoryConfigStore implements SkillConfigStore {
  private values: Map<string, string> = new Map();

  constructor(initial?: Record<string, string>) {
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        this.values.set(k, v);
      }
    }
  }

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  getAll(): Record<string, string> {
    return Object.fromEntries(this.values);
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

// ─── 配置变量提取 ────────────────────────────────────────

/**
 * 从 frontmatter 提取配置变量声明
 * 对标 Hermes extract_skill_config_vars()
 *
 * 支持两种格式:
 * 1. metadata.config: [{key, description, default, prompt}]  (Super Agent 原生)
 * 2. metadata.hermes.config: [{key, description, default}]   (Hermes 兼容)
 */
export function extractConfigVars(frontmatter: SkillFrontmatter): ConfigVarSpec[] {
  const specs: ConfigVarSpec[] = [];
  const meta = frontmatter.metadata as Record<string, unknown> | undefined;
  if (!meta) return specs;

  // 格式 1: metadata.config
  if (Array.isArray(meta.config)) {
    for (const entry of meta.config) {
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        if (typeof e.key === "string") {
          specs.push({
            key: e.key,
            description: (e.description as string) ?? "",
            defaultValue: e.default != null ? String(e.default) : undefined,
            prompt: (e.prompt as string) ?? undefined,
            required: (e.required as boolean) ?? false,
          });
        }
      }
    }
  }

  // 格式 2: metadata.hermes.config
  const hermes = meta.hermes as Record<string, unknown> | undefined;
  if (hermes && Array.isArray(hermes.config)) {
    for (const entry of hermes.config) {
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        if (typeof e.key === "string" && !specs.some((s) => s.key === e.key)) {
          specs.push({
            key: e.key,
            description: (e.description as string) ?? "",
            defaultValue: e.default != null ? String(e.default) : undefined,
            prompt: (e.prompt as string) ?? undefined,
          });
        }
      }
    }
  }

  return specs;
}

// ─── 配置值解析 ─────────────────────────────────────────

/**
 * 从用户配置解析技能的配置值
 * 对标 Hermes resolve_skill_config_values()
 *
 * @param skillName 技能名称
 * @param specs 配置变量规格
 * @param store 用户配置存储
 * @returns 解析后的 key → value 映射
 */
export function resolveConfigValues(
  skillName: string,
  specs: ConfigVarSpec[],
  store: SkillConfigStore,
): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const spec of specs) {
    // 查找顺序: skills.config.{skillName}.{key} → 环境变量 → default
    const configKey = `skills.config.${skillName}.${spec.key}`;
    const fromStore = store.get(configKey);
    const fromEnv = process.env[`SKILL_CONFIG_${skillName.toUpperCase().replace(/-/g, "_")}_${spec.key.toUpperCase().replace(/\./g, "_")}`];

    if (fromStore != null) {
      resolved[spec.key] = fromStore;
    } else if (fromEnv != null) {
      resolved[spec.key] = fromEnv;
    } else if (spec.defaultValue != null) {
      resolved[spec.key] = spec.defaultValue;
    }
    // 缺失且无默认值时跳过
  }

  return resolved;
}

// ─── 配置注入 ───────────────────────────────────────────

/**
 * 注入配置到技能内容
 * 对标 Hermes _inject_skill_config()
 *
 * 在技能内容前添加配置块:
 * ```
 * [Skill config]
 * wiki.path = ~/wiki
 * api.base_url = https://example.com
 * ```
 */
export function injectSkillConfig(
  skillContent: string,
  resolvedValues: Record<string, string>,
): string {
  const entries = Object.entries(resolvedValues);
  if (entries.length === 0) return skillContent;

  const configLines = entries.map(([key, value]) => `${key} = ${value}`);
  const configBlock = `[Skill config]\n${configLines.join("\n")}\n`;

  return `${configBlock}\n${skillContent}`;
}

// ─── 完整注入流程 ────────────────────────────────────────

/**
 * 对技能执行完整的配置注入流程
 *
 * 1. 提取配置变量声明
 * 2. 解析配置值
 * 3. 注入到技能内容
 *
 * @returns 注入后的内容（如果没有配置变量则返回原内容）
 */
export function applyConfigInjection(
  skill: Skill,
  store: SkillConfigStore,
): string {
  const specs = extractConfigVars(skill.frontmatter);
  if (specs.length === 0) return skill.content;

  const values = resolveConfigValues(skill.frontmatter.name, specs, store);
  if (Object.keys(values).length === 0) {
    // 有配置变量但都没解析到值——附加提示
    const missing = specs.filter((s) => s.required).map((s) => s.key);
    if (missing.length > 0) {
      logger.debug({ skill: skill.frontmatter.name, missing }, "Missing required config vars");
    }
    return skill.content;
  }

  return injectSkillConfig(skill.content, values);
}

// ─── 全局发现 ───────────────────────────────────────────

/**
 * 发现所有已加载技能的配置变量
 * 对标 Hermes discover_all_skill_config_vars()
 *
 * @returns Map<skillName, ConfigVarSpec[]>
 */
export function discoverAllConfigVars(
  loader: SkillLoader,
): Map<string, ConfigVarSpec[]> {
  const result = new Map<string, ConfigVarSpec[]>();
  for (const skill of loader.listSkills()) {
    const specs = extractConfigVars(skill.frontmatter);
    if (specs.length > 0) {
      result.set(skill.frontmatter.name, specs);
    }
  }
  return result;
}

/**
 * 格式化缺失配置的提示信息
 */
export function formatMissingConfigMessage(
  skillName: string,
  specs: ConfigVarSpec[],
  store: SkillConfigStore,
): string {
  const values = resolveConfigValues(skillName, specs, store);
  const missing = specs.filter((s) => !(s.key in values));
  if (missing.length === 0) return "";

  const lines = missing.map((s) => {
    let line = `  - ${s.key}: ${s.description}`;
    if (s.defaultValue) line += ` (default: ${s.defaultValue})`;
    if (s.required) line += " [REQUIRED]";
    return line;
  });

  return `Missing skill config:\n${lines.join("\n")}\nSet via: skills.config.${skillName}.{key} = value`;
}

// ─── ConfigStore 适配器 ───────────────────────────────

/**
 * 桥接服务配置存储（ConfigStore / SQLite）到技能配置接口
 * 使用 serviceId = "skills" 进行所有技能配置的读写
 *
 * key 映射:
 *   SkillConfigStore.get("skills.config.git-commit.api_key")
 *   → realStore.get("skills", "config.git-commit.api_key")
 */
export class ConfigStoreAdapter implements SkillConfigStore {
  private realStore: { get(serviceId: string, key: string): string | null; getAll(serviceId: string): Record<string, string> };

  constructor(realStore: { get(serviceId: string, key: string): string | null; getAll(serviceId: string): Record<string, string> }) {
    this.realStore = realStore;
  }

  get(key: string): string | undefined {
    // 移除 "skills." 前缀，传入实际 key
    const stripped = key.startsWith("skills.") ? key.slice(7) : key;
    const value = this.realStore.get("skills", stripped);
    return value ?? undefined;
  }

  getAll(): Record<string, string> {
    return this.realStore.getAll("skills");
  }
}
