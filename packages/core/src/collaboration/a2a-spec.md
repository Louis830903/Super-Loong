# A2A 协议实施规范

> 本文档为 super-agent 项目 A2A (Agent-to-Agent) 协议集成的技术规范。
> 对齐标准：[A2A v1.0](../../../../../../A2A/specification/a2a.proto)（Linux Foundation / Google）

---

## 1. SDK 选型决策

**结论：方案 C — 完全自研**

| 维度 | 评估结果 |
|------|---------|
| 选择理由 | 零外部依赖、完全控制 Fastify 集成、复用现有 JSON-RPC 基础设施 |
| 参考实现 | `mcp/client.ts` 已有 JSON-RPC 2.0 over HTTP（fetch + 指数退避 + Bearer/APIKey） |
| protocolVersion | 锁定 `0.3.x` |

---

## 2. A2A 方法集对照表（12 个 RPC）

| # | 方法 | 方向 | 用途 | 流式 | MVP |
|---|------|------|------|------|-----|
| 1 | `SendMessage` | client→agent | 发送消息（启动/继续 Task） | 否 | ✅ |
| 2 | `SendStreamingMessage` | client→agent | 流式消息 + SSE 增量 | 是 | ⚪ |
| 3 | `GetTask` | client→agent | 查询 Task 状态/历史/产物 | 否 | ✅ |
| 4 | `ListTasks` | client→agent | 列表查询（按 contextId/state） | 否 | ⚪ |
| 5 | `CancelTask` | client→agent | 取消进行中 Task | 否 | ✅ |
| 6 | `SubscribeToTask` | client→agent | 订阅已有 Task 更新流 | 是 | ⚪ |
| 7 | `CreateTaskPushNotificationConfig` | client→agent | 注册 webhook 推送 | 否 | ⚪ |
| 8 | `GetTaskPushNotificationConfig` | client→agent | 查询推送配置 | 否 | ⚪ |
| 9 | `ListTaskPushNotificationConfigs` | client→agent | 列表推送配置 | 否 | ⚪ |
| 10 | `DeleteTaskPushNotificationConfig` | client→agent | 删除推送配置 | 否 | ⚪ |
| 11 | `GetExtendedAgentCard` | client→agent | 鉴权后获取详细 Card | 否 | ⚪ |

---

## 3. A2A vs MCP 决策树

### 一句话划分

- **MCP**：agent 调**无自主推理能力的工具/资源**（文件系统、数据库、SaaS API）
- **A2A**：agent 与**另一个 agent**协作（同进程/跨进程/跨组织），对方有自主推理能力

### 决策规则

```
被调方有自主推理能力?
  ├── 否 → 选 MCP
  └── 是 → 需要跨进程/跨机器?
          ├── 否 → 选现有 orchestrator + SubagentManager
          └── 是 → 选 A2A
```

### 禁止项

- ❌ 不得用 MCP 调另一个 super-agent 进程（会丢 Task 状态机与 contextId）
- ❌ 不得用 A2A 包装纯函数工具（如"计算器 Agent"）
- ❌ 不得同一能力同时接入 MCP 与 A2A 两套

---

## 4. 核心数据模型

### Task 状态机（8 态）

```
submitted ──→ working ──→ completed  (终止)
    │              ├──→ failed     (终止)
    │              ├──→ canceled   (终止)
    │              ├──→ input-required ──→ working (循环)
    │              └──→ auth-required  ──→ working (循环)
    └──→ rejected (终止)
```

- **终止态** (completed/failed/canceled/rejected)：不可转换，需新建 Task
- **中断态** (input-required/auth-required)：可恢复到 working

### 发现策略（四级回退）

1. **进程内**：`agentManager.getAgent(id)` — 本地 Agent
2. **Direct Config**：环境变量/配置文件显式映射
3. **Curated Registry**：`IAgentRegistry.resolve(id)` — 注册中心
4. **Well-Known URI**：`https://{domain}/.well-known/agent-card.json` — 标准端点

---

## 5. 参考资料

- A2A proto 定义：`A2A/specification/a2a.proto`
- A2A JSON Schema：`A2A/specification/json/a2a.json`
- A2A 核心概念：`A2A/docs/topics/key-concepts.md`
- A2A Task 生命周期：`A2A/docs/topics/life-of-a-task.md`
