/**
 * Provider Store — SQLite persistence for LLM provider configurations.
 *
 * Stores API keys (AES-256-CBC encrypted) and custom base URLs.
 * Supports CRUD operations and env-variable fallback.
 *
 * SEC-P0-02: 加密密钥由 security/encryption-key.ts 集中管理：
 *   - 强制要求 SA_ENCRYPTION_KEY（长度 ≥32 且非弱密钥），否则启动崩溃
 *   - 支持 SA_ENCRYPTION_KEY_LEGACY 过渡期，解密自动回退并在迁移阶段重加密
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import pino from "pino";
import { getDatabase, scheduleSave } from "../persistence/sqlite.js";
import { getModelCatalog } from "./model-catalog.js";
import { Env } from "../config/env.js";
import { getEncryptionKey, decryptWithFallback } from "../security/encryption-key.js";

const logger = pino({ name: "provider-store" });

// ─── Types ────────────────────────────────────────────────────

export interface ProviderRecord {
  id: string;
  apiKey: string;
  baseUrl: string;
  isEnabled: boolean;
  selectedModel: string;
  createdAt: string;
  updatedAt: string;
}

// ─── AES-256-CBC Encryption (key 由 encryption-key.ts 统一管理) ──

/**
 * 使用"当前新 key"加密明文。
 * 注：这里每次调用 getEncryptionKey()，内部 sha256 开销可忽略，换取测试/热更新的灵活性。
 */
function encryptApiKey(text: string): { encrypted: string; iv: string } {
  if (!text) return { encrypted: "", iv: "" };
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", getEncryptionKey(), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return { encrypted, iv: iv.toString("hex") };
}

/**
 * 使用指定 key 执行 AES 解密（底层实现，供 fallback 机制复用）。
 */
function decryptApiKeyWithKey(encrypted: string, ivHex: string, key: Buffer): string {
  const iv = Buffer.from(ivHex, "hex");
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * 解密 API Key — 先试新 key，失败回退 legacy key。
 * @returns plain 明文；usedLegacy=true 表示这条记录需要用新 key 重新加密写回
 */
function decryptApiKey(encrypted: string, ivHex: string): { plain: string; usedLegacy: boolean } {
  if (!encrypted || !ivHex) return { plain: "", usedLegacy: false };
  const { plaintext, usedLegacy } = decryptWithFallback((key) =>
    decryptApiKeyWithKey(encrypted, ivHex, key),
  );
  return { plain: plaintext, usedLegacy };
}

// ─── Legacy base64 obfuscation (for migration only) ──

// Known API key plaintext prefixes (from Letta crypto_utils.py PLAINTEXT_PREFIXES)
const PLAINTEXT_PREFIXES = ["sk-", "pk-", "api-", "AKIA", "xoxb-", "ghp_", "gho_", "glpat-"];

function isBase64(str: string): boolean {
  if (!str || str.length < 16) return false;
  // If it starts with a known API key prefix, it's definitely NOT base64
  if (PLAINTEXT_PREFIXES.some(p => str.startsWith(p))) return false;
  // Strict base64 character set check
  if (!/^[A-Za-z0-9+/]+=*$/.test(str)) return false;
  // Round-trip verification
  try {
    return Buffer.from(Buffer.from(str, "base64").toString("utf-8")).toString("base64") === str;
  } catch { return false; }
}

function deobfuscateLegacy(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf-8");
}

/** Mask an API key for display: "sk-***...abc" */
export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return key ? "***" : "";
  return key.slice(0, 3) + "***..." + key.slice(-3);
}

// ─── ProviderStore ────────────────────────────────────────────

export class ProviderStore {
  private initialized = false;

  /** Ensure the llm_providers table exists. Call once at startup. */
  init(): void {
    if (this.initialized) return;
    const db = getDatabase();
    // 创建表时自带 api_key_iv 列（生产环境修复：v1 baseline 不包含此表，
    // migration v2 在表创建前就跑了，导致 api_key_iv 列永远缺失）
    db.run(`
      CREATE TABLE IF NOT EXISTS llm_providers (
        id TEXT PRIMARY KEY,
        api_key TEXT DEFAULT '',
        api_key_iv TEXT DEFAULT '',
        base_url TEXT DEFAULT '',
        is_enabled INTEGER DEFAULT 1,
        selected_model TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    // 兼容旧数据库：表已存在但缺少 api_key_iv 列，补加
    try {
      db.run("ALTER TABLE llm_providers ADD COLUMN api_key_iv TEXT DEFAULT ''");
    } catch {
      // 列已存在，忽略
    }
    scheduleSave();
    this.initialized = true;
    logger.info("ProviderStore initialized (llm_providers table ready)");
  }

  /**
   * 将环境变量播种到数据库（仅首次：DB 中已有 API Key 则跳过）。
   * 设计意图：env 作为一次性引导，设置页面为唯一真相源。
   */
  syncFromEnv(): void {
    const catalog = getModelCatalog();
    for (const provider of catalog) {
      if (provider.id === "custom") continue;
      const envKey = process.env[provider.envKey];
      if (envKey) {
        // 仅首次播种：DB 中已有 API Key 则跳过，避免覆盖设置页面的修改
        const existing = this.get(provider.id);
        if (!existing?.apiKey) {
          this.upsert(provider.id, { apiKey: envKey });
          logger.info({ provider: provider.id }, `Seeded API key from env: ${provider.envKey}`);
        }
      }
    }
    // 也支持传统的 LLM_API_KEY + LLM_BASE_URL 环境变量
    if (Env.LLM_API_KEY && Env.LLM_BASE_URL) {
      const baseUrl = Env.LLM_BASE_URL;
      const matchedProvider = catalog.find((p) => p.baseUrl && baseUrl.startsWith(p.baseUrl.replace(/\/v\d.*/, "")));
      if (matchedProvider) {
        const existing = this.get(matchedProvider.id);
        // 仅首次播种：DB 中已有 API Key 则跳过
        if (!existing?.apiKey) {
          this.upsert(matchedProvider.id, {
            apiKey: Env.LLM_API_KEY,
            baseUrl: Env.LLM_BASE_URL !== matchedProvider.baseUrl ? Env.LLM_BASE_URL : undefined,
            selectedModel: existing?.selectedModel || Env.LLM_MODEL,
          });
          logger.info({ provider: matchedProvider.id }, "Seeded legacy LLM_* env vars");
        }
      } else {
        const existing = this.get("custom");
        // 仅首次播种：DB 中已有 API Key 则跳过
        if (!existing?.apiKey) {
          this.upsert("custom", {
            apiKey: Env.LLM_API_KEY,
            baseUrl: Env.LLM_BASE_URL,
            selectedModel: existing?.selectedModel || Env.LLM_MODEL,
          });
          logger.info("Seeded legacy LLM_* env vars as custom provider");
        }
      }
    }
  }

  /** List all provider records from database. */
  list(): ProviderRecord[] {
    const db = getDatabase();
    const rows = db.exec("SELECT id, api_key, base_url, is_enabled, selected_model, created_at, updated_at, api_key_iv FROM llm_providers ORDER BY created_at");
    if (!rows.length) return [];
    return rows[0].values.map((row: any[]) => ({
      id: row[0],
      apiKey: this.decodeApiKey(row[1], row[7]),
      baseUrl: row[2] || "",
      isEnabled: row[3] === 1,
      selectedModel: row[4] || "",
      createdAt: row[5],
      updatedAt: row[6],
    }));
  }

  /** Get a single provider record. */
  get(id: string): ProviderRecord | null {
    const db = getDatabase();
    const rows = db.exec("SELECT id, api_key, base_url, is_enabled, selected_model, created_at, updated_at, api_key_iv FROM llm_providers WHERE id = ?", [id]);
    if (!rows.length || !rows[0].values.length) return null;
    const row = rows[0].values[0] as any[];
    return {
      id: row[0],
      apiKey: this.decodeApiKey(row[1], row[7]),
      baseUrl: row[2] || "",
      isEnabled: row[3] === 1,
      selectedModel: row[4] || "",
      createdAt: row[5],
      updatedAt: row[6],
    };
  }

  /** Insert or update a provider configuration. */
  upsert(id: string, data: { apiKey?: string; baseUrl?: string; isEnabled?: boolean; selectedModel?: string }): ProviderRecord {
    const db = getDatabase();
    const now = new Date().toISOString();
    const existing = this.get(id);

    if (existing) {
      const keyToStore = data.apiKey !== undefined ? data.apiKey : existing.apiKey;
      const { encrypted: apiKey, iv: apiKeyIv } = encryptApiKey(keyToStore);
      const baseUrl = data.baseUrl !== undefined ? data.baseUrl : existing.baseUrl;
      const isEnabled = data.isEnabled !== undefined ? (data.isEnabled ? 1 : 0) : (existing.isEnabled ? 1 : 0);
      const selectedModel = data.selectedModel !== undefined ? data.selectedModel : existing.selectedModel;
      db.run(
        "UPDATE llm_providers SET api_key = ?, api_key_iv = ?, base_url = ?, is_enabled = ?, selected_model = ?, updated_at = ? WHERE id = ?",
        [apiKey, apiKeyIv, baseUrl, isEnabled, selectedModel, now, id]
      );
    } else {
      const { encrypted: apiKey, iv: apiKeyIv } = data.apiKey ? encryptApiKey(data.apiKey) : { encrypted: "", iv: "" };
      const baseUrl = data.baseUrl || "";
      const isEnabled = data.isEnabled !== undefined ? (data.isEnabled ? 1 : 0) : 1;
      const selectedModel = data.selectedModel || "";
      db.run(
        "INSERT INTO llm_providers (id, api_key, api_key_iv, base_url, is_enabled, selected_model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, apiKey, apiKeyIv, baseUrl, isEnabled, selectedModel, now, now]
      );
    }
    scheduleSave();
    return this.get(id)!;
  }

  /**
   * Decode an API key from database, handling both legacy base64 and new AES formats.
   * If iv is empty/null → legacy base64 obfuscation → decode and auto-migrate to AES.
   * If iv is present → AES-256-CBC encrypted → decrypt（失败时自动回退 SA_ENCRYPTION_KEY_LEGACY）。
   *
   * 注：使用 legacy key 成功解密的记录不会在此处直接回写（read 路径保持纯粹），
   * 统一由 migrateKeys() 在启动阶段一次性重加密。这里仅记录一条 debug 级日志。
   */
  private decodeApiKey(encodedKey: string | null, iv: string | null): string {
    if (!encodedKey) return "";

    // New AES format: iv is present and non-empty
    if (iv && iv.length > 0) {
      try {
        const { plain, usedLegacy } = decryptApiKey(encodedKey, iv);
        if (usedLegacy) {
          logger.debug("Provider API key decrypted via SA_ENCRYPTION_KEY_LEGACY; will be re-encrypted on next migrateKeys()");
        }
        return plain;
      } catch (err) {
        logger.warn({ err }, "Failed to decrypt API key with AES (even with legacy fallback), returning empty");
        return "";
      }
    }

    // Legacy base64 format: iv is empty/null
    try {
      if (isBase64(encodedKey)) {
        return deobfuscateLegacy(encodedKey);
      }
    } catch {
      // Not base64 either, return as-is
    }
    return encodedKey;
  }

  /**
   * Auto-migrate legacy records to the current SA_ENCRYPTION_KEY:
   *   1) iv 为空的记录：旧 base64 混淆 → 新 AES 加密
   *   2) iv 非空但新 key 解不开 / 需回退 LEGACY：用 legacy 解出明文后用新 key 重加密
   * 每次迁移后执行一次 scheduleSave()，完成后用户可删除 SA_ENCRYPTION_KEY_LEGACY。
   */
  migrateKeys(): void {
    const db = getDatabase();
    const rows = db.exec("SELECT id, api_key, api_key_iv FROM llm_providers");
    if (!rows.length) return;

    let migratedFromBase64 = 0;
    let migratedFromLegacyKey = 0;
    for (const row of rows[0].values) {
      const id = row[0] as string;
      const key = row[1] as string;
      const iv = row[2] as string;

      if (!key) continue;

      if (iv && iv.length > 0) {
        // AES 记录：只在需要回退 LEGACY 时才重加密（避免无意义写入）
        try {
          const { plain, usedLegacy } = decryptApiKey(key, iv);
          if (!usedLegacy) continue; // 新 key 已能解密，无需迁移
          const { encrypted, iv: newIv } = encryptApiKey(plain);
          db.run(
            "UPDATE llm_providers SET api_key = ?, api_key_iv = ?, updated_at = ? WHERE id = ?",
            [encrypted, newIv, new Date().toISOString(), id],
          );
          migratedFromLegacyKey++;
        } catch (err) {
          // 检查是否配置了 LEGACY key — 若有则说明双 key 均失败，数据永久无法解密
          if (process.env.SA_ENCRYPTION_KEY_LEGACY) {
            // 永久解密失败：清空残损记录，阻止每次启动/读取都告警
            db.run(
              "UPDATE llm_providers SET api_key = '', api_key_iv = '', updated_at = ? WHERE id = ?",
              [new Date().toISOString(), id],
            );
            logger.warn(
              { id },
              "[migration] 提供商凭据永久无法解密（新旧密钥均失败），已清空残损记录。" +
              "请在 Admin → Providers 页面重新输入 API Key。",
            );
          } else {
            logger.warn({ id, err }, "Failed to re-encrypt record during legacy-key migration");
          }
        }
        continue;
      }

      // Legacy base64 format (iv 为空)
      try {
        const plainKey = isBase64(key) ? deobfuscateLegacy(key) : key;
        const { encrypted, iv: newIv } = encryptApiKey(plainKey);
        db.run(
          "UPDATE llm_providers SET api_key = ?, api_key_iv = ?, updated_at = ? WHERE id = ?",
          [encrypted, newIv, new Date().toISOString(), id],
        );
        migratedFromBase64++;
      } catch (err) {
        logger.warn({ id, err }, "Failed to migrate legacy base64 API key");
      }
    }

    if (migratedFromBase64 > 0 || migratedFromLegacyKey > 0) {
      scheduleSave();
      logger.info(
        { migratedFromBase64, migratedFromLegacyKey },
        "[migration] Provider API keys re-encrypted with current SA_ENCRYPTION_KEY",
      );
    }
  }

  /** Clear the API key for a provider. */
  clearKey(id: string): boolean {
    const db = getDatabase();
    const existing = this.get(id);
    if (!existing) return false;
    db.run("UPDATE llm_providers SET api_key = '', api_key_iv = '', updated_at = ? WHERE id = ?", [new Date().toISOString(), id]);
    scheduleSave();
    return true;
  }

  /** Delete a provider record entirely. */
  delete(id: string): boolean {
    const db = getDatabase();
    const existing = this.get(id);
    if (!existing) return false;
    db.run("DELETE FROM llm_providers WHERE id = ?", [id]);
    scheduleSave();
    return true;
  }

  /** Get the first configured (has API key) and enabled provider. */
  getActiveProvider(): ProviderRecord | null {
    const all = this.list();
    return all.find((p) => p.isEnabled && p.apiKey) || null;
  }
}
