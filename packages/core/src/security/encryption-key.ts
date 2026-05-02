/**
 * 加密密钥管理 — 统一管理 AES-256-CBC 加密密钥的派生、校验与迁移
 *
 * 策略：
 *  - 从 SA_ENCRYPTION_KEY 环境变量派生 SHA-256 新密钥（强制长度 ≥32 且非默认弱值）
 *  - 同时读取 SA_ENCRYPTION_KEY_LEGACY（可选），用于过渡期解密旧数据
 *  - 提供 decryptWithFallback 实现"先新后旧"解密模式
 *
 * 背景（v2 AUDIT SEC-P0-02）：
 *  - 原 provider-store.ts / config-store.ts 在未设置 SA_ENCRYPTION_KEY 时使用硬编码
 *    默认值 "super-agent-default-encryption-key-v1"，等同于未加密
 *  - 直接切换到新 key 会导致已落库的历史凭证全部解密失败，因此提供 LEGACY 过渡方案：
 *    解密失败时回退到 legacy key，成功后由迁移逻辑用新 key 重加密写回
 */

import { createHash } from "node:crypto";

// 已知的弱/默认密钥（直接列为黑名单）
const KNOWN_WEAK_KEYS = new Set<string>([
  "super-agent-default-encryption-key-v1",
  "super-agent-default-encryption-key",
  "default-encryption-key",
  "changeme",
  "password",
]);

/** 最小安全长度（字符数）。hex(32) / base64(48) 都能轻松满足。 */
const MIN_KEY_LENGTH = 32;

/**
 * 生成 crash 文案 — 同时给出 Node / OpenSSL 两种生成强密钥的自助命令。
 * CLI 友好：用户复制粘贴即可拿到合规密钥。
 */
function buildMissingKeyMessage(): string {
  return (
    "[SECURITY] SA_ENCRYPTION_KEY 环境变量未设置，拒绝启动！\n" +
    "  此密钥用于加密数据库中存储的 LLM API Key 与第三方服务凭据。\n" +
    "  请生成强密钥并写入 .env：\n" +
    "    方式一（推荐）： openssl rand -hex 32\n" +
    "    方式二（Node）： node -e \"console.log(require('crypto').randomBytes(48).toString('base64'))\"\n" +
    "  随后编辑 .env：SA_ENCRYPTION_KEY=<生成的密钥>\n" +
    "  若升级自旧版本且数据库中已有凭证，可临时设置 SA_ENCRYPTION_KEY_LEGACY=<旧密钥> 过渡一次启动。"
  );
}

function buildWeakKeyMessage(reason: string): string {
  return (
    `[SECURITY] SA_ENCRYPTION_KEY 不符合安全要求：${reason}\n` +
    `  要求：长度 ≥ ${MIN_KEY_LENGTH} 字符，且不在已知默认/弱密钥列表中。\n` +
    `  生成强密钥： openssl rand -hex 32`
  );
}

/** 是否为弱密钥。单一入口，便于测试。 */
export function isWeakEncryptionKey(key: string): string | null {
  if (key.length < MIN_KEY_LENGTH) {
    return `长度 ${key.length} < ${MIN_KEY_LENGTH}`;
  }
  if (KNOWN_WEAK_KEYS.has(key)) {
    return "使用了已知默认/弱密钥";
  }
  return null;
}

/**
 * 获取当前加密密钥（用于新写入）。
 * 若 SA_ENCRYPTION_KEY 未设置或为弱密钥，抛出错误阻止启动。
 *
 * 注：每次调用都重新读取 process.env，便于测试动态注入。生产路径开销可忽略。
 */
export function getEncryptionKey(): Buffer {
  const raw = process.env.SA_ENCRYPTION_KEY;
  if (!raw || raw.length === 0) {
    throw new Error(buildMissingKeyMessage());
  }
  const weakReason = isWeakEncryptionKey(raw);
  if (weakReason) {
    throw new Error(buildWeakKeyMessage(weakReason));
  }
  return createHash("sha256").update(raw).digest();
}

/**
 * 获取 LEGACY 旧密钥（可选，用于解密历史数据）。
 * 未设置则返回 undefined。LEGACY 不做强度校验（旧数据可能就是用弱密钥加密的）。
 */
export function getLegacyEncryptionKey(): Buffer | undefined {
  const raw = process.env.SA_ENCRYPTION_KEY_LEGACY;
  if (!raw || raw.length === 0) return undefined;
  return createHash("sha256").update(raw).digest();
}

/**
 * 使用新 key 解密，失败时 fallback 到 legacy key。
 *
 * @param decryptFn 执行实际 AES 解密的回调（由 provider-store / config-store 各自实现）
 * @returns { plaintext, usedLegacy } usedLegacy=true 时调用方应在迁移阶段用新 key 重加密写回
 */
export function decryptWithFallback<T>(
  decryptFn: (key: Buffer) => T,
): { plaintext: T; usedLegacy: boolean } {
  // 先试新 key
  try {
    return { plaintext: decryptFn(getEncryptionKey()), usedLegacy: false };
  } catch (errPrimary) {
    // 新 key 解密失败 → 尝试 legacy（若已配置）
    const legacy = getLegacyEncryptionKey();
    if (!legacy) {
      // 无 legacy 可回退，抛出原始错误
      throw errPrimary;
    }
    return { plaintext: decryptFn(legacy), usedLegacy: true };
  }
}

/** 是否配置了 LEGACY 密钥（给 migrateKeys 之类决定是否尝试迁移路径用）。 */
export function hasLegacyEncryptionKey(): boolean {
  return !!process.env.SA_ENCRYPTION_KEY_LEGACY;
}
