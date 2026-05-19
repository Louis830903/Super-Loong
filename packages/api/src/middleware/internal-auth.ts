/**
 * v3 Task 4：IM 网关 INTERNAL_TOKEN + HMAC 双侧鉴权 — API 侧实现
 *
 * 设计目标
 *   1. **不可重放**：每次请求都带 X-Timestamp（ms），网关侧验证 5min 窗口。
 *   2. **不可伪造**：HMAC-SHA256 签名整段 method+path+timestamp+sha256(body)，
 *      共享密钥 INTERNAL_HMAC_SECRET 永不出现在请求里，常量时间比对。
 *   3. **可灰度**：FEATURE_FLAG_INTERNAL_AUTH=true 才强制；false 时仍带旧
 *      `x-api-key` 兼容头，保证既有部署不被破坏。
 *   4. **凭据来源回退链**：CredentialVault → process.env（仅 vaultEnvFallback=true
 *      允许）→ 启动失败。生产环境推荐 Vault 已就绪后关闭 fallback。
 *
 * Canonical 签名串（与 services/im-gateway/server.py 保持完全一致）
 *   `${METHOD_UPPER}\n${PATH}\n${TIMESTAMP_MS}\n${SHA256_HEX(BODY_UTF8)}`
 *   - PATH 不含 query string（query 单独不进签名，以减少 URL 编码歧义）；
 *     如未来要把 query 纳入，需双侧同步升级 v2。
 *   - GET / 空 body 时 SHA256_HEX(BODY) 取空串的 sha256（e3b0c44…）。
 *
 * 单元测试覆盖矩阵见 packages/api/src/__tests__/internal-auth.test.ts
 *
 * @why 与 Python 侧 hmac.compare_digest 保持位级一致 + 时间戳防重放，是 v3
 *       「平台层」最小可用闸门；后续 Task 12 鉴权可在此基础上扩 mTLS。
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CredentialVault } from "@super-agent/core";

/** 5 分钟时间戳容忍窗口（毫秒） */
export const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * 解析布尔环境变量（与 core/feature-flags.ts 行为完全一致）。
 *
 * @why 不直接从 @super-agent/core 跨包导入 FeatureFlags，避免要求 core 包必须
 *       重新 build dist；此处与 v3 Task 3 response-envelope.ts 同一处理思路。
 */
function parseBoolEnv(name: string): boolean {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") return false;
  const lower = v.toLowerCase().trim();
  return lower === "true" || lower === "1" || lower === "yes" || lower === "on";
}

function isInternalAuthEnabled(): boolean {
  return parseBoolEnv("FEATURE_FLAG_INTERNAL_AUTH");
}

function isVaultEnvFallbackEnabled(): boolean {
  return parseBoolEnv("VAULT_ALLOW_ENV_FALLBACK");
}

/**
 * 启动期一次性加载的凭据快照。
 * 模块级缓存避免每个请求都重读 env / Vault；
 * 通过 reloadInternalCredentialsForTest() 在单测中刷新。
 */
let cached: { token: string; secret: string; loaded: boolean } | null = null;

// ─── v3 Task 4 B4：CredentialVault 注入点 ──────────────────
// 由 API 启动侧在 SecurityManager 创建后调用，注入 vault 实例
let _vault: CredentialVault | null = null;

/**
 * 注入 CredentialVault 实例。
 *
 * @why 避免 internal-auth 直接 import context.ts（可能造成循环依赖），
 *      采用依赖注入模式：API 启动侧在 SecurityManager 就绪后调用此函数。
 *
 * 调用位置：packages/api/src/index.ts（或 context.ts）
 *   在 new SecurityManager() 之后：
 *   setCredentialVault(securityManager.vault);
 */
export function setCredentialVault(vault: CredentialVault): void {
  _vault = vault;
  // 注入后清空缓存，让下次 loadInternalCredentials 重读（此次从 Vault）
  cached = null;
}

/**
 * 仅供测试：清空缓存以重读 env。
 * @why 测试中需要切换 INTERNAL_TOKEN / HMAC_SECRET 时，通过此函数重置缓存避免使用旧值。
 */
export function reloadInternalCredentialsForTest(): void {
  cached = null;
}

/**
 * 从 process.env 加载凭据（Vault 集成将作为后续 hook 注入）。
 *
 * 加载策略：
 *   - flag off: 不要求 token/secret 存在，全部空串，调用方应回退旧 api-key 路径。
 *   - flag on + vaultEnvFallback=true: 允许 .env 兜底；空值视为开发期未配置，warn 但不 throw。
 *   - flag on + vaultEnvFallback=false: 必须两个都有；缺失即 throw（生产 fail-fast）。
 *
 * @why 让"未启用 flag"的旧部署 0 改动可上线；启用后再分阶段过 Vault。
 */
function loadInternalCredentials(): { token: string; secret: string } {
  if (cached?.loaded) return { token: cached.token, secret: cached.secret };

  const flagOn = isInternalAuthEnabled();
  const allowEnvFallback = isVaultEnvFallbackEnabled();

  // ─── 优先级 1：CredentialVault（加密存储）───
  // v3 Task 4 B4：从 Vault 读取 INTERNAL_TOKEN / INTERNAL_HMAC_SECRET
  const vaultToken = _vault?.retrieve("INTERNAL_TOKEN") ?? null;
  const vaultSecret = _vault?.retrieve("INTERNAL_HMAC_SECRET") ?? null;

  let token = vaultToken ?? "";
  let secret = vaultSecret ?? "";
  const vaultHadCredentials = token !== "" && secret !== "";

  // ─── 优先级 2：process.env 兜底（仅 VAULT_ALLOW_ENV_FALLBACK=true 且 Vault 未就绪）───
  // @why 灰度期 Vault 可能未部署，.env 仍作为兼容回退路径
  if (!vaultHadCredentials && allowEnvFallback) {
    token = process.env.INTERNAL_TOKEN ?? "";
    secret = process.env.INTERNAL_HMAC_SECRET ?? "";
  }

  // ─── 启动前 fail-fast 检查 ───
  // flag 开启 + 不允许 env 兜底 + 凭据缺失 → 直接抛错，阻止服务启动
  if (flagOn && !allowEnvFallback && (!token || !secret)) {
    const source = _vault ? "Vault" : "prEnv";
    throw new Error(
      `[internal-auth] FEATURE_FLAG_INTERNAL_AUTH=true 但凭据缺失（来源：${source}）。` +
        "请通过 Vault 或 .env 设置 INTERNAL_TOKEN + INTERNAL_HMAC_SECRET。" +
        "生成方式：node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }

  cached = { token, secret, loaded: true };
  return { token, secret };
}

/**
 * 计算 body 的 sha256 hex；空 body 用空串占位以保证双侧一致。
 *
 * @why JSON.stringify 在 undefined / 字段顺序上有差异，因此这里只接受
 *       已序列化的字符串/Buffer，调用方负责保持 stringify 一致性。
 */
export function sha256Hex(body: string | Buffer | undefined | null): string {
  const buf = body == null ? Buffer.alloc(0) : (typeof body === "string" ? Buffer.from(body, "utf8") : body);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 构造 Canonical 签名串（双侧严格一致）。
 *
 * @param method HTTP 方法（自动 uppercase）
 * @param path URL path，不含 query
 * @param timestampMs 毫秒时间戳
 * @param bodyHex 已计算好的 sha256 hex
 *
 * @why TS / Python 两侧必须位级一致，只要 path/method/ts/bodyHex 中任一不同
 *       签名会变；抽出独立函数便于在测试中验证双端一致性。
 */
export function buildCanonicalString(
  method: string,
  path: string,
  timestampMs: number | string,
  bodyHex: string,
): string {
  return `${String(method).toUpperCase()}\n${path}\n${timestampMs}\n${bodyHex}`;
}

/**
 * 用 HMAC-SHA256 计算签名 hex。
 *
 * @why HMAC 对于双向对称密钥场景足够；不选 RSA/ECDSA 是为了避免密钥对管理负担，
 *       且调用路径仅限内部 API ↔ IM 网关。
 */
export function hmacSign(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

/**
 * 常量时间比对两段 hex 签名（避免时序攻击）。
 * 长度不同时直接返回 false，timingSafeEqual 要求长度一致。
 *
 * @why 默认 === 会在不同位置提前 short-circuit，泄露字节位置信息。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * 给一次出站请求生成签名 headers。
 *
 * @param method HTTP 方法
 * @param path URL path（如 /api/gateway/health），不含 query string
 * @param body 已序列化的请求体；GET / 无 body 时传 undefined 即可
 * @returns 应合并到 fetch headers 的对象；flag off 时只返回兼容头
 *
 * @example
 *   const body = JSON.stringify(payload);
 *   const headers = signedGatewayHeaders("POST", "/internal/deliver", body);
 *   await fetch(url, { method: "POST", headers, body });
 *
 * @why 主出站鉴权入口；flag on 采用 token+ts+sig 三件套，flag off 回退旧
 *       x-api-key；同一函数统一两条路径避免调用方重复实现。
 */
export function signedGatewayHeaders(
  method: string,
  path: string,
  body?: string | Buffer | null,
): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  // flag off：保留旧 x-api-key 路径，调用方原有 IM_GATEWAY_API_KEY 行为不变
  if (!isInternalAuthEnabled()) {
    const apiKey = process.env.IM_GATEWAY_API_KEY ?? "";
    if (apiKey) headers["x-api-key"] = apiKey;
    return headers;
  }

  const { token, secret } = loadInternalCredentials();
  // flag on 但凭据为空（仅 fallback 允许的开发期）→ 不签名只发 token，让网关
  // 决定是否拒绝；这样开发期能看到 401，比悄悄放行更安全。
  if (!token || !secret) {
    if (token) headers["x-internal-token"] = token;
    return headers;
  }

  const ts = Date.now().toString();
  const bodyHex = sha256Hex(body ?? "");
  const canonical = buildCanonicalString(method, path, ts, bodyHex);
  const sig = hmacSign(secret, canonical);

  headers["x-internal-token"] = token;
  headers["x-timestamp"] = ts;
  headers["x-signature"] = sig;
  // 兼容头：升级期同时发，Python 侧两条路径任一匹配即放行；
  // 切换完成后可逐步下线。
  const apiKey = process.env.IM_GATEWAY_API_KEY ?? "";
  if (apiKey) headers["x-api-key"] = apiKey;
  return headers;
}

/**
 * 验证一份入站请求签名（API 侧很少做入站验签，主要供测试与未来 webhook 反向调用）。
 *
 * @returns { valid: boolean; reason?: string }
 *   reason ∈ "stale" | "skew" | "bad_sig" | "missing_secret" | "missing_headers"
 *
 * @why 实现与 Python 网关 _verify_internal_signature 严格对齐，可被测试直接验证
 *       算法一致性；同时为未来双向调用（如 webhook 回调验签）预留能力。
 */
export function verifyInboundSignature(args: {
  method: string;
  path: string;
  body?: string | Buffer | null;
  timestampHeader?: string | null;
  signatureHeader?: string | null;
  toleranceMs?: number;
  nowMs?: number;
}): { valid: boolean; reason?: string } {
  const { method, path, body, timestampHeader, signatureHeader } = args;
  const tol = args.toleranceMs ?? TIMESTAMP_TOLERANCE_MS;
  const now = args.nowMs ?? Date.now();

  const { secret } = loadInternalCredentials();
  if (!secret) return { valid: false, reason: "missing_secret" };
  if (!timestampHeader || !signatureHeader) return { valid: false, reason: "missing_headers" };

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return { valid: false, reason: "missing_headers" };
  const skew = Math.abs(now - ts);
  if (skew > tol) return { valid: false, reason: skew > tol * 2 ? "stale" : "skew" };

  const bodyHex = sha256Hex(body ?? "");
  const canonical = buildCanonicalString(method, path, timestampHeader, bodyHex);
  const expected = hmacSign(secret, canonical);
  return constantTimeEqual(expected, signatureHeader)
    ? { valid: true }
    : { valid: false, reason: "bad_sig" };
}
