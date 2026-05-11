# Super-Agent Agent 动力学改进计划

> 灵感来源：42章经《用 Agent 动力学，和 40 个 Agents 一起为「人 + AI」做产品》— RC 访谈  
> 创建时间：2026-05-06

---

## 背景

RC（Slock.ai 创始人 / Kimi CLI 作者）在访谈中分享了几个对 super-agent 有直接启发价值的实践：

1. **多 Agent 协作的真问题**：7 人 + 40 agents 协同工作，不是"一个全能 agent"而是"一群分工 agent"
2. **Agent-to-Agent 纠偏**：Alice 记住了你调教它的过程，看到 Bob 出错时可以直接纠正
3. **Memory > Skill**：真正值钱的是 agent 的长程对话历史（external memory），不是 skill 文件
4. **Claim 认领机制**：任务发布后不能所有 agent 抢着做，需要 exclusive lock
5. **Agent 视角 vs 人视角**：agent 看到的是线性 event stream，需要 summary 辅助回溯

---

## 改进总览

| ID | 改进项 | 优先级 | 预估行数 | 影响文件 |
|----|--------|--------|----------|----------|
| A  | Agent-to-Agent 纠偏（共享 Memory 视图） | **P0** | ~200 | orchestrator.ts, runtime.ts, markdown-memory.ts |
| B  | Task Claim 认领锁 | **P1** | ~80 | orchestrator.ts |
| C  | Agent Summary 上下文注入 | **P2** | ~150 | runtime.ts, orchestrator.ts |
| D  | Agent Export/Fork 可移植打包 | **P3** | ~200 | runtime.ts, manager.ts, 新增 agent-export.ts |

---

## Task A：Agent-to-Agent 纠偏 — 共享 Memory 视图

### 问题

当前 GroupChat 中 agent 之间通过消息通信，但 agent 调教记忆（MEMORY.md）隔离。Alice 被你调教过"处理 CSV 时先用 pandas 预览前 5 行"，但 Bob 遇到同样场景时不知道这个经验，会自己重新试错。

### 方案

在 `Orchestrator.runGroupChat()` 中，同 crew 的 agent 共享彼此的 MarkdownMemory 快照，通过扩展的 prefetch 块注入到 system prompt。

```
用户调教 Alice → Alice MEMORY.md 更新 →
  下一次 GroupChat turn 时：
    所有 agent 的 system prompt 末尾追加:
    <crew_memory>
    <agent_alice>
    [Alice 的 MEMORY.md 关键段落]
    </agent_alice>
    </crew_memory>
```

### 技术实现

1. **`packages/core/src/memory/markdown-memory.ts`**  
   - 新增 `toSharedPromptBlock(): string` 方法，输出适合注入其他 agent 的精华版

2. **`packages/core/src/collaboration/orchestrator.ts`**  
   - `runGroupChat()` 中，每轮对话前收集 crew 中所有 agent 的 `markdownMemory.getFrozenPromptBlock()`  
   - 将共享记忆追加到 system prompt（标注来源，区分"自己的记忆"和"别人的经验"）

3. **`packages/core/src/agent/runtime.ts`**  
   - `chat()` / `chatStream()` 中接收可选的 `sharedMemoryBlock?: string` 参数  
   - 追加到 system prompt 末尾（位于自身 memory 之后，`[System note: below is shared experience from other agents in your crew.]`）

### 验收标准

- [ ] Alice 被调教后，Bob 在 group chat 中回答同类问题时会引用 Alice 的经验
- [ ] 共享记忆块明确标注来源 agent，避免 agent 混淆"自己学的"和"别人教的"
- [ ] 不影响单 agent 模式（sharedMemoryBlock 为空时行为不变）

---

## Task B：Task Claim 认领锁

### 问题

GroupChat 中多 agent 看到同一个任务消息后会同时执行，造成 token 浪费和结果冲突。RC 的做法是：agent 必须先 claim 任务才能执行，类似 exclusive lock。

### 方案

在 `Orchestrator` 中增加一个轻量级内存 claim 注册表，基于任务消息 hash。

```typescript
class TaskClaimRegistry {
  private claims = new Map<string, { agentId: string; claimedAt: number }>();
  
  claim(taskHash: string, agentId: string): "claimed" | "already_taken" | "stale_reclaimed" {
    const existing = this.claims.get(taskHash);
    if (!existing) {
      this.claims.set(taskHash, { agentId, claimedAt: Date.now() });
      return "claimed";
    }
    // 5 分钟超时自动回收
    if (Date.now() - existing.claimedAt > 300_000) {
      this.claims.set(taskHash, { agentId, claimedAt: Date.now() });
      return "stale_reclaimed";
    }
    return existing.agentId === agentId ? "claimed" : "already_taken";
  }
  
  release(taskHash: string, agentId: string): void { ... }
}
```

### 技术实现

- 文件：`packages/core/src/collaboration/task-claim.ts` 新增
- 集成到 `orchestrator.ts` 的 `runGroupChat()`：agent 收到任务消息后，先 claim 再执行
- claim 失败时 agent 回复简短确认消息（如 "task claimed by Alice, skipping"）

### 验收标准

- [ ] 同一任务同一个 turn 内只有 1 个 agent 执行
- [ ] 超时任务（>5min）可被其他 agent 回收
- [ ] claim 失败时不会阻塞整个 GroupChat

---

## Task C：Agent Summary 上下文注入

### 问题

RC 指出 agent 看到的是线性 event stream。当 Alice 的 context 里上一件事是另一个 channel 的消息（中间隔了几十个 event），再来一条相关消息时，她需要"大海捞针"回溯上下文。

### 方案

在 agent-to-agent 消息传递时，发送方自动附加一个 **context summary block**，格式类似现有 `[Reflection]` 注入：

```
[Context Summary from Alice]
Previous task: CSV 数据清洗（已完成，结果 1200 行）
Current focus: 等待 Bob 的验证结果
Last tool used: run_python (success)
[/Context Summary]

---以下是消息正文---
Bob，验证结果怎么样了？
```

### 技术实现

1. **`packages/core/src/agent/runtime.ts`**  
   - 新增 `summarizeCurrentContext(session: Session): string`，基于 `summarizeRecentSteps()` 扩展  
   - 在 GroupChat 消息出口处自动调用

2. **`packages/core/src/collaboration/orchestrator.ts`**  
   - `sendAgentMessage()` 添加 `attachContextSummary: boolean` 选项

### 验收标准

- [ ] GroupChat 中 agent 发出的每条消息都附带简短 context summary
- [ ] Summary 不超过 200 字符（避免 token 膨胀）
- [ ] Summary 正确反映 agent 当前任务状态

---

## Task D：Agent Export/Fork — 可移植打包

### 问题

RC："如果一个 agent 被调教得很好，别人很难直接拿过去用"。super-agent 需要一个 export/import 机制，把 agent 的 {config, memory, conversation_history} 打包成可移植的"agent 镜像"。

### 方案

```typescript
// 导出
const agentImage = await agentRuntime.export();
// → { config, markdownMemory: { MEMORY.md, USER.md }, conversationSummary, skills }

// 导入
const newAgent = agentManager.importAgent(agentImage);
```

### 技术实现

1. **`packages/core/src/agent/agent-export.ts`** 新增  
   - `exportAgent(agent: AgentRuntime): AgentImage` — 打包 config + markdown files + 最近 N 条对话  
   - `importAgent(image: AgentImage, manager: AgentManager): AgentRuntime` — 创建新 agent 并注入记忆  
   - 支持从 JSON 文件读取/写入

2. **API 路由**：`packages/api/src/routes/agents.ts`  
   - `POST /agents/:id/export`  
   - `POST /agents/import`

### 验收标准

- [ ] 导出文件包含完整的 agent 调教历史
- [ ] 导入后的 agent 在相同场景下表现与原 agent 一致
- [ ] 导出文件可安全分享（不包括 API key、敏感环境变量）

---

## 实施顺序建议

```
Phase 1 (本次): Task B → Task C   ← 快速见效，改动小
Phase 2 (后续): Task A             ← 核心差异化能力
Phase 3 (远期): Task D             ← 战略级功能
```

---

## 测试策略

| Task | 单元测试 | 集成测试 |
|------|----------|----------|
| A | `markdown-memory.test.ts` 新增 `toSharedPromptBlock` | `orchestrator.test.ts` 新增 crew memory sharing |
| B | `task-claim.test.ts` 新增 | `orchestrator.test.ts` 新增 claim 场景 |
| C | `runtime.test.ts` 新增 `summarizeCurrentContext` | `orchestrator.test.ts` 新增 summary 注入 |
| D | `agent-export.test.ts` 新增 | API 集成测试 |
