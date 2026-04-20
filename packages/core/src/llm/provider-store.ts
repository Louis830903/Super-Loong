/**
 * Provider Store — SQLite persistence for LLM provider configurations.
 *
 * Stores API keys (AES-256-CBC encrypted) and custom base URLs.
 * Supports CRUD operations and env-variable fallback.
 *
 * Set SA_ENCRYPTION_KEY env var for a stable encryption key in production.
 * Without it, a default key is used (safe for development but less secure).
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import pino from "pino";
import { getDatabase, scheduleSave } from "../persistence/sqlite.js";
import { getModelCatalog } from "./model-catalog.js";

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

// ─── AES-256-CBC Encryption (replaces old base64 obfuscation) ──

const SA_KEY_FROM_ENV = process.env.SA_ENCRYPTION_KEY;
const ENCRYPTION_KEY = createHash("sha256")
  .update(SA_KEY_FROM_ENV ?? "super-agent-default-encryption-key-v1")
  .digest();

// Startup warning: alert if using default encryption key (Letta/Hermes pattern)
if (!SA_KEY_FROM_ENV) {
  logger.warn(
    "\n============================================================\n" +
    "  WARNING: SA_ENCRYPTION_KEY not set!\n" +
    "  API keys are encrypted with a DEFAULT key from source code.\n" +
    "  This is acceptable for development but INSECURE for production.\n" +
    "  Set SA_ENCRYPTION_KEY to a random 32+ char string.\n" +
    "============================================================"
  );
}

function encryptApiKey(text: string): { encrypted: string; iv: string } {
  if (!text) return { encrypted: "", iv: "" };
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return { encrypted, iv: iv.toString("hex") };
}

function decryptApiKey(encrypted: string, ivHex: string): string {
  if (!encrypted || !ivHex) return "";
  const iv = Buffer.from(ivHex, "hex");
  const decipher = createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
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
    db.run(`
      CREATE TABLE IF NOT EXISTS llm_providers (
        id TEXT PRIMARY KEY,
        api_key TEXT DEFAULT '',
        base_url TEXT DEFAULT '',
        is_enabled INTEGER DEFAULT 1,
        selected_model TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    scheduleSave();
    this.initialized = true;
    logger.info("ProviderStore initialized (llm_providers table ready)");
  }

  /** Sync environment variables into the database (env takes priority). */
  syncFromEnv(): void {
    const catalog = getModelCatalog();
    for (const provider of catalog) {
      if (provider.id === "custom") continue;
      const envKey = process.env[provider.envKey];
      if (envKey) {
        this.upsert(provider.id, { apiKey: envKey });
        logger.info({ provider: provider.id }, `Synced API key from env: ${provider.envKey}`);
      }
    }
    // Also support legacy LLM_API_KEY + LLM_BASE_URL
    if (process.env.LLM_API_KEY && process.env.LLM_BASE_URL) {
      const baseUrl = process.env.LLM_BASE_URL;
      const matchedProvider = catalog.find((p) => p.baseUrl && baseUrl.startsWith(p.baseUrl.replace(/\/v\d.*/, "")));
      if (matchedProvider) {
        // Only seed selectedModel from env if no model is already configured in DB.
        // This prevents env vars from overriding user's UI selections on every restart.
        const existing = this.get(matchedProvider.id);
        this.upsert(matchedProvider.id, {
          apiKey: process.env.LLM_API_KEY,
          baseUrl: process.env.LLM_BASE_URL !== matchedProvider.baseUrl ? process.env.LLM_BASE_URL : undefined,
          selectedModel: existing?.selectedModel || process.env.LLM_MODEL,
        });
        logger.info({ provider: matchedProvider.id }, "Synced legacy LLM_* env vars");
      } else {
        // Custom provider
        const existing = this.get("custom");
        this.upsert("custom", {
          apiKey: process.env.LLM_API_KEY,
          baseUrl: process.env.LLM_BASE_URL,
          selectedModel: existing?.selectedModel || process.env.LLM_MODEL,
        });
        logger.info("Synced legacy LLM_* env vars as custom provider");
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
   * If iv is present → AES-256-CBC encrypted → decrypt.
   */
  private decodeApiKey(encodedKey: string | null, iv: string | null): string {
    if (!encodedKey) return "";

    // New AES format: iv is present and non-empty
    if (iv && iv.length > 0) {
      try {
        return decryptApiKey(encodedKey, iv);
      } catch (err) {
        logger.warn({ err }, "Failed to decrypt API key with AES, returning empty");
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
   * Auto-migrate legacy base64 keys to AES encryption.
   * Called once after init + syncFromEnv to upgrade existing records.
   */
  migrateKeys(): void {
    const db = getDatabase();
    const rows = db.exec("SELECT id, api_key, api_key_iv FROM llm_providers");
    if (!rows.length) return;

    let migrated = 0;
    for (const row of rows[0].values) {
      const id = row[0] as string;
      const key = row[1] as string;
      const iv = row[2] as string;

      // Skip empty keys or already-encrypted keys
      if (!key || (iv && iv.length > 0)) continue;

      // Decode legacy base64 and re-encrypt with AES
      try {
        const plainKey = isBase64(key) ? deobfuscateLegacy(key) : key;
        const { encrypted, iv: newIv } = encryptApiKey(plainKey);
        db.run(
          "UPDATE llm_providers SET api_key = ?, api_key_iv = ?, updated_at = ? WHERE id = ?",
          [encrypted, newIv, new Date().toISOString(), id]
        );
        migrated++;
      } catch (err) {
        logger.warn({ id, err }, "Failed to migrate legacy API key");
      }
    }

    if (migrated > 0) {
      scheduleSave();
      logger.info({ migrated }, "Migrated legacy base64 API keys to AES-256-CBC encryption");
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
