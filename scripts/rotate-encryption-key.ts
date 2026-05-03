/**
 * 加密密钥轮换脚本 —— 安全地旋转 SA_ENCRYPTION_KEY
 *
 * 工作原理：
 *   1. 启动时数据是用旧 key 加密的
 *   2. .env 中已设置新 key + 旧 key（LEGACY）
 *   3. migrateKeys() 用新 key 解密失败 → 回退 LEGACY → 重加密写回 DB
 *   4. 全部迁移完成后，删除 SA_ENCRYPTION_KEY_LEGACY 即可
 *
 * 用法：npx tsx scripts/rotate-encryption-key.ts
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, ProviderStore, initConfigStore, paths } from "@super-agent/core";
import pino from "pino";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = pino({ name: "rotate-encryption-key" });

/**
 * 手动加载 .env 文件（避免依赖 dotenv 包）
 * 从 CWD 向上查找 .env（支持从根目录或 packages/api 运行）
 */
function loadEnvFile(): void {
  // 从 CWD 向上查找 .env
  let dir = process.cwd();
  let envPath = "";
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, ".env");
    try {
      readFileSync(candidate, "utf-8");
      envPath = candidate;
      break;
    } catch {
      dir = resolve(dir, "..");
    }
  }
  if (!envPath) {
    logger.error("无法找到 .env 文件，请从 super-agent 根目录或其子目录运行此脚本");
    process.exit(1);
  }

  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // 去掉可选引号
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
    logger.info({ path: envPath }, ".env 加载成功");
  } catch (err) {
    logger.error({ err, path: envPath }, "无法加载 .env 文件");
    process.exit(1);
  }
}

async function main() {
  // ── 加载 .env ──
  loadEnvFile();

  // ── 前置校验：确保新旧密钥都已配置 ──
  const newKey = process.env.SA_ENCRYPTION_KEY;
  const legacyKey = process.env.SA_ENCRYPTION_KEY_LEGACY;

  if (!newKey) {
    logger.error("SA_ENCRYPTION_KEY 未设置！请在 .env 中配置新密钥。");
    process.exit(1);
  }
  if (!legacyKey) {
    logger.error("SA_ENCRYPTION_KEY_LEGACY 未设置！迁移需要旧密钥来解密现有数据。");
    process.exit(1);
  }

  logger.info({ dbPath: paths.db() }, "开始加密密钥轮换...");
  logger.info({ newKeyPrefix: newKey.slice(0, 8) + "..." }, "新密钥前缀");
  logger.info({ legacyKeyPrefix: legacyKey.slice(0, 8) + "..." }, "旧密钥前缀");

  // ── 初始化数据库 ──
  await initDatabase();

  // ── 迁移 Provider API Keys ──
  const providerStore = new ProviderStore();
  providerStore.init();
  providerStore.syncFromEnv();
  providerStore.migrateKeys();
  logger.info("ProviderStore 密钥迁移完成");

  // ── 迁移 Service Configs ──
  initConfigStore(); // 内部自动调用 migrateKeys()
  logger.info("ConfigStore 密钥迁移完成");

  // ── 验证：尝试读取几个关键记录确认可解密 ──
  const allProviders = providerStore.list();
  const configuredCount = allProviders.filter((p) => p.apiKey).length;
  logger.info({ total: allProviders.length, withApiKey: configuredCount }, "验证：ProviderStore 数据可正常解密");

  logger.info("✅ 加密密钥轮换完成！");
  logger.info("   下一步：删除 .env 中的 SA_ENCRYPTION_KEY_LEGACY 行，完成最终清理。");

  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "密钥轮换失败");
  process.exit(1);
});
