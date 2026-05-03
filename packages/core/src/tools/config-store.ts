/**
 * ConfigStore — 非 LLM 服务的配置持久化。
 *
 * 复用 ProviderStore 的 AES-256-CBC 加密模式，存储阿里云语音、火山方舟 Seedream、
 * 浏览器自动化等外部服务的凭据和配置。
 *
 * 优先级链路：ConfigStore (设置页面) → 环境变量 (首次播种) → 默认值
 *
 * SEC-P0-02: 加密密钥由 security/encryption-key.ts 集中管理（与 provider-store 共用强校验 + LEGACY 过渡）。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { getDatabase, scheduleSave } from "../persistence/sqlite.js";
import { getEncryptionKey, decryptWithFallback } from "../security/encryption-key.js";

const logger = pino({ name: "config-store" });

// ─── AES-256-CBC 加密（与 ProviderStore 共享密钥派生方式） ──

function encrypt(text: string): { encrypted: string; iv: string } {
  if (!text) return { encrypted: "", iv: "" };
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", getEncryptionKey(), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return { encrypted, iv: iv.toString("hex") };
}

/** 使用指定 key 执行 AES 解密（底层实现）。 */
function decryptWithKey(encrypted: string, ivHex: string, key: Buffer): string {
  const iv = Buffer.from(ivHex, "hex");
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * 解密配置值 — 先试新 key，失败回退 legacy key。
 * 供 migrateKeys 使用，需要区分是否走了 legacy 路径。
 */
function decryptWithStatus(encrypted: string, ivHex: string): { plain: string; usedLegacy: boolean } {
  if (!encrypted || !ivHex) return { plain: "", usedLegacy: false };
  try {
    const { plaintext, usedLegacy } = decryptWithFallback((key) =>
      decryptWithKey(encrypted, ivHex, key),
    );
    return { plain: plaintext, usedLegacy };
  } catch {
    logger.warn("Failed to decrypt config value (even with legacy fallback)");
    return { plain: "", usedLegacy: false };
  }
}

/**
 * 读取路径的解密入口 — 只返回明文；若走了 legacy 分支则打 debug 日志，
 * 统一由 migrateKeys 在启动阶段重加密写回。
 */
function decrypt(encrypted: string, ivHex: string): string {
  const { plain, usedLegacy } = decryptWithStatus(encrypted, ivHex);
  if (usedLegacy) {
    logger.debug("Config value decrypted via SA_ENCRYPTION_KEY_LEGACY; will be re-encrypted on next migrateKeys()");
  }
  return plain;
}

/** 掩码敏感值：前3+后3 */
export function maskSecret(value: string): string {
  if (!value || value.length < 8) return value ? "***" : "";
  return value.slice(0, 3) + "***..." + value.slice(-3);
}

// ─── 服务目录（内置预定义） ──────────────────────────

export interface ServiceKeyDef {
  key: string;
  label: string;
  envKey: string;
  secret: boolean;
  default?: string;
  /** 字段说明提示，帮助用户理解该字段的来源和用途 */
  hint?: string;
  /** 获取该凭证的控制台链接（可与 service 级 website 不同） */
  helpUrl?: string;
}

export interface ServiceCatalogEntry {
  id: string;
  name: string;
  description: string;
  website?: string;
  keys: ServiceKeyDef[];
}

export const SERVICE_CATALOG: ServiceCatalogEntry[] = [
  {
    id: "aliyun_voice",
    name: "阿里云语音",
    description: "TTS 语音合成 + STT 语音识别",
    website: "https://nls-portal.console.aliyun.com/",
    keys: [
      {
        key: "access_key_id", label: "AccessKey ID", envKey: "ALIBABA_CLOUD_ACCESS_KEY_ID", secret: true,
        hint: "阿里云账号级凭证，用于签名获取临时 Token。在 RAM 访问控制台创建。",
        helpUrl: "https://ram.console.aliyun.com/manage/ak",
      },
      {
        key: "access_key_secret", label: "AccessKey Secret", envKey: "ALIBABA_CLOUD_ACCESS_KEY_SECRET", secret: true,
        hint: "与 AccessKey ID 配套使用，创建时一起生成，注意妥善保管。",
        helpUrl: "https://ram.console.aliyun.com/manage/ak",
      },
      {
        key: "appkey", label: "AppKey", envKey: "ALIBABA_CLOUD_APPKEY", secret: false,
        hint: "智能语音交互项目级凭证，在语音控制台创建项目后获取。",
        helpUrl: "https://nls-portal.console.aliyun.com/",
      },
    ],
  },
  {
    id: "ark_seedream",
    name: "火山方舟 Seedream",
    description: "AI 图片生成（文生图）",
    website: "https://console.volcengine.com/ark/",
    keys: [
      { key: "api_key", label: "API Key", envKey: "ARK_API_KEY", secret: true },
      { key: "endpoint_id", label: "Endpoint ID (推理接入点)", envKey: "ARK_ENDPOINT_ID", secret: false },
      { key: "base_url", label: "Base URL", envKey: "ARK_BASE_URL", secret: false, default: "https://ark.cn-beijing.volces.com/api/v3" },
    ],
  },
  {
    id: "browser",
    name: "浏览器自动化",
    description: "浏览器控制与截图",
    keys: [
      { key: "browser_path", label: "浏览器可执行文件路径", envKey: "BROWSER_PATH", secret: false },
      { key: "ws_endpoint", label: "WebSocket 连接地址", envKey: "BROWSER_WS_ENDPOINT", secret: false },
    ],
  },
  {
    id: "vision",
    name: "视觉分析",
    description: "图片分析与 OCR 文字识别",
    keys: [
      { key: "api_key", label: "API Key", envKey: "VISION_API_KEY", secret: true },
      { key: "base_url", label: "Base URL", envKey: "VISION_BASE_URL", secret: false,
        default: "https://ark.cn-beijing.volces.com/api/v3" },
      { key: "model", label: "模型 ID", envKey: "VISION_MODEL", secret: false },
    ],
  },
  {
    id: "runninghub",
    name: "RunningHub AI",
    description: "ComfyUI 云端工作流（视频生成 / 图片生成 / TTS）",
    website: "https://www.runninghub.com",
    keys: [
      {
        key: "api_key", label: "API Key", envKey: "RUNNINGHUB_API_KEY", secret: true,
        hint: "在 runninghub.com 注册并开通会员后获取，用于云端视频/图片/TTS 生成",
        helpUrl: "https://www.runninghub.com",
      },
    ],
  },
];

// ─── ServiceInfo（list 返回值） ────────────────────────

export interface ServiceInfo {
  id: string;
  name: string;
  description: string;
  website?: string;
  configured: boolean;
  keys: Array<{
    key: string;
    label: string;
    hasValue: boolean;
    maskedValue: string;
    hint?: string;
    helpUrl?: string;
  }>;
}

// ─── ConfigStore ─────────────────────────────────────

export class ConfigStore {
  private initialized = false;

  /** 创建 service_configs 表 */
  init(): void {
    if (this.initialized) return;
    const db = getDatabase();
    db.run(`
      CREATE TABLE IF NOT EXISTS service_configs (
        service_id TEXT NOT NULL,
        config_key TEXT NOT NULL,
        config_value TEXT DEFAULT '',
        config_iv TEXT DEFAULT '',
        is_secret INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (service_id, config_key)
      )
    `);
    scheduleSave();
    this.initialized = true;
    logger.info("ConfigStore initialized (service_configs table ready)");
  }

  /** 将环境变量播种到数据库（仅首次：DB 中无记录时写入，不覆盖设置页面的修改） */
  syncFromEnv(): void {
    for (const service of SERVICE_CATALOG) {
      for (const keyDef of service.keys) {
        const envValue = process.env[keyDef.envKey];
        if (envValue) {
          // 仅首次播种：DB 中已有该配置则跳过
          if (!this._hasRecord(service.id, keyDef.key)) {
            this.set(service.id, keyDef.key, envValue, keyDef.secret);
            logger.info({ service: service.id, key: keyDef.key }, `Seeded from env: ${keyDef.envKey}`);
          }
        }
      }
    }
  }

  /** 保存配置值（敏感值自动加密） */
  set(serviceId: string, key: string, value: string, isSecret?: boolean): void {
    const db = getDatabase();
    const now = new Date().toISOString();
    // 查找 SERVICE_CATALOG 判断是否为敏感字段
    const secret = isSecret ?? this.isSecretKey(serviceId, key);
    let storedValue = value;
    let storedIv = "";
    if (secret && value) {
      const { encrypted, iv } = encrypt(value);
      storedValue = encrypted;
      storedIv = iv;
    }
    db.run(
      `INSERT INTO service_configs (service_id, config_key, config_value, config_iv, is_secret, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(service_id, config_key) DO UPDATE SET
         config_value = excluded.config_value,
         config_iv = excluded.config_iv,
         is_secret = excluded.is_secret,
         updated_at = excluded.updated_at`,
      [serviceId, key, storedValue, storedIv, secret ? 1 : 0, now]
    );
    scheduleSave();
  }

  /** 读取配置值（自动解密敏感值） */
  get(serviceId: string, key: string): string | null {
    const db = getDatabase();
    const rows = db.exec(
      "SELECT config_value, config_iv, is_secret FROM service_configs WHERE service_id = ? AND config_key = ?",
      [serviceId, key]
    );
    if (!rows.length || !rows[0].values.length) {
      // 返回默认值（如果有）
      const keyDef = this.findKeyDef(serviceId, key);
      return keyDef?.default ?? null;
    }
    const [value, iv, isSecret] = rows[0].values[0] as [string, string, number];
    if (isSecret && iv) {
      return decrypt(value, iv);
    }
    return value || null;
  }

  /** 获取某个服务的全部配置 */
  getAll(serviceId: string): Record<string, string> {
    const db = getDatabase();
    const rows = db.exec(
      "SELECT config_key, config_value, config_iv, is_secret FROM service_configs WHERE service_id = ?",
      [serviceId]
    );
    const result: Record<string, string> = {};
    if (rows.length) {
      for (const row of rows[0].values) {
        const [key, value, iv, isSecret] = row as [string, string, string, number];
        if (isSecret && iv) {
          result[key] = decrypt(value, iv);
        } else {
          result[key] = value || "";
        }
      }
    }
    // 补充默认值
    const catalog = SERVICE_CATALOG.find(s => s.id === serviceId);
    if (catalog) {
      for (const keyDef of catalog.keys) {
        if (!(keyDef.key in result) && keyDef.default) {
          result[keyDef.key] = keyDef.default;
        }
      }
    }
    return result;
  }

  /** 删除配置 */
  delete(serviceId: string, key?: string): void {
    const db = getDatabase();
    if (key) {
      db.run("DELETE FROM service_configs WHERE service_id = ? AND config_key = ?", [serviceId, key]);
    } else {
      db.run("DELETE FROM service_configs WHERE service_id = ?", [serviceId]);
    }
    scheduleSave();
  }

  /** 列出所有服务及其配置状态 */
  listServices(): ServiceInfo[] {
    return SERVICE_CATALOG.map((service) => {
      const keys = service.keys.map((keyDef) => {
        const value = this.get(service.id, keyDef.key);
        const hasValue = !!value && value !== keyDef.default;
        return {
          key: keyDef.key,
          label: keyDef.label,
          hasValue,
          maskedValue: hasValue
            ? (keyDef.secret ? maskSecret(value!) : value!)
            : "",
          hint: keyDef.hint,
          helpUrl: keyDef.helpUrl,
        };
      });
      return {
        id: service.id,
        name: service.name,
        description: service.description,
        website: service.website,
        configured: keys.some(k => k.hasValue),
        keys,
      };
    });
  }

  // ── 内部辅助 ──

  /** 检查 DB 中是否存在指定配置记录（不受默认值影响） */
  private _hasRecord(serviceId: string, key: string): boolean {
    const db = getDatabase();
    const rows = db.exec(
      "SELECT 1 FROM service_configs WHERE service_id = ? AND config_key = ?",
      [serviceId, key]
    );
    return rows.length > 0 && rows[0].values.length > 0;
  }

  private isSecretKey(serviceId: string, key: string): boolean {
    const keyDef = this.findKeyDef(serviceId, key);
    return keyDef?.secret ?? false;
  }

  private findKeyDef(serviceId: string, key: string): ServiceKeyDef | undefined {
    const service = SERVICE_CATALOG.find(s => s.id === serviceId);
    return service?.keys.find(k => k.key === key);
  }

  /**
   * 启动期迁移 — 将用 SA_ENCRYPTION_KEY_LEGACY 能解开的敏感配置用当前新 key 重加密写回。
   * 每次启动调用一次（幂等：新 key 能直接解密的记录跳过）。
   */
  migrateKeys(): void {
    const db = getDatabase();
    const rows = db.exec(
      "SELECT service_id, config_key, config_value, config_iv, is_secret FROM service_configs WHERE is_secret = 1",
    );
    if (!rows.length) return;

    const now = new Date().toISOString();
    let migrated = 0;
    for (const row of rows[0].values) {
      const [serviceId, configKey, value, iv, isSecret] = row as [string, string, string, string, number];
      if (!isSecret || !value || !iv) continue;

      try {
        const { plain, usedLegacy } = decryptWithStatus(value, iv);
        if (!usedLegacy || !plain) continue; // 新 key 可解 or 全部解密失败，不做操作
        const { encrypted, iv: newIv } = encrypt(plain);
        db.run(
          `UPDATE service_configs SET config_value = ?, config_iv = ?, updated_at = ?
           WHERE service_id = ? AND config_key = ?`,
          [encrypted, newIv, now, serviceId, configKey],
        );
        migrated++;
      } catch (err) {
        logger.warn({ serviceId, configKey, err }, "Failed to re-encrypt config during legacy-key migration");
      }
    }

    if (migrated > 0) {
      scheduleSave();
      logger.info({ migrated }, "[migration] Service configs re-encrypted with current SA_ENCRYPTION_KEY");
    }
  }
}

// ─── .env 文件同步工具 ─────────────────────────────

/**
 * 将单个环境变量写入项目根目录的 .env 文件。
 *
 * 用于设置页面保存服务配置后，将 Key 持久化到 .env，
 * 确保 Python 子进程（video-forge / IM Gateway 等）启动时能读到。
 *
 * 策略：如果 .env 中已有该 KEY=xxx 行，则原地更新；否则追加到文件末尾。
 * 空值不写入（避免产生 KEY= 空行）。
 *
 * @param envKey   环境变量名（如 "RUNNINGHUB_API_KEY"）
 * @param value    环境变量值
 */
export function syncEnvVarToFile(envKey: string, value: string): void {
  // 空值不写入 .env，避免覆盖已有的有效值
  if (!envKey || !value) return;

  try {
    // .env 文件位于 monorepo 根目录（与 package.json 同级）
    const envPath = path.resolve(process.cwd(), ".env");

    let lines: string[] = [];
    if (fs.existsSync(envPath)) {
      lines = fs.readFileSync(envPath, "utf-8").split("\n");
    }

    // 查找已存在的行并原地更新
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      // 精确匹配 KEY= 或 KEY =（允许等号前后有空格），忽略注释行
      // 使用正则避免 RUNNINGHUB_API_KEY 误匹配 RUNNINGHUB_API_KEY_BACKUP
      if (!trimmed.startsWith("#") && /^[A-Z_]+[ ]*=/.test(trimmed)) {
        const eqIdx = trimmed.indexOf("=");
        const existingKey = trimmed.substring(0, eqIdx).trim();
        if (existingKey === envKey) {
          lines[i] = `${envKey}=${value}`;
          found = true;
          break;
        }
      }
    }

    // 未找到则追加
    if (!found) {
      // 确保最后一行是空行（如果有内容的话）
      if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
        lines.push("");
      }
      lines.push(`# RunningHub AI 视频/图片/TTS 云端生成`);
      lines.push(`${envKey}=${value}`);
    }

    // 原子写入：先写临时文件再 rename
    const tmpPath = envPath + ".tmp";
    fs.writeFileSync(tmpPath, lines.join("\n") + "\n", "utf-8");
    fs.renameSync(tmpPath, envPath);
    logger.info({ envKey }, "已同步环境变量到 .env 文件");
  } catch (err) {
    logger.warn({ err, envKey }, "同步 .env 文件失败（不影响功能，仅作为持久化兜底）");
  }
}

// ─── 全局单例 ──────────────────────────────────────

let _instance: ConfigStore | null = null;

/** 初始化 ConfigStore 全局单例（需在 initDatabase() 之后调用） */
export function initConfigStore(): ConfigStore {
  if (!_instance) {
    _instance = new ConfigStore();
    _instance.init();
    _instance.syncFromEnv();
    _instance.migrateKeys();
  }
  return _instance;
}

/** 获取 ConfigStore 全局单例 */
export function getConfigStore(): ConfigStore {
  if (!_instance) {
    // 延迟初始化兜底（正常应在 context.ts 中提前调用 initConfigStore）
    return initConfigStore();
  }
  return _instance;
}
