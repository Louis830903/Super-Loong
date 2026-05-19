/**
 * Credential Vault — AES-256-CBC 加密的凭据保险柜
 *
 * @why v3 Task 9 拆分：从原 sandbox.ts 提取 CredentialVault 类（约 260 行），
 *      职责单一：凭据加解密 + ACL + SQLite 持久化 + v3 Task 5.5 fail-fast。
 *      与 ProcessSandbox / SecurityManager 解耦，便于单测和审计。
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

import {
  saveCredentialToDB,
  loadCredentialsFromDB,
  deleteCredentialFromDB,
} from "../persistence/sqlite.js";
import { getEncryptionKey } from "./encryption-key.js";
import type { CredentialEntry } from "./sandbox-types.js";

const logger = pino({ name: "security:vault" });

/**
 * 凭据保险柜：AES-256-CBC 加密存储 API Key / Token 等敏感信息。
 * 提供三层密钥源策略（masterKey→SA_ENCRYPTION_KEY→临时密钥）+ fail-fast。
 * @why 避免明文凭据散落在 .env / 代码中；加密 + ACL + 审计日志实现三层防护。
 */
export class CredentialVault {
  private credentials: Map<string, CredentialEntry> = new Map();
  private encryptionKey: Buffer;

  /** Whether credentials persist across restarts (true only with a stable master key) */
  readonly persistent: boolean;

  constructor(masterKey?: string) {
    // 三层密钥源策略（防双重哈希）：
    //   1. masterKey 参数或 CREDENTIAL_MASTER_KEY 环境变量（旧版兼容）→ 自哈希
    //   2. SA_ENCRYPTION_KEY（新版统一标准）→ getEncryptionKey() 已哈希，直接使用
    //   3. 都未设置 → v3 Task 5.5：默认 fail-fast报错；仅开发调试模式允许临时密钥兑底
    const keySource = masterKey ?? process.env.CREDENTIAL_MASTER_KEY;
    let keyFromLegacy = false;

    if (keySource) {
      // 旧版路径：CREDENTIAL_MASTER_KEY — 自哈希
      this.encryptionKey = createHash("sha256").update(keySource).digest();
      this.persistent = true;
      keyFromLegacy = true;
    } else {
      // 新版路径：SA_ENCRYPTION_KEY — 直接使用已哈希密钥（不二次哈希！）
      try {
        this.encryptionKey = getEncryptionKey();
        this.persistent = true;
      } catch (err) {
        // v3 Task 5.5：SA_ENCRYPTION_KEY 未设置或弱密钥→ fail-fast
        // @why 生产环境启动必败防止临时密钥造成重启后凭据丢失。
        //      开发/CI 可设 SA_VAULT_FAIL_FAST=false 临时兑底。
        //      NODE_ENV !== 'production' 默认兑底，避免本地调试被阻。
        const failFast = this._shouldFailFast();
        if (failFast) {
          const reason = err instanceof Error ? err.message : String(err);
          const message =
            "[SECURITY][FAIL-FAST] SA_ENCRYPTION_KEY 未设置或不符合安全要求，" +
            "v3 Task 5.5 凭据保险柜拒绝启动。" +
            "请在 .env 中设置 SA_ENCRYPTION_KEY（指令：openssl rand -hex 32 或 node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"）。" +
            ` 底层原因：${reason}。` +
            " 如需临时兑底，设 SA_VAULT_FAIL_FAST=false（仅开发/CI）。";
          logger.error(message);
          throw new Error(message);
        }
        // 调试路径：临时密钥不持久化，重启后凭据丢失
        logger.error(
          "[SECURITY] SA_ENCRYPTION_KEY 未设置或不符合安全要求！" +
            "凭据将使用临时密钥，重启后不可恢复。" +
            "请在 .env 中设置 SA_ENCRYPTION_KEY（推荐：openssl rand -hex 32）。",
        );
        this.encryptionKey = createHash("sha256").update(randomBytes(32).toString("hex")).digest();
        this.persistent = false;
      }
    }

    // B-17: 持久化模式下，从 SQLite 加载已存储的凭证
    if (this.persistent) {
      try {
        const saved = loadCredentialsFromDB();
        for (const row of saved) {
          this.credentials.set(row.name, {
            id: `cred_restored`,
            name: row.name,
            encryptedValue: row.encryptedValue,
            iv: row.iv,
            description: row.description,
            allowedAgents: row.allowedAgents,
            allowedTools: row.allowedTools,
            createdAt: new Date(row.createdAt),
            accessCount: 0,
          });
        }
        if (saved.length > 0) {
          logger.info({ count: saved.length, keyFromLegacy }, "Credentials restored from SQLite");

          // Task 1a: 凭据迁移 — 如果用旧密钥加载了凭据但新密钥已配置，自动迁移
          if (keyFromLegacy) {
            // 尝试用新密钥（若已配置），无法获取则不迁移
            try {
              const newKey = getEncryptionKey();
              if (!newKey.equals(this.encryptionKey)) {
                logger.info({ count: saved.length },
                  "检测到 SA_ENCRYPTION_KEY 已配置，正在将旧凭据迁移到新密钥...");
                this.encryptionKey = newKey;
                let migrated = 0;
                let failed = 0;
                for (const row of saved) {
                  try {
                    // 用旧密钥解密
                    const oldKey = createHash("sha256").update(keySource!).digest();
                    const oldIv = Buffer.from(row.iv, "hex");
                    const decipher = createDecipheriv("aes-256-cbc", oldKey, oldIv);
                    let plaintext = decipher.update(row.encryptedValue, "hex", "utf8");
                    plaintext += decipher.final("utf8");
                    // 用新密钥重加密
                    const newIv = randomBytes(16);
                    const cipher = createCipheriv("aes-256-cbc", newKey, newIv);
                    let reEncrypted = cipher.update(plaintext, "utf8", "hex");
                    reEncrypted += cipher.final("hex");
                    // 写回 SQLite
                    saveCredentialToDB({
                      name: row.name,
                      encryptedValue: reEncrypted,
                      iv: newIv.toString("hex"),
                      description: row.description,
                      allowedAgents: row.allowedAgents,
                      allowedTools: row.allowedTools,
                    });
                    // 更新内存中的条目
                    const memEntry = this.credentials.get(row.name);
                    if (memEntry) {
                      memEntry.encryptedValue = reEncrypted;
                      memEntry.iv = newIv.toString("hex");
                    }
                    migrated++;
                  } catch {
                    failed++;
                  }
                }
                logger.info({ migrated, failed },
                  `凭据迁移完成：${migrated} 个成功${failed > 0 ? `，${failed} 个失败` : ""}`);
              }
            } catch {
              // SA_ENCRYPTION_KEY 不可用，保持旧密钥（不迁移）
              logger.info("SA_ENCRYPTION_KEY 不可用，凭据保持 CREDENTIAL_MASTER_KEY 加密");
            }
          }
        }
      } catch {
        // DB might not be initialized yet
      }
    }
  }

  /** Store a credential (encrypted) */
  store(name: string, value: string, options?: {
    description?: string;
    allowedAgents?: string[];
    allowedTools?: string[];
  }): CredentialEntry {
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", this.encryptionKey, iv);
    let encrypted = cipher.update(value, "utf8", "hex");
    encrypted += cipher.final("hex");

    const entry: CredentialEntry = {
      id: `cred_${uuid().slice(0, 8)}`,
      name,
      encryptedValue: encrypted,
      iv: iv.toString("hex"),
      description: options?.description,
      allowedAgents: options?.allowedAgents,
      allowedTools: options?.allowedTools,
      createdAt: new Date(),
      accessCount: 0,
    };

    this.credentials.set(name, entry);

    // B-17: 持久化到 SQLite
    if (this.persistent) {
      try {
        saveCredentialToDB({
          name,
          encryptedValue: encrypted,
          iv: iv.toString("hex"),
          description: options?.description,
          allowedAgents: options?.allowedAgents,
          allowedTools: options?.allowedTools,
        });
      } catch { /* DB might not be initialized */ }
    }

    logger.info({ name, id: entry.id }, "Credential stored");
    return entry;
  }

  /** Retrieve a credential value (decrypted) — only called by token proxy */
  retrieve(name: string, agentId?: string, toolName?: string): string | null {
    const entry = this.credentials.get(name);
    if (!entry) return null;

    // Check access control
    if (entry.allowedAgents?.length && agentId && !entry.allowedAgents.includes(agentId)) {
      logger.warn({ name, agentId }, "Credential access denied: agent not allowed");
      return null;
    }
    if (entry.allowedTools?.length && toolName && !entry.allowedTools.includes(toolName)) {
      logger.warn({ name, toolName }, "Credential access denied: tool not allowed");
      return null;
    }

    try {
      const iv = Buffer.from(entry.iv, "hex");
      const decipher = createDecipheriv("aes-256-cbc", this.encryptionKey, iv);
      let decrypted = decipher.update(entry.encryptedValue, "hex", "utf8");
      decrypted += decipher.final("utf8");

      entry.lastAccessedAt = new Date();
      entry.accessCount++;
      return decrypted;
    } catch {
      logger.error({ name }, "Credential decryption failed");
      return null;
    }
  }

  /** Delete a credential */
  delete(name: string): boolean {
    const deleted = this.credentials.delete(name);
    // B-17: 从 SQLite 也删除
    if (deleted && this.persistent) {
      try { deleteCredentialFromDB(name); } catch { /* best-effort */ }
    }
    return deleted;
  }

  /**
   * @internal
   * Retrieve credential value bypassing ACL — for internal system use only (e.g. maskSecrets).
   * P2-07: This method is NOT part of the public API and should never be called by agents.
   */
  _retrieveSystem(name: string): string | null {
    const entry = this.credentials.get(name);
    if (!entry) return null;
    try {
      const iv = Buffer.from(entry.iv, "hex");
      const decipher = createDecipheriv("aes-256-cbc", this.encryptionKey, iv);
      let decrypted = decipher.update(entry.encryptedValue, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } catch {
      return null;
    }
  }

  /** List credentials (without values) */
  list(): Array<Omit<CredentialEntry, "encryptedValue" | "iv">> {
    return Array.from(this.credentials.values()).map(({ encryptedValue, iv, ...rest }) => rest);
  }

  /** Check if a credential exists */
  has(name: string): boolean {
    return this.credentials.has(name);
  }

  get size(): number {
    return this.credentials.size;
  }

  /**
   * v3 Task 5.5：凭据保险柜 fail-fast 策略判断
   * @why 生产环境默认必须启动失败，避免临时密钥隐性丢失凭据。
   *      开发环境（NODE_ENV 非 production）默认兑底，不阻本地调试。
   *      SA_VAULT_FAIL_FAST 环境变量可显式覆盖（true/false）。
   */
  private _shouldFailFast(): boolean {
    const explicit = process.env.SA_VAULT_FAIL_FAST;
    if (explicit === "true" || explicit === "1") return true;
    if (explicit === "false" || explicit === "0") return false;
    // 默认：生产环境 fail-fast，开发环境兑底
    return process.env.NODE_ENV === "production";
  }
}
