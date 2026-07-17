/**
 * API Key 存储 — SQLite 持久化 + 内存缓存
 *
 * 优化：
 * 1. 启动时从环境变量迁移现有 Key
 * 2. 内存缓存减少数据库查询
 * 3. WAL 模式支持多实例
 */

import { getDatabase } from "@super-agent/core";
import { randomUUID } from "node:crypto";
import pino from "pino";

// SqlJsDatabase 类型定义（从 core 包导出）
type SqlJsDatabase = any;

const logger = pino({ name: "api-key-store" });

export type Role = "admin" | "operator" | "viewer" | "agent";

export interface ApiKeyRecord {
  key: string;
  name: string;
  role: Role;
  createdAt: Date;
  lastUsedAt: Date | null;
  enabled: boolean;
}

export class ApiKeyStore {
  private db: SqlJsDatabase;
  private cache: Map<string, ApiKeyRecord> = new Map();
  private cacheExpiry: number = 60000; // 1 分钟缓存
  private lastCacheTime: number = 0;

  constructor() {
    this.db = getDatabase();
    this.ensureTable();
    this.migrateFromEnv();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer', 'agent')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_enabled ON api_keys(enabled);
    `);
  }

  /** 从环境变量迁移现有 Key（仅首次启动时执行） */
  private migrateFromEnv(): void {
    const raw = process.env.SUPER_AGENT_API_KEYS ?? "";
    if (!raw) return;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO api_keys (key, name, role) VALUES (?, ?, ?)
    `);

    for (const entry of raw.split(",").filter(Boolean)) {
      const [name, key, role] = entry.split(":");
      if (name && key) {
        stmt.run(key, name, (role as Role) ?? "operator");
        logger.info({ name, role }, "Migrated API key from env");
      }
    }
  }

  /** 刷新缓存（1 分钟过期） */
  private refreshCache(): void {
    const now = Date.now();
    if (now - this.lastCacheTime < this.cacheExpiry) return;

    const stmt = this.db.prepare(`
      SELECT key, name, role, created_at, last_used_at, enabled
      FROM api_keys WHERE enabled = 1
    `);

    this.cache.clear();
    for (const row of stmt.all() as any[]) {
      this.cache.set(row.key, {
        key: row.key,
        name: row.name,
        role: row.role as Role,
        createdAt: new Date(row.created_at),
        lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
        enabled: row.enabled === 1,
      });
    }
    this.lastCacheTime = now;
  }

  validate(key: string): ApiKeyRecord | null {
    this.refreshCache();
    const record = this.cache.get(key);
    if (!record) return null;

    // 异步更新 last_used_at（不阻塞响应）
    setImmediate(() => {
      this.db.prepare(`
        UPDATE api_keys SET last_used_at = datetime('now') WHERE key = ?
      `).run(key);
    });

    return record;
  }

  list(): ApiKeyRecord[] {
    const stmt = this.db.prepare(`
      SELECT key, name, role, created_at, last_used_at, enabled
      FROM api_keys ORDER BY created_at DESC
    `);
    return (stmt.all() as any[]).map((row) => ({
      ...row,
      key: row.key.slice(0, 8) + "...",
      createdAt: new Date(row.created_at),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
      enabled: row.enabled === 1,
    }));
  }

  create(name: string, role: Role): ApiKeyRecord {
    const key = `sk-${randomUUID().replace(/-/g, "")}`;
    this.db.prepare(`
      INSERT INTO api_keys (key, name, role) VALUES (?, ?, ?)
    `).run(key, name, role);

    // 清除缓存
    this.lastCacheTime = 0;

    return {
      key,
      name,
      role,
      createdAt: new Date(),
      lastUsedAt: null,
      enabled: true,
    };
  }

  revoke(key: string): boolean {
    const result = this.db.prepare(`
      UPDATE api_keys SET enabled = 0 WHERE key = ?
    `).run(key);
    this.lastCacheTime = 0;
    return result.changes > 0;
  }

  delete(key: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM api_keys WHERE key = ?
    `).run(key);
    this.lastCacheTime = 0;
    return result.changes > 0;
  }
}

// 单例
let apiKeyStore: ApiKeyStore | null = null;

export function getApiKeyStore(): ApiKeyStore {
  if (!apiKeyStore) {
    apiKeyStore = new ApiKeyStore();
  }
  return apiKeyStore;
}
