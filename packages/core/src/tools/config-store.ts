/**
 * ConfigStore — 非 LLM 服务的配置持久化。
 *
 * 复用 ProviderStore 的 AES-256-CBC 加密模式，存储阿里云语音、火山方舟 Seedream、
 * 浏览器自动化等外部服务的凭据和配置。
 *
 * 优先级链路：ConfigStore → 环境变量 → 默认值
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import pino from "pino";
import { getDatabase, scheduleSave } from "../persistence/sqlite.js";

const logger = pino({ name: "config-store" });

// ─── AES-256-CBC 加密（与 ProviderStore 共享密钥派生方式） ──

const SA_KEY_FROM_ENV = process.env.SA_ENCRYPTION_KEY;
const ENCRYPTION_KEY = createHash("sha256")
  .update(SA_KEY_FROM_ENV ?? "super-agent-default-encryption-key-v1")
  .digest();

function encrypt(text: string): { encrypted: string; iv: string } {
  if (!text) return { encrypted: "", iv: "" };
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return { encrypted, iv: iv.toString("hex") };
}

function decrypt(encrypted: string, ivHex: string): string {
  if (!encrypted || !ivHex) return "";
  try {
    const iv = Buffer.from(ivHex, "hex");
    const decipher = createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    logger.warn("Failed to decrypt config value");
    return "";
  }
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

  /** 将环境变量同步到数据库（环境变量优先级最高） */
  syncFromEnv(): void {
    for (const service of SERVICE_CATALOG) {
      for (const keyDef of service.keys) {
        const envValue = process.env[keyDef.envKey];
        if (envValue) {
          this.set(service.id, keyDef.key, envValue, keyDef.secret);
          logger.info({ service: service.id, key: keyDef.key }, `Synced from env: ${keyDef.envKey}`);
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

  private isSecretKey(serviceId: string, key: string): boolean {
    const keyDef = this.findKeyDef(serviceId, key);
    return keyDef?.secret ?? false;
  }

  private findKeyDef(serviceId: string, key: string): ServiceKeyDef | undefined {
    const service = SERVICE_CATALOG.find(s => s.id === serviceId);
    return service?.keys.find(k => k.key === key);
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
