# Super Agent 代码审查修复计划 Spec v1.0

> 基于全面代码审查发现的问题，制定分阶段修复方案。
> 审查日期：2026-07-17 | 修复优先级：P0 > P1 > P2

---

## 一、P0 级修复（立即执行）

### P0-1 API Key 持久化到 SQLite

**问题**：`ApiKeyStore` 使用内存 Map 存储，重启后所有 API Key 丢失

**位置**：`packages/api/src/auth/index.ts:78-134`

**修复方案**：

```typescript
// 1. 在 SQLite 中创建 api_keys 表
// packages/core/src/persistence/sqlite/schema.ts 添加：
`
CREATE TABLE IF NOT EXISTS api_keys (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer', 'agent')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);
`

// 2. 重写 ApiKeyStore 为 SQLite 后端
// packages/api/src/auth/index.ts
class ApiKeyStore {
  private db: SqlJsDatabase;

  constructor() {
    this.db = getDatabase();
    this.ensureTable();
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
      )
    `);
  }

  validate(key: string): ApiKeyRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM api_keys WHERE key = ? AND enabled = 1
    `);
    const row = stmt.get(key) as any;
    if (!row) return null;

    // 更新 last_used_at
    this.db.prepare(`
      UPDATE api_keys SET last_used_at = datetime('now') WHERE key = ?
    `).run(key);

    return {
      key: row.key,
      name: row.name,
      role: row.role as Role,
      createdAt: new Date(row.created_at),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
      enabled: row.enabled === 1,
    };
  }

  list(): ApiKeyRecord[] {
    const stmt = this.db.prepare(`
      SELECT key, name, role, created_at, last_used_at, enabled
      FROM api_keys ORDER BY created_at DESC
    `);
    return stmt.all().map((row: any) => ({
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
    return result.changes > 0;
  }

  delete(key: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM api_keys WHERE key = ?
    `).run(key);
    return result.changes > 0;
  }
}
```

**验证方式**：
1. 创建 API Key → 重启服务 → Key 仍存在
2. 禁用 Key → 验证无法使用
3. 删除 Key → 验证从数据库移除

---

### P0-2 日志脱敏系统

**问题**：日志中可能泄露 API Key、密码、Token 等敏感信息

**位置**：全局日志系统

**修复方案**：

```typescript
// packages/core/src/utils/log-sanitizer.ts
const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,           // API Key
  /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/g, // JWT Token
  /password["\s:=]+["']?[^"'\s]+/gi, // 密码
  /secret["\s:=]+["']?[^"'\s]+/gi,   // 密钥
  /token["\s:=]+["']?[^"'\s]+/gi,    // Token
  /api[_-]?key["\s:=]+["']?[^"'\s]+/gi, // API Key
];

export function sanitizeLog(data: unknown): unknown {
  if (typeof data === "string") {
    let sanitized = data;
    for (const pattern of SENSITIVE_PATTERNS) {
      sanitized = sanitized.replace(pattern, (match) => {
        const prefix = match.slice(0, 4);
        return `${prefix}***REDACTED***`;
      });
    }
    return sanitized;
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeLog);
  }

  if (data && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      // 对 key 也进行检查
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes("key") || lowerKey.includes("secret") ||
          lowerKey.includes("password") || lowerKey.includes("token")) {
        result[key] = "***REDACTED***";
      } else {
        result[key] = sanitizeLog(value);
      }
    }
    return result;
  }

  return data;
}

// 在 pino 中使用
const logger = pino({
  name: "app",
  serializers: {
    req: (req) => sanitizeLog(req),
    res: (res) => sanitizeLog(res),
    err: (err) => sanitizeLog(err),
  },
});
```

**验证方式**：
1. 构造包含 API Key 的日志 → 验证被脱敏
2. 构造包含密码的对象 → 验证被脱敏
3. 正常日志不受影响

---

### P0-3 前端 AuthGuard 组件

**问题**：布局文件未包裹认证守卫，所有页面在 `AUTH_ENABLED=true` 时仍可访问

**位置**：`packages/web/src/app/layout.tsx`

**修复方案**：

```typescript
// packages/web/src/components/auth/auth-guard.tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";

interface AuthGuardProps {
  children: React.ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    // 检查本地存储的 token
    const token = localStorage.getItem("auth_token");

    if (!token) {
      // 未登录，重定向到登录页
      if (pathname !== "/login") {
        router.push(`/login?redirect=${encodeURIComponent(pathname)}`);
      }
      setIsAuthenticated(false);
      return;
    }

    // 验证 token 有效性
    fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (res.ok) {
          setIsAuthenticated(true);
        } else {
          // Token 无效，清除并重定向
          localStorage.removeItem("auth_token");
          router.push(`/login?redirect=${encodeURIComponent(pathname)}`);
          setIsAuthenticated(false);
        }
      })
      .catch(() => {
        setIsAuthenticated(false);
      });
  }, [pathname, router]);

  // 加载中状态
  if (isAuthenticated === null) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  // 未认证且不在登录页
  if (!isAuthenticated && pathname !== "/login") {
    return null; // 或显示加载中
  }

  return <>{children}</>;
}

// packages/web/src/app/layout.tsx
import { AuthGuard } from "@/components/auth/auth-guard";

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN" className="dark">
      <body>
        <AuthGuard>
          <Sidebar />
          <main className="main-content">
            <div className="p-6 lg:p-8">{children}</div>
          </main>
          <ToastContainer />
        </AuthGuard>
      </body>
    </html>
  );
}
```

**验证方式**：
1. 未登录访问任意页面 → 重定向到登录页
2. 登录后访问 → 正常显示
3. Token 过期 → 自动重定向到登录页

---

## 二、P1 级修复（本周执行）

### P1-1 激活 ToolGenerator + ToolRegistrar

**问题**：工具自动生成框架完整，但 LLM 生成逻辑未接通

**位置**：`packages/core/src/evolution/tool-generator.ts`, `tool-registrar.ts`

**修复方案**：

```typescript
// 1. 在 EvolutionEngine 中接通 ToolGenerator
// packages/core/src/evolution/engine.ts

// 在 reviewSkills 方法中添加：
if (this.toolGenerator && this.toolRegistrar) {
  // 检测是否需要新工具
  const gap = await this.detectToolGap(cases);
  if (gap) {
    // 生成工具骨架
    const skeleton = this.toolGenerator.generateSkeleton({
      description: gap.description,
      category: gap.category,
      toolName: gap.toolName,
      expectedParams: gap.expectedParams,
    });

    // 用 LLM 填充 execute 函数体
    const llmResponse = await this.llm.complete({
      prompt: `根据以下需求生成 TypeScript 工具执行逻辑：
需求：${gap.description}
参数：${JSON.stringify(gap.expectedParams)}
骨架代码：
${skeleton.sourceCode}

请只返回 execute 函数体内的代码（不包括函数签名）。`,
    });

    // 填充并验证
    const tool = this.toolGenerator.fillExecuteBody(
      skeleton,
      llmResponse.text,
      llmResponse.imports,
      llmResponse.dependencies,
    );

    if (tool.validation?.valid) {
      // 注册工具
      await this.toolRegistrar.register(tool);
      logger.info({ toolName: tool.name }, "新工具自动生成并注册成功");
    }
  }
}

// 2. 异步化 ToolRegistrar 的同步 I/O
// packages/core/src/evolution/tool-registrar.ts
async register(tool: GeneratedTool): Promise<RegistrationResult> {
  // 使用 fs.promises 替代同步 fs
  const fs = await import("node:fs/promises");

  // 写入工具文件
  const filePath = join(this.toolsDir, tool.registration.filePath);
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, tool.sourceCode, "utf-8");

  // 更新 tools/index.ts 的 loaders
  await this.updateLoaders(tool);

  // 记录到 SQLite
  await this.recordToDB(tool);

  return { success: true, toolName: tool.name };
}
```

**验证方式**：
1. 模拟工具缺口 → 验证自动生成工具
2. 生成的工具通过验证 → 验证注册成功
3. 调用新工具 → 验证功能正常

---

### P1-2 定时器统一清理机制

**问题**：多处使用 `setInterval`/`setTimeout`，服务关闭时未清理

**位置**：全局

**修复方案**：

```typescript
// packages/core/src/utils/timer-manager.ts
class TimerManager {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private intervals: Map<string, NodeJS.Timeout> = new Map();

  setTimeout(id: string, fn: () => void, delay: number): void {
    this.clearTimeout(id);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, delay);
    this.timers.set(id, timer);
  }

  setInterval(id: string, fn: () => void, interval: number): void {
    this.clearInterval(id);
    const timer = setInterval(fn, interval);
    this.intervals.set(id, timer);
  }

  clearTimeout(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  clearInterval(id: string): void {
    const timer = this.intervals.get(id);
    if (timer) {
      clearInterval(timer);
      this.intervals.delete(id);
    }
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.intervals.values()) clearInterval(timer);
    this.timers.clear();
    this.intervals.clear();
  }
}

export const timerManager = new TimerManager();

// 在进程退出时清理
process.on("SIGTERM", () => timerManager.clearAll());
process.on("SIGINT", () => timerManager.clearAll());

// 使用示例：
// 替代 setInterval(() => {...}, 5000)
// timerManager.setInterval("heartbeat", () => {...}, 5000);
```

**验证方式**：
1. 启动服务 → 创建多个定时器 → 关闭服务 → 验证无定时器泄漏
2. 使用 `process._getActiveHandles()` 验证定时器被清理

---

### P1-3 错误码标准化

**问题**：`categorizeError` 通过字符串匹配判断错误类型，过于脆弱

**位置**：`packages/api/src/routes/chat.ts:55-100`

**修复方案**：

```typescript
// packages/api/src/errors/error-codes.ts
export enum ErrorCode {
  // 客户端错误 4xx
  INVALID_REQUEST = "INVALID_REQUEST",
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",
  NOT_FOUND = "NOT_FOUND",
  VALIDATION_ERROR = "VALIDATION_ERROR",

  // 服务端错误 5xx
  INTERNAL_ERROR = "INTERNAL_ERROR",
  LLM_ERROR = "LLM_ERROR",
  TIMEOUT = "TIMEOUT",
  SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
}

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// 使用示例：
throw new AppError(
  ErrorCode.LLM_ERROR,
  "LLM API 调用失败",
  502,
  { provider: "dashscope", model: "qwen-max" },
);

// 在路由中统一处理：
app.setErrorHandler((error, request, reply) => {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  }

  // 未知错误
  request.log.error(error);
  return reply.status(500).send({
    success: false,
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: "内部服务器错误",
    },
  });
});
```

**验证方式**：
1. 抛出 `AppError` → 验证返回正确状态码和错误码
2. 抛出未知错误 → 验证返回 500 和 INTERNAL_ERROR

---

## 三、P2 级修复（本月执行）

### P2-1 激活全部孤岛模块

**问题**：9 个进化模块未激活，自我进化能力未完全实现

**修复方案**：

按依赖顺序激活：

```
Phase 1: ToolGenerator + ToolRegistrar（工具自动生成）
    ↓
Phase 2: CapabilityGapDetector + AutoLearner（自主学习）
    ↓
Phase 3: ToolDiscoverer（工具发现）
    ↓
Phase 4: IntentLearner + IntentDecomposer（意图学习）
    ↓
Phase 5: AdaptiveExecutor（自适应执行）
```

每个 Phase 的激活步骤：
1. 移除 `@deprecated` 标记
2. 接通依赖注入
3. 添加单元测试
4. 验证功能正常
5. 更新文档

---

### P2-2 记忆自动关联系统

**问题**：记忆需要显式调用，不会自动关联对话内容

**修复方案**：

```typescript
// packages/core/src/memory/auto-associator.ts
export class MemoryAutoAssociator {
  constructor(
    private memoryManager: MemoryManager,
    private knowledgeGraph: KnowledgeGraph,
  ) {}

  /**
   * 对话后自动提取关键信息并关联
   */
  async processConversation(
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<void> {
    // 1. 提取实体（人名、地名、组织、项目等）
    const entities = await this.extractEntities(messages);

    // 2. 提取关系（A 是 B 的上级、X 属于 Y 项目等）
    const relations = await this.extractRelations(messages);

    // 3. 提取事件（会议、截止日期、决策等）
    const events = await this.extractEvents(messages);

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
          timestamp: event.timestamp,
        },
      });
    }

    // 6. 建立跨会话关联
    await this.linkToPreviousSessions(entities, relations);
  }

  private async linkToPreviousSessions(
    entities: Entity[],
    relations: Relation[],
  ): Promise<void> {
    // 查找历史会话中相同的实体
    for (const entity of entities) {
      const previous = await this.knowledgeGraph.findEntity(entity.name);
      if (previous) {
        // 建立"同一实体"关联
        await this.knowledgeGraph.addTriple({
          subjectId: entity.id,
          predicate: "same_as",
          objectId: previous.id,
          confidence: 0.95,
          source: "auto_association",
        });
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

### P2-3 类型安全强化

**问题**：25+ 处使用 `as any`，类型安全不足

**修复方案**：

```typescript
// 1. 创建精确的类型定义替代 as any
// 示例：packages/core/src/llm/provider.ts

// 修复前：
return msg as any;

// 修复后：
interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

function normalizeMessage(msg: unknown): LLMMessage {
  if (typeof msg === "string") {
    return { role: "user", content: msg };
  }
  if (typeof msg === "object" && msg !== null) {
    const m = msg as Record<string, unknown>;
    return {
      role: (m.role as LLMMessage["role"]) ?? "user",
      content: (m.content as string | ContentPart[]) ?? "",
      tool_calls: m.tool_calls as ToolCall[] | undefined,
      tool_call_id: m.tool_call_id as string | undefined,
    };
  }
  return { role: "user", content: String(msg) };
}

// 2. 逐步替换所有 as any
// 优先级：高频使用 > 核心模块 > 边缘模块
```

**验证方式**：
1. 编译通过无类型错误
2. 运行时无类型相关错误
3. IDE 类型提示正常

---

## 四、修复计划时间表

| 阶段 | 任务 | 预计时间 | 负责人 |
|------|------|----------|--------|
| P0-1 | API Key 持久化 | 2 小时 | - |
| P0-2 | 日志脱敏 | 3 小时 | - |
| P0-3 | AuthGuard | 2 小时 | - |
| P1-1 | ToolGenerator 激活 | 4 小时 | - |
| P1-2 | 定时器清理 | 2 小时 | - |
| P1-3 | 错误码标准化 | 3 小时 | - |
| P2-1 | 孤岛模块激活 | 8 小时 | - |
| P2-2 | 记忆自动关联 | 6 小时 | - |
| P2-3 | 类型安全强化 | 4 小时 | - |

**总计：约 34 小时**

---

## 五、验证标准

每个修复完成后必须验证：

1. **功能验证**：修复的功能正常工作
2. **回归测试**：不影响现有功能
3. **性能测试**：不引入性能问题
4. **安全测试**：不引入安全漏洞
5. **文档更新**：更新相关文档

---

## 六、风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|:--:|:--:|----------|
| 修复引入新 Bug | 中 | 高 | 充分测试 + 灰度发布 |
| 孤岛模块激活失败 | 高 | 中 | 分阶段激活 + 回滚方案 |
| 性能下降 | 低 | 中 | 性能测试 + 监控告警 |
| 兼容性问题 | 中 | 高 | 保持 API 兼容 + 版本控制 |

---

*本修复计划基于代码审查结果制定，执行前请再次确认问题仍然存在。*
