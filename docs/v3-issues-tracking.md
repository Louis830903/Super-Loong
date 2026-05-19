# v3 修复计划 23 子 Task 追溯表

> 本文档与 `.qoder/plans/Super_Agent_全面审核修复计划_27feccb4.md` 对应，
> 用于无 GitHub Issue 权限或本地开发场景下追溯每个 Task 的进度。
>
> **使用约定：**
> - 每开始一个 Task，更新下方表格 `状态`
> - 提交 PR 时填写 `PR #` 或 commit hash
> - 代码中的 `TODO/NOTE` 注释必须带 `@task Tx` 标签便于反查
> - 凡有 GitHub Issue 的，优先把 `Issue #` 填入

## 状态枚举

`PENDING` 未开始 | `IN_PROGRESS` 进行中 | `BLOCKED` 阻塞 | `REVIEW` 评审中 | `DONE` 已完成

---

## 冲刺 0（W0 / 预热 0.5d）

| Task | 描述 | 优先级 | 工时 | 状态 | Issue # | PR # | 负责人 |
|---|---|---|---|---|---|---|---|
| T0a | .gitignore 纵深防御 + git rm --cached 脚本 | P0 | 0.2d | DONE | - | - | - |
| T0b | .env.example / vault.example.json / ecosystem.example 三模板 | P0 | 0.2d | DONE | - | - | - |
| T0c | 23 子 Task 绑 Issue + PR 模板加强 | P1 | 0.1d | DONE | - | - | - |

## 冲刺 1（W1 / 止血 P0）

| Task | 描述 | 优先级 | 工时 | 状态 | Issue # | PR # | 负责人 |
|---|---|---|---|---|---|---|---|
| T1   | SQL 注入：sql-safe.ts + assertSafeIdentifier | P0 | 0.5d | PENDING | - | - | 安全 |
| T2   | 命令注入：CommandGuard 接管 exec | P0 | 1d   | PENDING | - | - | 安全 |
| T3   | API 全局响应壳 onSend hook + 显式分支 | P0 | 3d   | PENDING | - | - | 业务 |
| T4   | IM 网关 INTERNAL_TOKEN HMAC 双侧鉴权 | P0 | 1.5d | PENDING | - | - | 平台 |
| T5   | 空 catch 全部加日志 + 增量 lint | P1 | 0.5d | PENDING | - | - | 业务 |
| T5.5 | 凭据保险柜 fail-fast + 迁移期 | P0 | 0.5d | PENDING | - | - | 安全 |
| T5.6 | eslint-plugin-jsdoc 关键导出强制 @why | P1 | 0.5d | PENDING | - | - | 业务 |

## 冲刺 2（W2-W4 / 契约 + OTel 双轨）

| Task | 描述 | 优先级 | 工时 | 状态 | Issue # | PR # | 负责人 |
|---|---|---|---|---|---|---|---|
| T6 | zod → OpenAPI → 前端类型 codegen | P1 | 5d | PENDING | - | - | 业务 |
| T7 | OpenTelemetry 全链路追踪（含 5 个新节点） | P0 | 8d | PENDING | - | - | 平台 |
| T8 | BaseImChannel 抽象（与 T9 并行） | P1 | 3d | PENDING | - | - | 业务 |
| T9 | 上帝文件拆分（4 大文件） | P1 | 3d | PENDING | - | - | 业务 |

## 冲刺 3（W5-W8 / 性能 + 错误码 + 鉴权）

| Task | 描述 | 优先级 | 工时 | 状态 | Issue # | PR # | 负责人 |
|---|---|---|---|---|---|---|---|
| T10   | LLM 缓存 + SQLite 池 + N+1 | P1 | 4d | PENDING | - | - | 业务 |
| T11   | 错误码字典 + 国际化 + 全语言覆盖 | P1 | 2d | PENDING | - | - | 业务 |
| T12   | API 鉴权统一收口 | P1 | 1d | PENDING | - | - | 安全 |
| T12.5 | 双轨切换闸门 | P1 | 1d | PENDING | - | - | 平台 |

## 长期（M3-M6）

| Task | 描述 | 优先级 | 工时 | 状态 | Issue # | PR # | 负责人 |
|---|---|---|---|---|---|---|---|
| T13  | api ↔ core 解耦（DI） | P2 | 10d | PENDING | - | - | 业务 |
| T14  | KB ↔ Memory 双向同步桥 | P2 | 8d | PENDING | - | - | 业务 |
| T15a | K8s Helm chart | P2 | 8d | PENDING | - | - | 平台 |
| T15b | K8s HPA | P2 | 5d | PENDING | - | - | 平台 |
| T15c | K8s ConfigMap + Secret | P2 | 4d | PENDING | - | - | 平台 |
| T15d | K8s HA + 灰度 | P2 | 8d | PENDING | - | - | 平台 |
| T16  | 端到端契约测试（Pact + Schemathesis） | P2 | 5d | PENDING | - | - | 业务 |
| T17a | README 10 层提示工程注释 | P2 | 3d | PENDING | - | - | 业务 |
| T17b | 企业微信适配器补全 | P2 | 5d | PENDING | - | - | 业务 |
| T17c | OTel README 章节（随 T7 自然落地） | P2 | - | PENDING | - | - | 平台 |

---

## 全局 FEATURE_FLAG 总开关

每个 P0/P1 Task 须配套一个 FLAG，便于灰度回滚：

| FLAG | Task | 默认值 | 计划砍掉时间 |
|---|---|---|---|
| `RESP_ENVELOPE` | T3 | true | W4 末（双轨期结束） |
| `GUARDED_EXEC` | T2 | true | T2 完成后 + 1 周 |
| `INTERNAL_AUTH` | T4 | true | T4 完成即砍 |
| `VAULT_FAIL_FAST` | T5.5 | true | 永久（迁移期内可临时关闭） |
| `LLM_CACHE` | T10 | false | T10 完成 + 灰度 1 周后开 |
| `OTEL_TRACE` | T7 | false | T7 完成 + 灰度 1 周后开 |
| `INCREMENTAL_LINT` | T5/T5.6 | true | 永久 |
| `KB_MEM_BRIDGE` | T14 | false | M3 灰度 |

---

## 跨平台兼容性矩阵

| Task | Windows | Linux | macOS | 备注 |
|---|---|---|---|---|
| T0a/T0b/T0c | ✅ | ✅ | ✅ | 通用 |
| T1 | ✅ | ✅ | ✅ | 纯 TS |
| T2 | ⚠️ | ✅ | ✅ | Win 上 CommandGuard 走 process 级 |
| T3 | ✅ | ✅ | ✅ | 通用 |
| T4 | ✅ | ✅ | ✅ | HMAC 跨语言 |
| T5/T5.6 | ⚠️ | ✅ | ✅ | T5 PowerShell grep 兼容 |
| T7 | ⚠️ | ✅ | ✅ | Win 路径分隔符兜底 |
| T10 | ⚠️ | ✅ | ✅ | **Win SQLite synchronous=NORMAL / Linux=FULL** |
| T15* | ❌ | ✅ | ❌ | K8s 仅 Linux |

---

> 维护说明：本表与 v3 计划文档同步更新；新增 Task 须在此登记。
