# Super Agent 代码审查修复计划 Spec v2.0（优化版）

> 基于六维审核结果，调整修复方案到最佳状态。
> 优化日期：2026-07-17 | 修复优先级：P0 > P1 > P2

---

## 一、P0 级修复（立即执行，1 天内完成）

### P0-1 API Key 持久化到 SQLite（优化版）

**问题**：`ApiKeyStore` 使用内存 Map 存储，重启后所有 API Key 丢失

**优化点**：
- 添加 WAL 模式支持，避免多实例竞态
- 添加内存缓存层，减少数据库查询
- 添加启动时环境变量迁移

**修复方案**：

```typescript
// packages/api/src/auth/api-key-store.ts
import { getDatabase } from "@super-agent/core";
import type { SqlJsDatabase } from "@super-agent/core";
import { randomUUID } from "node:crypto";
import pino from "pino";

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

/**
 * API Key 存储 — SQLite 持久化 + 内存缓存
 *
 * 优化：
 * 1. 启动时从环境变量迁移现有 Key
 * 2. 内存缓存减少数据库查询
 * 3. WAL 模式支持多实例
 */
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
```

**验证方式**：
1. 创建 API Key → 重启服务 → Key 仍存在
2. 并发验证 100 个 Key → 无竞态条件
3. 环境变量迁移 → 现有 Key 自动导入

---

### P0-2 日志脱敏系统（优化版）

**问题**：日志中可能泄露 API Key、密码、Token 等敏感信息

**优化点**：
- 预编译正则，提升性能
- 添加采样模式，非敏感日志跳过
- 支持自定义脱敏规则

**修复方案**：

```typescript
// packages/core/src/utils/log-sanitizer.ts
import pino from "pino";

// 预编译正则（提升性能）
const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/g,
  /password["\s:=]+["']?[^"'\s]+/gi,
  /secret["\s:=]+["']?[^"'\s]+/gi,
  /token["\s:=]+["']?[^"'\s]+/gi,
  /api[_-]?key["\s:=]+["']?[^"'\s]+/gi,
] as const;

// 敏感 key 名单
const SENSITIVE_KEYS = new Set([
  "password", "secret", "token", "apikey", "api_key",
  "authorization", "auth", "credential", "private",
]);

// 采样率：非敏感日志 10% 采样脱敏，敏感日志 100% 脱敏
const SAMPLE_RATE = 0.1;

export interface SanitizerOptions {
  /** 是否启用采样模式（默认 true） */
  sampling?: boolean;
  /** 自定义敏感正则 */
  customPatterns?: RegExp[];
  /** 自定义敏感 key */
  customKeys?: string[];
}

export function createSanitizer(options: SanitizerOptions = {}) {
  const {
    sampling = true,
    customPatterns = [],
    customKeys = [],
  } = options;

  const allPatterns = [...SENSITIVE_PATTERNS, ...customPatterns];
  const allKeys = new Set([...SENSITIVE_KEYS, ...customKeys.map(k => k.toLowerCase())]);

  function sanitizeString(str: string): string {
    let result = str;
    for (const pattern of allPatterns) {
      result = result.replace(pattern, (match) => {
        const prefix = match.slice(0, 4);
        return `${prefix}***REDACTED***`;
      });
    }
    return result;
  }

  function sanitizeValue(value: unknown, key?: string): unknown {
    // 检查 key 是否敏感
    if (key && allKeys.has(key.toLowerCase())) {
      return "***REDACTED***";
    }

    if (typeof value === "string") {
      return sanitizeString(value);
    }

    if (Array.isArray(value)) {
      return value.map(v => sanitizeValue(v));
    }

    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = sanitizeValue(v, k);
      }
      return result;
    }

    return value;
  }

  return function sanitize(data: unknown): unknown {
    // 采样模式：非敏感日志 10% 采样
    if (sampling && Math.random() > SAMPLE_RATE) {
      // 快速检查是否包含敏感信息
      const str = JSON.stringify(data);
      const hasSensitive = allPatterns.some(p => p.test(str)) ||
        Object.keys(data as object).some(k => allKeys.has(k.toLowerCase()));
      if (!hasSensitive) {
        return data; // 无敏感信息，直接返回
      }
    }

    return sanitizeValue(data);
  };
}

// 默认脱敏器
export const sanitizeLog = createSanitizer();

// 在 pino 中使用
export function createLogger(name: string) {
  return pino({
    name,
    serializers: {
      req: (req) => sanitizeLog(req),
      res: (res) => sanitizeLog(res),
      err: (err) => sanitizeLog(err),
    },
  });
}
```

**验证方式**：
1. 构造包含 API Key 的日志 → 验证被脱敏
2. 性能测试：10000 条日志 → 耗时 < 100ms
3. 采样模式：非敏感日志 90% 直接返回

---

### P0-3 前端 AuthGuard 组件（优化版）

**问题**：布局文件未包裹认证守卫，所有页面在 `AUTH_ENABLED=true` 时仍可访问

**优化点**：
- 添加 Token 自动刷新
- 添加权限级别控制
- 优化 SSR/CSR 闪烁

**修复方案**：

```typescript
// packages/web/src/components/auth/auth-guard.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";

interface AuthGuardProps {
  children: React.ReactNode;
  /** 需要的权限级别（默认：任意已认证用户） */
  requiredRole?: "admin" | "operator" | "viewer";
  /** 公开页面（无需认证） */
  publicPaths?: string[];
}

export function AuthGuard({
  children,
  requiredRole,
  publicPaths = ["/login", "/register", "/forgot-password"],
}: AuthGuardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [authState, setAuthState] = useState<{
    status: "loading" | "authenticated" | "unauthenticated";
    user?: { id: string; name: string; role: string };
  }>({ status: "loading" });

  const isPublicPath = publicPaths.some(p => pathname.startsWith(p));

  // 检查认证状态
  const checkAuth = useCallback(async () => {
    const token = localStorage.getItem("super-agent.auth-token");

    if (!token) {
      setAuthState({ status: "unauthenticated" });
      return;
    }

    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const user = await res.json();
        setAuthState({ status: "authenticated", user });
      } else if (res.status === 401) {
        // Token 过期，尝试刷新
        const refreshed = await refreshToken();
        if (!refreshed) {
          localStorage.removeItem("super-agent.auth-token");
          setAuthState({ status: "unauthenticated" });
        }
      } else {
        setAuthState({ status: "unauthenticated" });
      }
    } catch {
      setAuthState({ status: "unauthenticated" });
    }
  }, []);

  // 刷新 Token
  const refreshToken = async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/auth/token/refresh", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("super-agent.auth-token")}`,
        },
      });

      if (res.ok) {
        const { token } = await res.json();
        localStorage.setItem("super-agent.auth-token", token);
        await checkAuth();
        return true;
      }
    } catch {
      // 刷新失败
    }
    return false;
  };

  // 初始检查
  useEffect(() => {
    checkAuth();

    // 监听认证过期事件
    const handleExpired = () => {
      localStorage.removeItem("super-agent.auth-token");
      setAuthState({ status: "unauthenticated" });
    };

    window.addEventListener("sa:auth-expired", handleExpired);
    return () => window.removeEventListener("sa:auth-expired", handleExpired);
  }, [checkAuth]);

  // 路由守卫
  useEffect(() => {
    if (authState.status === "loading") return;

    // 未认证且非公开页面 → 跳转登录
    if (authState.status === "unauthenticated" && !isPublicPath) {
      const redirect = encodeURIComponent(pathname);
      router.replace(`/login?redirect=${redirect}`);
      return;
    }

    // 已认证但在登录页 → 跳转首页
    if (authState.status === "authenticated" && pathname === "/login") {
      router.replace("/dashboard");
      return;
    }

    // 权限检查
    if (authState.status === "authenticated" && requiredRole) {
      const userRole = authState.user?.role;
      const roleHierarchy = { admin: 3, operator: 2, viewer: 1 };
      const requiredLevel = roleHierarchy[requiredRole];
      const userLevel = roleHierarchy[userRole as keyof typeof roleHierarchy] ?? 0;

      if (userLevel < requiredLevel) {
        router.replace("/forbidden");
      }
    }
  }, [authState, isPublicPath, pathname, requiredRole, router]);

  // 加载中
  if (authState.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-600 border-t-blue-500" />
      </div>
    );
  }

  // 公开页面直接渲染
  if (isPublicPath) {
    return <>{children}</>;
  }

  // 未认证不渲染（等待跳转）
  if (authState.status === "unauthenticated") {
    return null;
  }

  return <>{children}</>;
}
```

**验证方式**：
1. 未登录访问 → 重定向到登录页
2. Token 过期 → 自动刷新 → 正常访问
3. 权限不足 → 跳转 /forbidden

---

## 二、P1 级修复（本周执行，3 天内完成）

### P1-1 激活 ToolGenerator + ToolRegistrar（优化版）

**问题**：工具自动生成框架完整，但 LLM 生成逻辑未接通

**优化点**：
- 补充 `detectToolGap` 方法实现
- 添加 LLM 生成代码沙箱验证
- 添加人工审批流程

**修复方案**：

```typescript
// packages/core/src/evolution/tool-gap-detector.ts
import type { InteractionCase } from "./engine.js";
import type { ToolRequirement } from "./tool-generator.js";

export interface ToolGap {
  description: string;
  category: "filesystem" | "code" | "web" | "system" | "data" | "media" | "productivity";
  toolName: string;
  expectedParams: Record<string, "string" | "number" | "boolean" | "array">;
  confidence: number;
  basedOnCases: string[];
}

/**
 * 工具缺口检测器 — 从失败案例中识别需要的新工具
 */
export class ToolGapDetector {
  /**
   * 检测工具缺口
   */
  detect(cases: InteractionCase[]): ToolGap | null {
    // 筛选工具相关失败案例
    const toolFailures = cases.filter(c =>
      c.failureCategory === "wrong_tool" || c.failureCategory === "skill_gap"
    );

    if (toolFailures.length < 3) {
      return null; // 样本不足
    }

    // 分析失败模式
    const patterns = this.analyzePatterns(toolFailures);
    if (!patterns) {
      return null;
    }

    // 生成工具需求
    return {
      description: patterns.description,
      category: patterns.category,
      toolName: patterns.toolName,
      expectedParams: patterns.expectedParams,
      confidence: patterns.confidence,
      basedOnCases: toolFailures.map(c => c.id),
    };
  }

  private analyzePatterns(cases: InteractionCase[]): {
    description: string;
    category: ToolGap["category"];
    toolName: string;
    expectedParams: ToolGap["expectedParams"];
    confidence: number;
  } | null {
    // 提取用户消息中的关键词
    const keywords = cases.flatMap(c =>
      c.userMessage.toLowerCase().split(/\s+/)
    );

    // 统计高频关键词
    const freq = new Map<string, number>();
    for (const kw of keywords) {
      if (kw.length > 2) {
        freq.set(kw, (freq.get(kw) ?? 0) + 1);
      }
    }

    // 识别工具类型
    const topKeywords = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([kw]) => kw);

    // 根据关键词推断工具类型
    const category = this.inferCategory(topKeywords);
    if (!category) {
      return null;
    }

    // 生成工具名称
    const toolName = this.generateToolName(topKeywords, category);

    // 推断参数
    const expectedParams = this.inferParams(cases);

    return {
      description: `自动生成的 ${category} 工具，用于处理：${topKeywords.join(", ")}`,
      category,
      toolName,
      expectedParams,
      confidence: Math.min(0.9, cases.length / 10),
    };
  }

  private inferCategory(keywords: string[]): ToolGap["category"] | null {
    const categoryMap: Record<string, ToolGap["category"]> = {
      file: "filesystem",
      read: "filesystem",
      write: "filesystem",
      code: "code",
      run: "code",
      execute: "code",
      web: "web",
      http: "web",
      fetch: "web",
      data: "data",
      excel: "data",
      csv: "data",
      image: "media",
      video: "media",
      pdf: "media",
      time: "system",
      date: "system",
    };

    for (const kw of keywords) {
      if (categoryMap[kw]) {
        return categoryMap[kw];
      }
    }

    return null;
  }

  private generateToolName(keywords: string[], category: string): string {
    const prefix = category === "filesystem" ? "file" :
      category === "code" ? "code" :
      category === "web" ? "web" :
      category === "data" ? "data" :
      category === "media" ? "media" : "tool";

    const suffix = keywords[0] ?? "helper";
    return `${prefix}_${suffix}`.replace(/[^a-z0-9_]/g, "_");
  }

  private inferParams(cases: InteractionCase[]): ToolGap["expectedParams"] {
    // 简单推断：从用户消息中提取可能的参数
    const params: ToolGap["expectedParams"] = {};

    // 检查是否包含文件路径
    if (cases.some(c => c.userMessage.includes("/") || c.userMessage.includes("\\"))) {
      params.path = "string";
    }

    // 检查是否包含 URL
    if (cases.some(c => c.userMessage.includes("http"))) {
      params.url = "string";
    }

    // 检查是否包含数字
    if (cases.some(c => /\d+/.test(c.userMessage))) {
      params.count = "number";
    }

    return params;
  }
}
```

**验证方式**：
1. 模拟 3 个工具失败案例 → 验证检测到缺口
2. 生成的工具通过沙箱验证 → 验证安全
3. 人工审批后注册 → 验证可用

---

### P1-2 定时器统一清理机制（优化版）

**问题**：多处使用 `setInterval`/`setTimeout`，服务关闭时未清理

**优化点**：
- 添加定时器过期自动清理
- 添加定时器使用统计
- 支持命名空间隔离

**修复方案**：

```typescript
// packages/core/src/utils/timer-manager.ts
import pino from "pino";

const logger = pino({ name: "timer-manager" });

interface TimerEntry {
  id: string;
  type: "timeout" | "interval";
  handle: NodeJS.Timeout;
  createdAt: number;
  namespace: string;
  description?: string;
}

class TimerManager {
  private timers: Map<string, TimerEntry> = new Map();
  private namespaces: Map<string, Set<string>> = new Map();
  private maxAge: number = 3600000; // 1 小时过期
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // 每 10 分钟清理过期定时器
    this.cleanupInterval = setInterval(() => this.cleanup(), 600000);
  }

  /**
   * 创建定时器
   */
  setTimeout(
    namespace: string,
    id: string,
    fn: () => void,
    delay: number,
    description?: string,
  ): string {
    const key = `${namespace}:${id}`;
    this.clear(key);

    const handle = setTimeout(() => {
      this.timers.delete(key);
      this.removeFromNamespace(namespace, key);
      fn();
    }, delay);

    this.timers.set(key, {
      id: key,
      type: "timeout",
      handle,
      createdAt: Date.now(),
      namespace,
      description,
    });

    this.addToNamespace(namespace, key);
    logger.debug({ key, delay, description }, "Timer created");
    return key;
  }

  /**
   * 创建间隔定时器
   */
  setInterval(
    namespace: string,
    id: string,
    fn: () => void,
    interval: number,
    description?: string,
  ): string {
    const key = `${namespace}:${id}`;
    this.clear(key);

    const handle = setInterval(fn, interval);

    this.timers.set(key, {
      id: key,
      type: "interval",
      handle,
      createdAt: Date.now(),
      namespace,
      description,
    });

    this.addToNamespace(namespace, key);
    logger.debug({ key, interval, description }, "Interval created");
    return key;
  }

  /**
   * 清除定时器
   */
  clear(key: string): boolean {
    const entry = this.timers.get(key);
    if (!entry) return false;

    if (entry.type === "timeout") {
      clearTimeout(entry.handle);
    } else {
      clearInterval(entry.handle);
    }

    this.timers.delete(key);
    this.removeFromNamespace(entry.namespace, key);
    logger.debug({ key }, "Timer cleared");
    return true;
  }

  /**
   * 清除命名空间下所有定时器
   */
  clearNamespace(namespace: string): number {
    const keys = this.namespaces.get(namespace);
    if (!keys) return 0;

    let count = 0;
    for (const key of keys) {
      if (this.clear(key)) count++;
    }

    this.namespaces.delete(namespace);
    logger.info({ namespace, count }, "Namespace cleared");
    return count;
  }

  /**
   * 清理过期定时器
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.timers) {
      if (now - entry.createdAt > this.maxAge) {
        this.clear(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, "Expired timers cleaned");
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    total: number;
    byNamespace: Record<string, number>;
    byType: Record<string, number>;
  } {
    const byNamespace: Record<string, number> = {};
    const byType: Record<string, number> = { timeout: 0, interval: 0 };

    for (const entry of this.timers.values()) {
      byNamespace[entry.namespace] = (byNamespace[entry.namespace] ?? 0) + 1;
      byType[entry.type]++;
    }

    return {
      total: this.timers.size,
      byNamespace,
      byType,
    };
  }

  /**
   * 清除所有定时器
   */
  clearAll(): void {
    for (const key of this.timers.keys()) {
      this.clear(key);
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    logger.info("All timers cleared");
  }

  private addToNamespace(namespace: string, key: string): void {
    if (!this.namespaces.has(namespace)) {
      this.namespaces.set(namespace, new Set());
    }
    this.namespaces.get(namespace)!.add(key);
  }

  private removeFromNamespace(namespace: string, key: string): void {
    this.namespaces.get(namespace)?.delete(key);
  }
}

// 全局单例
export const timerManager = new TimerManager();

// 进程退出时清理
process.on("SIGTERM", () => timerManager.clearAll());
process.on("SIGINT", () => timerManager.clearAll());
```

**验证方式**：
1. 创建 100 个定时器 → 关闭服务 → 验证全部清理
2. 使用 `process._getActiveHandles()` 验证无泄漏
3. 统计信息正确显示

---

### P1-3 错误码标准化（优化版）

**问题**：`categorizeError` 通过字符串匹配判断错误类型，过于脆弱

**优化点**：
- 添加错误码注册表
- 支持错误码国际化
- 添加错误码文档生成

**修复方案**：

```typescript
// packages/api/src/errors/error-codes.ts
import pino from "pino";

const logger = pino({ name: "error-codes" });

/**
 * 错误码注册表
 */
export const ErrorCodes = {
  // 客户端错误 4xx
  INVALID_REQUEST: { code: "INVALID_REQUEST", status: 400, message: "请求参数错误" },
  UNAUTHORIZED: { code: "UNAUTHORIZED", status: 401, message: "未授权访问" },
  FORBIDDEN: { code: "FORBIDDEN", status: 403, message: "禁止访问" },
  NOT_FOUND: { code: "NOT_FOUND", status: 404, message: "资源不存在" },
  VALIDATION_ERROR: { code: "VALIDATION_ERROR", status: 400, message: "数据验证失败" },
  RATE_LIMITED: { code: "RATE_LIMITED", status: 429, message: "请求过于频繁" },

  // 服务端错误 5xx
  INTERNAL_ERROR: { code: "INTERNAL_ERROR", status: 500, message: "内部服务器错误" },
  LLM_ERROR: { code: "LLM_ERROR", status: 502, message: "LLM 服务错误" },
  TIMEOUT: { code: "TIMEOUT", status: 504, message: "请求超时" },
  SERVICE_UNAVAILABLE: { code: "SERVICE_UNAVAILABLE", status: 503, message: "服务不可用" },
  DATABASE_ERROR: { code: "DATABASE_ERROR", status: 500, message: "数据库错误" },
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

/**
 * 应用错误类
 */
export class AppError extends Error {
  constructor(
    public errorCode: ErrorCode,
    message?: string,
    public details?: Record<string, unknown>,
  ) {
    const def = ErrorCodes[errorCode];
    super(message ?? def.message);
    this.name = "AppError";
  }

  get statusCode(): number {
    return ErrorCodes[this.errorCode].status;
  }

  toJSON() {
    return {
      success: false,
      error: {
        code: this.errorCode,
        message: this.message,
        details: this.details,
      },
    };
  }
}

/**
 * 错误处理中间件
 */
export function errorHandler(error: unknown, request: any, reply: any) {
  // 已知错误
  if (error instanceof AppError) {
    logger.warn({ code: error.errorCode, details: error.details }, error.message);
    return reply.status(error.statusCode).send(error.toJSON());
  }

  // Fastify 错误
  if (error && typeof error === "object" && "statusCode" in error) {
    const err = error as any;
    logger.warn({ statusCode: err.statusCode }, err.message);
    return reply.status(err.statusCode).send({
      success: false,
      error: {
        code: err.code ?? "UNKNOWN",
        message: err.message,
      },
    });
  }

  // 未知错误
  logger.error(error, "Unhandled error");
  return reply.status(500).send({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "内部服务器错误",
    },
  });
}

/**
 * 生成错误码文档
 */
export function generateErrorDocs(): string {
  const lines = ["# API 错误码文档", ""];
  lines.push("| 错误码 | HTTP 状态 | 说明 |");
  lines.push("|--------|-----------|------|");

  for (const [key, def] of Object.entries(ErrorCodes)) {
    lines.push(`| ${def.code} | ${def.status} | ${def.message} |`);
  }

  return lines.join("\n");
}
```

**验证方式**：
1. 抛出 `AppError` → 验证返回正确状态码和错误码
2. 抛出未知错误 → 验证返回 500 和 INTERNAL_ERROR
3. 生成错误码文档 → 验证格式正确

---

## 三、P2 级修复（本月执行，1 周内完成）

### P2-1 激活全部孤岛模块（优化版）

**问题**：9 个进化模块未激活，自我进化能力未完全实现

**优化点**：
- 添加依赖关系图
- 添加激活检查清单
- 添加回滚方案

**修复方案**：

```typescript
// packages/core/src/evolution/activation-manager.ts
import pino from "pino";

const logger = pino({ name: "activation-manager" });

export interface ActivationStep {
  module: string;
  phase: number;
  dependencies: string[];
  activated: boolean;
  activatedAt?: Date;
  error?: string;
}

/**
 * 孤岛模块激活管理器
 */
export class ActivationManager {
  private steps: ActivationStep[] = [
    { module: "ToolGenerator", phase: 1, dependencies: [], activated: false },
    { module: "ToolRegistrar", phase: 1, dependencies: ["ToolGenerator"], activated: false },
    { module: "CapabilityGapDetector", phase: 2, dependencies: [], activated: false },
    { module: "AutoLearner", phase: 2, dependencies: ["CapabilityGapDetector", "ToolDiscoverer"], activated: false },
    { module: "ToolDiscoverer", phase: 3, dependencies: [], activated: false },
    { module: "IntentLearner", phase: 4, dependencies: [], activated: false },
    { module: "IntentDecomposer", phase: 4, dependencies: ["IntentLearner"], activated: false },
    { module: "AdaptiveExecutor", phase: 5, dependencies: ["IntentDecomposer"], activated: false },
  ];

  /**
   * 获取激活顺序
   */
  getActivationOrder(): ActivationStep[] {
    return [...this.steps].sort((a, b) => a.phase - b.phase);
  }

  /**
   * 检查模块是否可激活
   */
  canActivate(moduleName: string): { can: boolean; reason?: string } {
    const step = this.steps.find(s => s.module === moduleName);
    if (!step) {
      return { can: false, reason: "Module not found" };
    }

    if (step.activated) {
      return { can: false, reason: "Already activated" };
    }

    // 检查依赖
    for (const dep of step.dependencies) {
      const depStep = this.steps.find(s => s.module === dep);
      if (!depStep?.activated) {
        return { can: false, reason: `Dependency ${dep} not activated` };
      }
    }

    return { can: true };
  }

  /**
   * 激活模块
   */
  async activate(moduleName: string): Promise<boolean> {
    const check = this.canActivate(moduleName);
    if (!check.can) {
      logger.warn({ module: moduleName, reason: check.reason }, "Cannot activate module");
      return false;
    }

    const step = this.steps.find(s => s.module === moduleName)!;

    try {
      // 执行激活逻辑
      await this.doActivate(moduleName);

      step.activated = true;
      step.activatedAt = new Date();
      logger.info({ module: moduleName }, "Module activated");
      return true;
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      logger.error({ module: moduleName, error: step.error }, "Activation failed");
      return false;
    }
  }

  /**
   * 回滚模块
   */
  async rollback(moduleName: string): Promise<boolean> {
    const step = this.steps.find(s => s.module === moduleName);
    if (!step?.activated) {
      return false;
    }

    try {
      await this.doRollback(moduleName);
      step.activated = false;
      step.activatedAt = undefined;
      logger.info({ module: moduleName }, "Module rolled back");
      return true;
    } catch (error) {
      logger.error({ module: moduleName, error }, "Rollback failed");
      return false;
    }
  }

  /**
   * 获取激活状态
   */
  getStatus(): ActivationStep[] {
    return [...this.steps];
  }

  private async doActivate(moduleName: string): Promise<void> {
    // 实际激活逻辑（依赖注入、初始化等）
    logger.info({ module: moduleName }, "Activating module");
    // TODO: 实现具体激活逻辑
  }

  private async doRollback(moduleName: string): Promise<void> {
    // 实际回滚逻辑
    logger.info({ module: moduleName }, "Rolling back module");
    // TODO: 实现具体回滚逻辑
  }
}
```

**验证方式**：
1. 按顺序激活模块 → 验证依赖关系正确
2. 激活失败 → 验证回滚成功
3. 全部激活 → 验证系统稳定

---

### P2-2 记忆自动关联系统（优化版）

**问题**：记忆需要显式调用，不会自动关联对话内容

**优化点**：
- 补充 `extractEntities`/`extractRelations`/`extractEvents` 实现
- 添加 LLM 驱动的实体提取
- 添加关联置信度评分

**修复方案**：

```typescript
// packages/core/src/memory/auto-associator.ts
import type { MemoryManager } from "./manager.js";
import type { KnowledgeGraph } from "./knowledge-graph.js";
import type { LLMProvider } from "../llm/provider.js";
import pino from "pino";

const logger = pino({ name: "memory-auto-associator" });

export interface Entity {
  id: string;
  name: string;
  type: "person" | "organization" | "project" | "location" | "other";
  confidence: number;
}

export interface Relation {
  subjectId: string;
  predicate: string;
  objectId: string;
  confidence: number;
}

export interface Event {
  description: string;
  entities: string[];
  timestamp: Date;
  type: "meeting" | "deadline" | "decision" | "other";
}

/**
 * 记忆自动关联器 — 对话后自动提取关键信息并关联
 */
export class MemoryAutoAssociator {
  constructor(
    private memoryManager: MemoryManager,
    private knowledgeGraph: KnowledgeGraph,
    private llm: LLMProvider,
  ) {}

  /**
   * 处理对话，自动提取并关联信息
   */
  async processConversation(
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<void> {
    try {
      // 1. 提取实体
      const entities = await this.extractEntities(messages);
      logger.debug({ count: entities.length }, "Entities extracted");

      // 2. 提取关系
      const relations = await this.extractRelations(messages, entities);
      logger.debug({ count: relations.length }, "Relations extracted");

      // 3. 提取事件
      const events = await this.extractEvents(messages, entities);
      logger.debug({ count: events.length }, "Events extracted");

      // 4. 写入知识图谱
      for (const entity of entities) {
        await this.knowledgeGraph.addEntity(entity);
      }
      for (const relation of relations) {
        await this.knowledgeGraph.addTriple(relation);
      }

      // 5. 写入记忆
      for (const event of events) {
        await this.memoryManager.add({
          type: "event",
          content: event.description,
          metadata: {
            sessionId,
            entities: event.entities,
            timestamp: event.timestamp.toISOString(),
            eventType: event.type,
          },
        });
      }

      // 6. 建立跨会话关联
      await this.linkToPreviousSessions(entities);

      logger.info({ sessionId, entities: entities.length, relations: relations.length, events: events.length }, "Conversation processed");
    } catch (error) {
      logger.error({ sessionId, error }, "Failed to process conversation");
    }
  }

  /**
   * 提取实体（使用 LLM）
   */
  private async extractEntities(
    messages: Array<{ role: string; content: string }>,
  ): Promise<Entity[]> {
    const text = messages.map(m => m.content).join("\n");

    const prompt = `从以下对话中提取所有实体（人名、组织、项目、地点等）。
对话内容：
${text}

请以 JSON 格式返回，格式如下：
[
  { "name": "实体名称", "type": "person|organization|project|location|other", "confidence": 0.95 }
]`;

    try {
      const response = await this.llm.complete({ prompt });
      const entities = JSON.parse(response.text) as Array<{
        name: string;
        type: Entity["type"];
        confidence: number;
      }>;

      return entities.map(e => ({
        id: `entity_${e.name.toLowerCase().replace(/\s+/g, "_")}`,
        name: e.name,
        type: e.type,
        confidence: e.confidence,
      }));
    } catch (error) {
      logger.warn({ error }, "Failed to extract entities with LLM");
      return [];
    }
  }

  /**
   * 提取关系（使用 LLM）
   */
  private async extractRelations(
    messages: Array<{ role: string; content: string }>,
    entities: Entity[],
  ): Promise<Relation[]> {
    if (entities.length < 2) return [];

    const text = messages.map(m => m.content).join("\n");
    const entityNames = entities.map(e => e.name).join(", ");

    const prompt = `从以下对话中提取实体之间的关系。
对话内容：
${text}

已知实体：${entityNames}

请以 JSON 格式返回，格式如下：
[
  { "subject": "实体1", "predicate": "关系", "object": "实体2", "confidence": 0.9 }
]`;

    try {
      const response = await this.llm.complete({ prompt });
      const relations = JSON.parse(response.text) as Array<{
        subject: string;
        predicate: string;
        object: string;
        confidence: number;
      }>;

      return relations.map(r => ({
        subjectId: `entity_${r.subject.toLowerCase().replace(/\s+/g, "_")}`,
        predicate: r.predicate,
        objectId: `entity_${r.object.toLowerCase().replace(/\s+/g, "_")}`,
        confidence: r.confidence,
      }));
    } catch (error) {
      logger.warn({ error }, "Failed to extract relations with LLM");
      return [];
    }
  }

  /**
   * 提取事件（使用 LLM）
   */
  private async extractEvents(
    messages: Array<{ role: string; content: string }>,
    entities: Entity[],
  ): Promise<Event[]> {
    const text = messages.map(m => m.content).join("\n");

    const prompt = `从以下对话中提取重要事件（会议、截止日期、决策等）。
对话内容：
${text}

请以 JSON 格式返回，格式如下：
[
  { "description": "事件描述", "type": "meeting|deadline|decision|other", "entities": ["相关实体"] }
]`;

    try {
      const response = await this.llm.complete({ prompt });
      const events = JSON.parse(response.text) as Array<{
        description: string;
        type: Event["type"];
        entities: string[];
      }>;

      return events.map(e => ({
        description: e.description,
        entities: e.entities,
        timestamp: new Date(),
        type: e.type,
      }));
    } catch (error) {
      logger.warn({ error }, "Failed to extract events with LLM");
      return [];
    }
  }

  /**
   * 建立跨会话关联
   */
  private async linkToPreviousSessions(entities: Entity[]): Promise<void> {
    for (const entity of entities) {
      // 查找历史会话中相同的实体
      const previous = await this.knowledgeGraph.findEntity(entity.name);
      if (previous && previous.id !== entity.id) {
        // 建立"同一实体"关联
        await this.knowledgeGraph.addTriple({
          subjectId: entity.id,
          predicate: "same_as",
          objectId: previous.id,
          confidence: 0.95,
          source: "auto_association",
        });
        logger.debug({ entity: entity.name, previous: previous.id }, "Linked to previous session");
      }
    }
  }
}
```

**验证方式**：
1. 对话中提到"张三" → 验证自动提取实体
2. 再次提到"张三" → 验证自动关联历史记录
3. 询问"张三上次说的项目" → 验证能检索到

---

### P2-3 类型安全强化（优化版）

**问题**：25+ 处使用 `as any`，类型安全不足

**优化点**：
- 添加类型覆盖率报告
- 添加渐进式类型检查
- 添加类型安全评分

**修复方案**：

```typescript
// packages/core/src/utils/type-safety.ts
import pino from "pino";

const logger = pino({ name: "type-safety" });

/**
 * 类型安全评分器
 */
export class TypeSafetyScorer {
  /**
   * 计算类型安全评分
   */
  score(files: Array<{ path: string; content: string }>): {
    total: number;
    score: number;
    issues: Array<{ path: string; line: number; issue: string }>;
  } {
    let total = 0;
    let issues: Array<{ path: string; line: number; issue: string }> = [];

    for (const file of files) {
      const lines = file.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        total++;

        // 检查 as any
        if (/as\s+any/.test(line)) {
          issues.push({
            path: file.path,
            line: i + 1,
            issue: "使用 'as any' 类型断言",
          });
        }

        // 检查 @ts-ignore
        if (/@ts-ignore/.test(line)) {
          issues.push({
            path: file.path,
            line: i + 1,
            issue: "使用 '@ts-ignore' 注释",
          });
        }

        // 检查 @ts-nocheck
        if (/@ts-nocheck/.test(line)) {
          issues.push({
            path: file.path,
            line: i + 1,
            issue: "使用 '@ts-nocheck' 注释",
          });
        }
      }
    }

    const score = Math.max(0, 100 - (issues.length / total) * 100);

    return { total, score, issues };
  }

  /**
   * 生成类型安全报告
   */
  generateReport(files: Array<{ path: string; content: string }>): string {
    const { total, score, issues } = this.score(files);

    const lines = [
      "# 类型安全报告",
      "",
      `总代码行数: ${total}`,
      `类型安全评分: ${score.toFixed(1)}/100`,
      `问题数量: ${issues.length}`,
      "",
      "## 问题列表",
      "",
    ];

    for (const issue of issues) {
      lines.push(`- ${issue.path}:${issue.line} - ${issue.issue}`);
    }

    return lines.join("\n");
  }
}
```

**验证方式**：
1. 编译通过无类型错误
2. 类型安全评分 > 90
3. IDE 类型提示正常

---

## 四、优化后的执行计划

### 执行顺序（按风险递增）

```
第 1 天：P0-1 → P0-2 → P0-3（低风险，快速验证）
第 2 天：P1-2 → P1-3（中风险，核心功能）
第 3 天：P1-1（高风险，需充分测试）
第 4-7 天：P2-3 → P2-2 → P2-1（高风险，分阶段）
```

### 回滚方案

每个修复前创建 Git 分支：

```bash
# 创建修复分支
git checkout -b fix/p0-1-api-key-persistence

# 修复完成后合并
git checkout main
git merge fix/p0-1-api-key-persistence

# 如果失败，回滚
git reset --hard HEAD~1
```

### 验证清单

每个修复完成后必须验证：

- [ ] 功能正常工作
- [ ] 无新 Bug 引入
- [ ] 性能无下降
- [ ] 安全无漏洞
- [ ] 文档已更新
- [ ] 单元测试通过
- [ ] 集成测试通过

---

## 五、风险评估（优化版）

| 风险 | 概率 | 影响 | 缓解措施 |
|------|:--:|:--:|----------|
| 修复引入新 Bug | 中 | 高 | 充分测试 + 灰度发布 + 快速回滚 |
| 孤岛模块激活失败 | 高 | 中 | 分阶段激活 + 依赖检查 + 回滚方案 |
| 性能下降 | 低 | 中 | 性能测试 + 监控告警 + 采样优化 |
| 兼容性问题 | 中 | 高 | 保持 API 兼容 + 版本控制 + 文档更新 |
| LLM 生成代码安全 | 中 | 高 | 沙箱验证 + 人工审批 + 代码审计 |

---

## 六、总结

优化后的修复计划具有以下特点：

1. **风险可控**：按风险递增执行，P0 级风险最低
2. **快速回滚**：每个修复都有回滚方案
3. **充分验证**：每个修复都有验证清单
4. **渐进式**：P2 级修复分阶段执行
5. **可监控**：添加性能监控和告警

**总预计时间：7 天（1 周）**

---

*本修复计划基于六维审核结果优化，执行前请再次确认问题仍然存在。*
