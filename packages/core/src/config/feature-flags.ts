/**
 * v3 修复计划 — Feature Flag 总开关中心
 *
 * 设计原则：
 *   - 单一入口：所有 v3 改造的闸门都从这里读取，便于审计与统一切换
 *   - 默认安全：新增防御层默认 false（不启用），渐进开启避免破坏既有行为
 *   - 测试友好：getter 形式实时读取 process.env，可在测试里直接改 env 切换
 *   - 显式覆盖：支持 SA_VAULT_FAIL_FAST=true|false 类显式覆盖；NODE_ENV 兜底
 *
 * 使用：
 *   import { FeatureFlags } from "../config/feature-flags.js";
 *   if (FeatureFlags.guardedExec) { ... }
 *
 * 闸门清单（v3 计划 §13 双轨切换）：
 *   - guardedExec        Task 2  CommandGuard 接管 exec
 *   - respEnvelope       Task 3  统一响应壳 onSend hook
 *   - internalAuth       Task 4  IM 网关 INTERNAL_TOKEN HMAC 双侧
 *   - vaultFailFast      Task 5.5 凭据保险柜 fail-fast（已在 sandbox.ts 内联实现）
 *   - vaultEnvFallback   Task 4   Vault 引导期 .env 兜底（解死锁）
 *   - zodCodegen         Task 6   zod schema codegen
 *   - otelTracing        Task 7   OTel 全链路追踪
 *   - llmCache           Task 10  LLM 语义缓存
 *   - errorCodeDualEmit  Task 11  错误码 code+message 双发期
 *
 * @why v3 修复体量大，需要双轨切换闸门让生产环境可灰度回滚。
 *      默认全部 OFF，逐项验证后再 ON。
 */

/** 解析 boolean 风格的 env 值，支持 'true'/'1'/'false'/'0'，否则返回 default。 */
function parseBoolEnv(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") return defaultValue;
  const lower = v.toLowerCase().trim();
  if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") return true;
  if (lower === "false" || lower === "0" || lower === "no" || lower === "off") return false;
  return defaultValue;
}

/**
 * v3 不可变闸门集合（FeatureFlags）。
 *
 * @why 集中管理所有灯度开关，避免业务代码中出现零散的 process.env.FEATURE_FLAG_*
 *       调用；同时使闸门名称在 IDE 中可检索、可拼写纠错。
 */
export const FeatureFlags = {
  /**
   * v3 Task 2：CommandGuard 接管 coding-delegator.exec / spawnSync
   *
   * - true：执行前调 CommandGuard.checkCompoundCommand，命中危险模式直接拒绝
   * - false（默认）：仅 logger.warn 告警，不拦截，便于灰度观察
   *
   * @env FEATURE_FLAG_GUARDED_EXEC
   */
  get guardedExec(): boolean {
    return parseBoolEnv("FEATURE_FLAG_GUARDED_EXEC", false);
  },

  /**
   * v3 Task 3：API 全局响应壳 onSend hook（{success, data, error, traceId}）
   *
   * - true：所有 /api/* 响应包裹统一壳
   * - false（默认）：保持现有响应结构
   *
   * @env FEATURE_FLAG_RESP_ENVELOPE
   */
  get respEnvelope(): boolean {
    return parseBoolEnv("FEATURE_FLAG_RESP_ENVELOPE", false);
  },

  /**
   * v3 Task 4：IM 网关 INTERNAL_TOKEN + HMAC 双侧鉴权
   *
   * - true：API ⇄ IM 网关之间所有内部调用必须带 X-Internal-Token + X-Signature
   * - false（默认）：保持现有无鉴权或单 token
   *
   * @env FEATURE_FLAG_INTERNAL_AUTH
   */
  get internalAuth(): boolean {
    return parseBoolEnv("FEATURE_FLAG_INTERNAL_AUTH", false);
  },

  /**
   * v3 Task 4：Vault 引导期允许 .env 兜底读 INTERNAL_TOKEN
   *
   * - true（开发/迁移期）：Vault 未就绪时从 process.env.INTERNAL_TOKEN 读
   * - false（生产推荐）：Vault 必须就绪
   *
   * @env VAULT_ALLOW_ENV_FALLBACK
   */
  get vaultEnvFallback(): boolean {
    return parseBoolEnv("VAULT_ALLOW_ENV_FALLBACK", false);
  },

  /**
   * v3 Task 6：zod schema codegen 接入路由
   *
   * @env FEATURE_FLAG_ZOD_CODEGEN
   */
  get zodCodegen(): boolean {
    return parseBoolEnv("FEATURE_FLAG_ZOD_CODEGEN", false);
  },

  /**
   * v3 Task 7：OpenTelemetry 全链路追踪 5 节点
   *
   * @env FEATURE_FLAG_OTEL_TRACING / ENABLE_TRACING（向后兼容）
   */
  get otelTracing(): boolean {
    return (
      parseBoolEnv("FEATURE_FLAG_OTEL_TRACING", false) ||
      parseBoolEnv("ENABLE_TRACING", false)
    );
  },

  /**
   * v3 Task 10：LLM 语义缓存（仅 temperature ≤ CACHE_MAX_TEMPERATURE）
   *
   * @env FEATURE_FLAG_LLM_CACHE
   */
  get llmCache(): boolean {
    return parseBoolEnv("FEATURE_FLAG_LLM_CACHE", false);
  },

  /**
   * v3 Task 11：错误码 code+message 双发期
   *
   * - true：响应同时带 code 和 message（老前端兼容）
   * - false（sunset 后）：仅保留 code，message 走 i18n
   *
   * @env ERROR_CODE_DUAL_EMIT
   */
  get errorCodeDualEmit(): boolean {
    return parseBoolEnv("ERROR_CODE_DUAL_EMIT", true);
  },

  /**
   * v3 Task 5.5：CredentialVault fail-fast（密钥缺失时启动必败）
   *
   * 注意：此 flag 在 sandbox.ts 内联了同等逻辑（_shouldFailFast），
   * 这里仅作为统一查询入口暴露，不重复实现。
   *
   * @env SA_VAULT_FAIL_FAST（显式覆盖） / NODE_ENV=production（默认开启）
   */
  get vaultFailFast(): boolean {
    const explicit = process.env.SA_VAULT_FAIL_FAST;
    if (explicit !== undefined && explicit !== "") {
      return parseBoolEnv("SA_VAULT_FAIL_FAST", false);
    }
    return process.env.NODE_ENV === "production";
  },
} as const;

// ─── v3 Task 12.5：双轨切换闸门表（破烂日期及处置计划）───────────────

/**
 * 各 Feature Flag 的双轨切换闸门计划。
 *
 * @why v3 多项防御改造都采取"默认 OFF + 渐进 ON"路线，需明示计划何时
 *       破烂旧分支（裸子路径 / 快补 / 各种 "-D" 兑底代码）。
 *       这里集中记录每个 flag 的预期切换日期 + 破烂日期，CI 可据此生成提醒。
 *
 * - rolloutDate：预计默认 ON 的日期（生产全量开启）
 * - sunsetDate：老分支破烂日期（代码库 grep 应为 0 的时点）
 */
export interface FlagSunsetEntry {
  flag: string;
  description: string;
  rolloutDate: string; // YYYY-MM-DD
  sunsetDate: string;  // YYYY-MM-DD
  legacyGrep?: string; // 破烂后在仓库应 grep 不到的模式
}

/**
 * v3 Task 12.5 双轨切换闸门：9 条目 FLAG_SUNSET_PLAN。
 * 每个 v3 落地 flag 必须注册 rolloutDate + sunsetDate，CI 可调
 * findOverdueSunsets() 检测过期未清理的 flag。
 *
 * @why 规范化 feature flag 全生命周期：创建(rolloutDate)→灰度→全量→破烂(sunsetDate)，
 *      避免 flag 永存不亡成为"僵尸代码"。
 */
export const FLAG_SUNSET_PLAN: readonly FlagSunsetEntry[] = [
  {
    flag: "FEATURE_FLAG_RESP_ENVELOPE",
    description: "响应壳 onSend hook：W4 末破烂裸壳路径",
    rolloutDate: "2026-06-30",
    sunsetDate: "2026-08-31",
    legacyGrep: "reply.send\\(\\{(?!\\s*success)", // 裸 reply.send 未走壳
  },
  {
    flag: "FEATURE_FLAG_INTERNAL_AUTH",
    description: "IM 网关 HMAC 双侧：全量开启后破旧 x-api-key 单身份",
    rolloutDate: "2026-06-30",
    sunsetDate: "2026-08-31",
    legacyGrep: "x-api-key",
  },
  {
    flag: "FEATURE_FLAG_GUARDED_EXEC",
    description: "CommandGuard 接管：裸 spawn/exec 快补在未拦截期为警告、到期后抵制",
    rolloutDate: "2026-07-15",
    sunsetDate: "2026-09-30",
    legacyGrep: "child_process\\.(exec|execSync|spawn)\\(",
  },
  {
    flag: "VAULT_ALLOW_ENV_FALLBACK",
    description: "Vault 引导期 .env 兑底：Vault 全量上线后破陷险",
    rolloutDate: "2026-06-30",
    sunsetDate: "2026-09-30",
    legacyGrep: "VAULT_ALLOW_ENV_FALLBACK",
  },
  {
    flag: "AUTH_ENABLED",
    description: "v3 Task 12：生产必须 true，原匿名兑底被fail-fast 拦",
    rolloutDate: "2026-05-31",
    sunsetDate: "2026-06-30",
    legacyGrep: "AUTH_ENABLED",
  },
  {
    flag: "ERROR_CODE_DUAL_EMIT",
    description: "错误码 code+message 双发：v3.0 上线 + 2 版本后砍 message，仅保留 code",
    rolloutDate: "2026-06-30",
    sunsetDate: "2026-10-31",
    legacyGrep: "\"message\":\\s*\"", // 响应壳中裸 message
  },
  {
    flag: "FEATURE_FLAG_ZOD_CODEGEN",
    description: "zod→OpenAPI→前端类型 codegen：编译时漂移检测",
    rolloutDate: "2026-08-15",
    sunsetDate: "2026-10-31",
    legacyGrep: "pnpm gen:types --check",
  },
  {
    flag: "FEATURE_FLAG_OTEL_TRACING",
    description: "OpenTelemetry 全链路追踪 9 节点：错误链路强制 100% 采样",
    rolloutDate: "2026-09-30",
    sunsetDate: "2026-12-31",
    legacyGrep: "ENABLE_TRACING",
  },
  {
    flag: "FEATURE_FLAG_LLM_CACHE",
    description: "LLM 语义缓存：温度 ≤ CACHE_MAX_TEMPERATURE 才生效",
    rolloutDate: "2026-08-31",
    sunsetDate: "2026-11-30",
    legacyGrep: "CACHE_MAX_TEMPERATURE",
  },
] as const;

/**
 * 运行时破烂检测辅助：CI / 启动脚本可调用。
 *
 * @param now 当前日期（测试可注入）
 * @returns 已超过 sunsetDate 但代码仓库可能尚未清理的 flag 列表
 * @why 过期 flag 是技术债：本函数提供自动检测能力，供 CI 或 cron 定期提醒清理。
 */
export function findOverdueSunsets(now: Date = new Date()): FlagSunsetEntry[] {
  const today = now.toISOString().slice(0, 10);
  return FLAG_SUNSET_PLAN.filter((e) => e.sunsetDate < today);
}
