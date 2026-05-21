# V3 Task → Issue 映射表

> 本文档将 V3 里程碑的每个 Task 映射为拟定的 Issue 编号，便于代码审查、提交信息和 PR 关联追溯。
>
> 提交信息格式：`[fix/feat/refactor] 描述 (#Issue编号)`
> 示例：`[refactor] 拆分 orchestrator.ts 为 crew-executor + collab-utils (#V3-09)`

---

## 安全与基础设施

| Issue | Task | 名称 | 状态 | 关键文件 |
|-------|------|------|------|----------|
| V3-0A | 0a | .gitignore 纵深防御 | ✅ 100% | `.gitignore` |
| V3-0B | 0b | example 模板 | ✅ 100% | `.env.example`, `vault.example.json` |
| V3-0C | 0c | Issue 绑定规范 | ✅ 100% | `V3_ISSUE_MAP.md`, `AGENTS.md` |
| V3-01 | 1 | SQL 注入白名单 | ✅ 100% | `sql-safe.ts` |
| V3-02 | 2 | CommandGuard | ✅ 100% | `command-guard.ts` |
| V3-03 | 3 | 响应壳 | ✅ 100% | `response-envelope.ts` |
| V3-04 | 4 | IM 网关鉴权 | ✅ 100% | `internal-auth.ts`, `log-monitor.js` |
| V3-05 | 5 | 空 catch 清光 | ✅ 100% | 全局 grep 验证 |
| V3-05.5 | 5.5 | 凭据 fail-fast | ✅ 100% | `credential-vault.ts` |
| V3-05.6 | 5.6 | 注释增量 lint | ✅ 100% | `.eslintrc.cjs` |

## 架构与可观测性

| Issue | Task | 名称 | 状态 | 关键文件 |
|-------|------|------|------|----------|
| V3-06 | 6 | zod → OpenAPI | ⚠️ 80% | `gen-openapi.ts`, `schemas/` |
| V3-07 | 7 | OTel 全链路 | ⚠️ 70% | `instrumentation.ts`, `tracer.ts` |
| V3-08 | 8 | BaseImChannel 抽象 | ❌ 0% | *待独立会话* |
| V3-09 | 9 | 上帝文件拆分 | ⚠️ 70% | `orchestrator.ts`, `migrations.ts` |

## 功能增强

| Issue | Task | 名称 | 状态 | 关键文件 |
|-------|------|------|------|----------|
| V3-10 | 10 | LLM 缓存 | ✅ 95% | `cache.ts` |
| V3-11 | 11 | 错误码字典 | ✅ 100% | `error-codes.ts` |
| V3-12 | 12 | API 鉴权收口 | ✅ 100% | `onRequest` hook |
| V3-12.5 | 12.5 | 双轨切换闸门 | ✅ 100% | `feature-flags.ts` |

---

## 使用指南

### 提交关联

在 `git commit` 消息中引用 Issue 编号：

```
[refactor] 拆分 migrations.ts 为 4 个子文件 (#V3-09)
[feat] 补齐监控面板 INTERNAL_TOKEN 鉴权 (#V3-04)
[fix] 修复 orchestrator 循环依赖 (#V3-09)
```

### PR 关联

在 Pull Request 描述中引用相关 Issue：

```markdown
## 关联 Issue
Closes #V3-04, #V3-09

## 变更说明
- 监控面板 log-monitor.js 新增 INTERNAL_TOKEN 校验
- orchestrator.ts 拆分为 3 个子文件
```

### 代码注释标注

在关键代码变更处用 `@issue` 标注关联：

```typescript
// @issue V3-04: 监控面板鉴权收尾
const MONITOR_TOKEN = process.env.INTERNAL_TOKEN || "";
```
