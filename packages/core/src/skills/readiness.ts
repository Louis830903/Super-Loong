/**
 * Skill Readiness — 技能就绪状态机
 *
 * 对标 Hermes SkillReadinessStatus + _capture_required_environment_variables
 *       OpenClaw skills-status.ts (SkillStatusEntry + evaluateEntryRequirementsForCurrentPlatform)
 *
 * 核心功能:
 * 1. evaluateReadiness(skill) — 评估技能是否可用（环境变量/命令/平台）
 * 2. collectMissingSecrets(specs, callback) — 交互式密钥收集
 * 3. selectPreferredInstall(options) — 推荐最优安装方式
 */

import { spawnSync } from "node:child_process";
import pino from "pino";
import type { Skill, SkillFrontmatter } from "../types/index.js";

const logger = pino({ name: "skill-readiness" });

// ─── 数据结构 ──────────────────────────────────────────────

/** 就绪状态枚举 (对标 Hermes SkillReadinessStatus) */
export enum SkillReadinessStatus {
  /** 技能完全可用 */
  AVAILABLE = "available",
  /** 需要配置（缺少环境变量或依赖） */
  SETUP_NEEDED = "setup_needed",
  /** 当前平台不支持 */
  UNSUPPORTED = "unsupported",
}

/** 密钥收集规格 (对标 Hermes setup.collect_secrets) */
export interface SecretSpec {
  envVar: string;
  prompt: string;
  providerUrl?: string;
  secret: boolean;
}

/** 安装选项 (对标 OpenClaw SkillInstallOption) */
export interface SkillInstallOption {
  id: string;
  kind: "brew" | "node" | "go" | "uv" | "download";
  label: string;
  bins: string[];
}

/** 就绪评估结果 (对标 OpenClaw SkillStatusEntry) */
export interface SkillReadinessResult {
  status: SkillReadinessStatus;
  missingEnvVars: string[];
  missingBins: string[];
  missingConfig: string[];
  secretSpecs: SecretSpec[];
  installOptions: SkillInstallOption[];
  setupHelp?: string;
}

// ─── 平台检测 ──────────────────────────────────────────────

/** 当前平台标识 (对标 Hermes skill_matches_platform) */
function getCurrentPlatform(): string {
  switch (process.platform) {
    case "darwin": return "macos";
    case "win32": return "windows";
    case "linux": return "linux";
    default: return process.platform;
  }
}

/** 合法二进制名白名单：仅允许字母、数字、点、下划线、连字符 */
const SAFE_BINARY_NAME = /^[a-zA-Z0-9._-]+$/;

/** 检查二进制命令是否可用 (对标 OpenClaw hasBinary) */
function hasBinary(name: string): boolean {
  // 安全校验：拒绝包含 shell 特殊字符的二进制名，防止命令注入
  if (!SAFE_BINARY_NAME.test(name)) {
    logger.warn({ name }, "Invalid binary name in prerequisites; skipping hasBinary check");
    return false;
  }

  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(cmd, [name], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ─── 核心评估函数 ──────────────────────────────────────────

/**
 * 评估技能就绪状态 — 主入口
 * 对标 Hermes _get_required_environment_variables + OpenClaw buildSkillStatus
 */
export function evaluateReadiness(skill: Skill): SkillReadinessResult {
  const fm = skill.frontmatter;
  const missingEnvVars: string[] = [];
  const missingBins: string[] = [];
  const missingConfig: string[] = [];
  const secretSpecs: SecretSpec[] = [];
  const installOptions: SkillInstallOption[] = [];

  // 1. 平台兼容性检查 (对标 Hermes skill_matches_platform)
  if (fm.platforms && fm.platforms.length > 0) {
    const currentPlatform = getCurrentPlatform();
    const supported = fm.platforms.some(
      (p) => p.toLowerCase() === currentPlatform.toLowerCase()
    );
    if (!supported) {
      return {
        status: SkillReadinessStatus.UNSUPPORTED,
        missingEnvVars: [],
        missingBins: [],
        missingConfig: [],
        secretSpecs: [],
        installOptions: [],
        setupHelp: `This skill only supports: ${fm.platforms.join(", ")}. Current platform: ${currentPlatform}`,
      };
    }
  }

  // 2. 环境变量检查 (对标 Hermes _get_required_environment_variables)
  if (fm.prerequisites?.envVars) {
    for (const envVar of fm.prerequisites.envVars) {
      if (!process.env[envVar]) {
        missingEnvVars.push(envVar);
        // 为缺失的环境变量创建密钥收集规格
        secretSpecs.push({
          envVar,
          prompt: `Please provide ${envVar}`,
          secret: envVar.toLowerCase().includes("key") || envVar.toLowerCase().includes("secret") || envVar.toLowerCase().includes("token"),
        });
      }
    }
  }

  // 3. 命令可用性检查 (对标 OpenClaw requires.bins)
  if (fm.prerequisites?.commands) {
    for (const cmd of fm.prerequisites.commands) {
      if (!hasBinary(cmd)) {
        missingBins.push(cmd);
      }
    }
  }

  // 4. metadata.requires 检查（扩展字段，兼容 OpenClaw requires.bins/env）
  const meta = fm.metadata as Record<string, unknown> | undefined;
  if (meta?.requires && typeof meta.requires === "object") {
    const requires = meta.requires as Record<string, unknown>;

    // 4a. bins 检查
    if (Array.isArray(requires.bins)) {
      for (const bin of requires.bins) {
        if (typeof bin === "string" && !hasBinary(bin) && !missingBins.includes(bin)) {
          missingBins.push(bin);
        }
      }
    }

    // 4b. env 检查
    if (Array.isArray(requires.env)) {
      for (const env of requires.env) {
        if (typeof env === "string" && !process.env[env] && !missingEnvVars.includes(env)) {
          missingEnvVars.push(env);
        }
      }
    }

    // 4c. config 检查
    if (Array.isArray(requires.config)) {
      for (const cfg of requires.config) {
        if (typeof cfg === "string") {
          missingConfig.push(cfg);
        }
      }
    }
  }

  // 5. setup.collect_secrets 检查（兼容 Hermes 格式）
  if (meta?.setup && typeof meta.setup === "object") {
    const setup = meta.setup as Record<string, unknown>;
    if (Array.isArray(setup.collect_secrets)) {
      for (const entry of setup.collect_secrets) {
        if (entry && typeof entry === "object") {
          const s = entry as Record<string, unknown>;
          const envVar = (s.env_var as string) ?? "";
          if (envVar && !process.env[envVar]) {
            if (!missingEnvVars.includes(envVar)) {
              missingEnvVars.push(envVar);
            }
            // 避免重复添加 secretSpec
            if (!secretSpecs.some((sp) => sp.envVar === envVar)) {
              secretSpecs.push({
                envVar,
                prompt: (s.prompt as string) ?? `Please provide ${envVar}`,
                providerUrl: s.provider_url as string | undefined,
                secret: (s.secret as boolean) ?? true,
              });
            }
          }
        }
      }
    }
    // setup.help 文本
    if (typeof setup.help === "string") {
      // 会在下面返回
    }
  }

  // 6. install 选项解析（兼容 OpenClaw metadata.install）
  if (meta?.install && Array.isArray(meta.install)) {
    for (const [idx, spec] of (meta.install as Array<Record<string, unknown>>).entries()) {
      if (spec && typeof spec === "object" && typeof spec.kind === "string") {
        installOptions.push({
          id: (spec.id as string) ?? `${spec.kind}-${idx}`,
          kind: spec.kind as SkillInstallOption["kind"],
          label: (spec.label as string) ?? `Install via ${spec.kind}`,
          bins: Array.isArray(spec.bins) ? spec.bins as string[] : [],
        });
      }
    }
  }

  // 7. 计算最终状态
  const hasMissing = missingEnvVars.length > 0 || missingBins.length > 0;
  const status = hasMissing ? SkillReadinessStatus.SETUP_NEEDED : SkillReadinessStatus.AVAILABLE;

  // 8. 构建 setupHelp
  let setupHelp: string | undefined;
  const setupMeta = (meta?.setup as Record<string, unknown> | undefined);
  if (setupMeta && typeof setupMeta?.help === "string") {
    setupHelp = setupMeta.help as string;
  } else if (hasMissing) {
    const parts: string[] = [];
    if (missingEnvVars.length > 0) {
      parts.push(`Missing environment variables: ${missingEnvVars.join(", ")}`);
    }
    if (missingBins.length > 0) {
      parts.push(`Missing binaries: ${missingBins.join(", ")}`);
    }
    setupHelp = parts.join(". ");
  }

  return {
    status,
    missingEnvVars,
    missingBins,
    missingConfig,
    secretSpecs,
    installOptions,
    setupHelp,
  };
}

/**
 * 交互式收集缺失的密钥/环境变量
 * 对标 Hermes _capture_required_environment_variables
 *
 * @param specs 需要收集的密钥规格
 * @param callback 对每个密钥的收集回调（返回用户提供的值或 null 表示跳过）
 */
export async function collectMissingSecrets(
  specs: SecretSpec[],
  callback: (spec: SecretSpec) => Promise<string | null>,
): Promise<Record<string, string>> {
  const collected: Record<string, string> = {};

  for (const spec of specs) {
    // 已经存在于环境中的跳过
    if (process.env[spec.envVar]) continue;

    const value = await callback(spec);
    if (value) {
      collected[spec.envVar] = value;
      // 临时设置到 process.env 以便后续检查
      process.env[spec.envVar] = value;
    }
  }

  return collected;
}

/**
 * 推荐最优安装方式
 * 对标 OpenClaw selectPreferredInstallSpec
 */
export function selectPreferredInstall(
  options: SkillInstallOption[],
): SkillInstallOption | undefined {
  if (options.length === 0) return undefined;

  // 优先级: uv > node > brew(可用时) > go > download
  const brewAvailable = hasBinary("brew");

  const priority: SkillInstallOption["kind"][] = brewAvailable
    ? ["uv", "node", "brew", "go", "download"]
    : ["uv", "node", "go", "download", "brew"];

  for (const kind of priority) {
    const match = options.find((o) => o.kind === kind);
    if (match) return match;
  }

  return options[0];
}

/**
 * 生成就绪状态的人类可读文本（用于 skill_read 工具返回）
 */
export function formatReadinessMessage(result: SkillReadinessResult): string {
  if (result.status === SkillReadinessStatus.AVAILABLE) {
    return "";
  }

  const parts: string[] = [];

  if (result.status === SkillReadinessStatus.UNSUPPORTED) {
    parts.push(`⚠ UNSUPPORTED: ${result.setupHelp ?? "Platform not supported"}`);
    return parts.join("\n");
  }

  parts.push("⚠ SETUP NEEDED:");
  if (result.missingEnvVars.length > 0) {
    parts.push(`  Missing env vars: ${result.missingEnvVars.join(", ")}`);
  }
  if (result.missingBins.length > 0) {
    parts.push(`  Missing commands: ${result.missingBins.join(", ")}`);
  }
  if (result.secretSpecs.length > 0) {
    for (const spec of result.secretSpecs) {
      let line = `  → ${spec.envVar}: ${spec.prompt}`;
      if (spec.providerUrl) {
        line += ` (get from: ${spec.providerUrl})`;
      }
      parts.push(line);
    }
  }
  if (result.installOptions.length > 0) {
    const preferred = selectPreferredInstall(result.installOptions);
    if (preferred) {
      parts.push(`  Recommended install: ${preferred.label} (${preferred.kind})`);
    }
  }
  if (result.setupHelp) {
    parts.push(`  Help: ${result.setupHelp}`);
  }

  return parts.join("\n");
}
