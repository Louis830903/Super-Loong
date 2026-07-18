# 七大模块完美修复 Spec v1

> 目标：把复盘发现的所有问题**真正修复到可用**，让 7 大能力名副其实。
> 范围：全 7 模块拉满（用户决策）。
> 原则：不新建重复实现、复用已有真实现、每步代码层面验证。

---

## 〇、决策记录（已与用户对齐）

| # | 决策点 | 选择 |
|---|--------|------|
| D1 | 修复范围 | **全 7 模块拉满** |
| D2 | 自动记忆触发 | **每 10 轮对话触发一次**（复用会话轮次计数，合并 1 次 LLM 调用） |
| D3 | 空壳工具 | **真正实现它们**（复用已有 vision.ts / voice-tools.ts 真实现） |
| D4 | 进化激活 | **A+B**：接通能力缺口检测（A，低风险）+ 工具骨架生成提案（B，人工审核后应用，不自动热加载） |

---

## 一、问题清单（复盘证据汇总）

| 模块 | 真实度 | 核心问题 | 证据位置 |
|------|:---:|------|------|
| 记忆管理 | 40% | `AutoMemorySystem` 从未 `new`，自动记忆是空壳；`MemoryAutoAssociator` 重复且有 `parseInt` 中文实体恒 0 Bug | auto-memory.ts:33 / auto-associator.ts:76,240 |
| 技能市场 | 60% | 加载路径写死 `~/.super-agent/skills`，发现不了项目内本地技能；无法区分本地/市场技能 | context.ts:140 / paths.ts:82 |
| 空壳工具 | — | `voice-chat.ts` / `image-understanding.ts` execute 写"实现略"返回假结果，且未注册到 loaders | voice-chat.ts:26 / image-understanding.ts:26 / tools/index.ts:186-198 |
| 进化引擎 | 55% | `activation-manager` 8 个 activateXxx() 仅打日志；`activationManager.activate()` 从未被调用；能力缺口检测器未接入对话流 | activation-manager.ts:162-212 |
| 通道管理 | 75% | 钉钉/企微缺 Doctor/Security 适配；凭证不全时无友好提示 | services/im-gateway/ |
| 知识库 | 88% | 已可用；大规模性能与 Docling 部署待优化（非阻塞） | knowledgebase/ |
| MCP+多Agent | 85/90% | 已可用；缺回归测试兜底 | mcp/ collaboration/ |

**关键利好（复用基座已存在，无需从零造轮子）**：
- `vision.ts`（vision_analyze/ocr_extract/vision_config，完整多模态管道）= 真实现
- `voice-tools.ts`（tts_speak/stt_transcribe/voice_status，阿里云）= 真实现
- `CapabilityGapDetector.detect()`（自报边界+连续失败+maxSteps）= 真实现
- `ToolGenerator.generateSkeleton()`（模板+Zod）= 真实现
- `runtime.ts` 有 `this.llm` / `this.memoryManager` / `this.manager`，且 `recordEvolutionInteraction()` 已在 chat/chatStream 收尾被调用（L795/816/1152/1168）= 现成挂载点

---

## 二、执行顺序（依赖拓扑，从低风险到高风险）

```
P0-1 空壳工具复用重定向  ← 改动最小，先清障
P0-2 技能市场路径修复    ← 独立，立竿见影
P0-3 记忆自动化接通      ← 核心能力，依赖轮次计数
P1-1 进化 A：缺口检测接入 ← 依赖 recordInteraction
P1-2 进化 B：骨架生成提案 ← 依赖 A
P1-3 activation-manager 胶水层填充
P2-1 通道管理 钉钉/企微补齐 + 凭证校验
P2-2 知识库性能优化
P2-3 MCP+多Agent 回归测试兜底
```

---

## 三、P0-1 · 空壳工具真正实现（D3）

### 问题
`voice-chat.ts` / `image-understanding.ts` 是双重空壳：execute 返回假结果，且未注册。项目已有 `voice-tools.ts` / `vision.ts` 真实现。

### 方案：重定向复用（不删除工具名，保留 Agent 已知的语义名）
把两个空壳的 execute 改为**委托调用**已有真实工具，保留其简洁的工具名（`voice_chat` / `image_understanding`），底层复用真实管道。

**voice-chat.ts**：
- `action=transcribe` → 委托 `sttTranscribeTool`（voice-tools.ts）
- `action=synthesize` → 委托 `ttsSpeakTool`（voice-tools.ts）
- 参数映射：`audioUrl` → stt 的音频输入；文本 → tts 的 text

**image-understanding.ts**：
- 委托 `visionAnalyzeTool`（vision.ts），`imageUrl`+`question` → vision 的 image+prompt

### 涉及文件
- `packages/core/src/tools/voice-chat.ts`（改 execute 为委托）
- `packages/core/src/tools/image-understanding.ts`（改 execute 为委托）
- `packages/core/src/tools/index.ts`（loaders 数组新增 2 条注册）

### 注册（tools/index.ts:198 后追加）
```ts
{ name: "voice-chat", load: () => import("./voice-chat.js").then(m => [m.voiceChatTool]) },
{ name: "image-understanding", load: () => import("./image-understanding.js").then(m => [m.imageUnderstandingTool]) },
```

### 验收标准
- [ ] `getAllBuiltinTools()` 返回含 `voice_chat` / `image_understanding`
- [ ] 调 `voice_chat({action:"synthesize"})` 未配置阿里云时返回**明确"未配置"提示**（复用 voice-tools 的 notConfigured），而非假结果
- [ ] 调 `image_understanding` 未配置 vision 时返回明确未配置提示
- [ ] `pnpm --filter @super-agent/core build` 通过

---

## 四、P0-2 · 技能市场发现本地技能（路径修复）

### 问题
`SkillLoader([paths.skills()])` 只扫 `~/.super-agent/skills`，用户写在项目里的技能发现不了。

### 方案：多目录扫描 + 来源标记
1. **context.ts**：`SkillLoader` 构造传入多个目录——用户目录 + 项目级技能目录（若存在）。
2. 项目级目录优先级：`SA_SKILLS_DIR` 环境变量 → `<cwd>/skills` → `<cwd>/super-agent/skills`（存在才加）。
3. **来源标记**：Skill 对象/快照增加 `source: "user" | "project" | "marketplace"` 字段，市场 UI 可据此区分（marketplace 安装时写 `marketplace`，扫描目录按目录来源标记）。

### 涉及文件
- `packages/api/src/context.ts:140`（SkillLoader 传多目录）
- `packages/core/src/skills/loader.ts`（loadAll 记录每个 skill 的来源目录 → source 字段）
- `packages/core/src/types/index.ts`（Skill / SkillFrontmatter 加可选 `source`）
- `packages/api/src/routes/skills.ts`（列表返回带 source；市场列表按 source 过滤）

### 关键实现（context.ts）
```ts
const skillDirs = [paths.skills()];
const projectSkills = process.env.SA_SKILLS_DIR
  || (existsSync(path.join(process.cwd(), "skills")) ? path.join(process.cwd(), "skills") : null);
if (projectSkills && !skillDirs.includes(projectSkills)) skillDirs.push(projectSkills);
const skillLoader = new SkillLoader(skillDirs);
```

### 注意
- SkillLoader 已有 `.claude/skills` 自动发现逻辑（loader.ts:44），本方案与之并存不冲突。
- 快照缓存（snapshot-cache.ts）需把 source 一并存/取，否则缓存恢复时 source 丢失 → 需扩展 `SkillSnapshotEntry`。

### 验收标准
- [ ] 项目 `skills/` 放一个测试技能，重启后 `GET /api/skills` 能列出，且 `source:"project"`
- [ ] `~/.super-agent/skills` 的技能 `source:"user"`
- [ ] 市场 UI 能区分"本地技能"与"市场技能"
- [ ] 快照缓存二次加载后 source 不丢失

---

## 五、P0-3 · 记忆自动化接通（D2，核心能力）

### 问题
`AutoMemorySystem` 定义但从未实例化/调用 → "自动记住说过的话"完全没生效。`MemoryAutoAssociator` 重复且 `parseInt(entity.id...)` 对中文实体名恒返回 0（写入垃圾三元组）。

### 方案
1. **删除** `MemoryAutoAssociator`（auto-associator.ts）——重复实现 + 有 Bug + 3 次 LLM 调用成本高。统一用 `AutoMemorySystem`（1 次调用）。
2. **修正** `AutoMemorySystem`：
   - `linkEntityToGraph`：用 `kg.getOrCreateEntityId(name)` 拿真实 entityId（现在传的是字符串 sessionId 当 objectId，类型错误）。
   - `linkToPreviousSessions`：`same_as` 自己指向自己无意义 → 改为按实体名跨 session 关联到已存在实体。
3. **实例化并接入 runtime**：
   - `AgentRuntimeOptions` 增加可选 `autoMemory?: AutoMemorySystem`（或在 manager 层持有，runtime 通过 `this.manager` 取）。
   - 复用 `this.llm`（不新建 LLMProvider），复用 `this.memoryManager` + `knowledgeGraph`。
4. **触发时机**：在 `chat()` / `chatStream()` 收尾（紧邻 `recordEvolutionInteraction` 调用处 L795/1152），新增轮次计数：
   - session 元数据记 `autoMemoryTurnCount`，每次 +1；
   - `count % 10 === 0` 时，取最近 10 轮消息异步调 `autoMemory.processConversation(sessionId, agentId, recentMessages)`；
   - 异步执行 + try/catch，**绝不阻塞主回复**（对齐 recordEvolutionInteraction 的 fire-and-forget 模式）。

### 涉及文件
- `packages/core/src/memory/auto-memory.ts`（修正 3 个方法）
- `packages/core/src/memory/auto-associator.ts`（**删除**）
- `packages/core/src/agent/runtime.ts`（构造持有 autoMemory；chat/chatStream 收尾触发）
- `packages/core/src/agent/manager.ts`（创建 agent 时注入 autoMemory）
- `packages/api/src/context.ts`（装配 AutoMemorySystem：memoryManager + knowledgeGraph + 一个可用 LLMProvider）
- `packages/core/src/index.ts`（导出 AutoMemorySystem，若未导出）

### 触发逻辑（runtime.ts 收尾，示意）
```ts
// ── 自动记忆：每 10 轮提取一次（异步、不阻塞主回复） ──
if (this.autoMemory) {
  const meta = session.metadata as Record<string, unknown>;
  const n = ((meta.autoMemoryTurnCount as number) ?? 0) + 1;
  meta.autoMemoryTurnCount = n;
  if (n % 10 === 0) {
    const recent = this.getRecentMessages(20).map(m => ({
      role: m.role, content: typeof m.content === "string" ? m.content : "",
    }));
    this.autoMemory.processConversation(session.id, this.id, recent)
      .catch(err => logger.debug({ err }, "auto-memory extract failed (non-fatal)"));
  }
}
```

### 验收标准
- [ ] `auto-associator.ts` 已删除，全项目无引用残留
- [ ] `AutoMemorySystem` 被 `new` 并注入到 runtime（grep 可见）
- [ ] 连续 10 轮对话后，SQLite `memories` 表出现 `type=recall` 的自动摘要记忆（含 entities/topics/actionItems metadata）
- [ ] 知识图谱 `entities`/`relations` 表出现真实 entityId（非 0）的三元组
- [ ] 第 11 轮起 `recall` 工具能搜到之前自动记的内容
- [ ] 主回复延迟无明显增加（提取走异步）

---

## 六、P1-1 · 进化 A：能力缺口检测接入（低风险）

### 问题
`CapabilityGapDetector.detect()` 是真实现，但从未被对话流调用 → 检测不到"缺什么工具"。

### 方案
1. **EvolutionEngine** 持有一个 `CapabilityGapDetector` 实例（构造时 new）。
2. 在 `recordInteraction()`（engine.ts:335）内部，调 `gapDetector.detect({ agentId, sessionId, agentResponse, toolCalls, ... })`。
3. 检测到新 gap → `emit("gap:detected", gap)` + 持久化到 SQLite（新表 `capability_gaps` 或复用现有存储）。
4. 提供 `GET /api/evolution/gaps` 列出已检测缺口（前端进化页展示"系统发现你可能需要 X 能力"）。

### 涉及文件
- `packages/core/src/evolution/engine.ts:335`（recordInteraction 内接 detect）
- `packages/core/src/evolution/capability-gap-detector.ts`（补持久化方法，若无）
- `packages/api/src/routes/evolution.ts`（新增 gaps 查询端点）
- `packages/core/src/persistence/sqlite*`（capability_gaps 表 DDL，若需持久化）

### 验收标准
- [ ] Agent 回复"我无法访问实时股价"类语句后，`gap:detected` 触发，gaps 列表出现该缺口
- [ ] 连续 3 次同类工具失败 → 检测到工具缺口
- [ ] `GET /api/evolution/gaps` 返回检测结果
- [ ] 检测异步/容错，不阻塞主流程

---

## 七、P1-2 · 进化 B：工具骨架生成提案（人工审核）

### 问题
`ToolGenerator.generateSkeleton()` 是真实现，但无人调用它把"缺口"变成"工具提案"。

### 方案（关键安全边界：只生成提案，人工审核后才应用，绝不自动热加载）
1. 缺口达到"可解决"阈值时（`solvable:true` 且出现 N 次），EvolutionEngine 调 `toolGenerator.generateSkeleton(req)` 生成骨架。
2. 用 `this.llm` 填充 `{EXECUTE_BODY}`（`fillExecuteBody`），产出完整候选代码。
3. 存为**提案**（status=`pending_review`），写入 `tool_proposals` 表 + 落地到 `evolution-generated/` 目录（不注册、不加载）。
4. `GET /api/evolution/proposals` 列出；`POST /api/evolution/proposals/:id/approve` 人工批准后，才追加 loaderEntry 到 tools/index.ts 并提示重启（或走已有沙箱验证）。

### 涉及文件
- `packages/core/src/evolution/engine.ts`（缺口→生成提案的编排）
- `packages/core/src/evolution/tool-generator.ts`（复用 generateSkeleton/fillExecuteBody）
- `packages/api/src/routes/evolution.ts`（proposals 列表 + approve 端点）
- `packages/core/src/persistence/`（tool_proposals 表）

### 安全约束（必须遵守）
- ❌ 不自动注册、不自动热加载生成的工具
- ✅ 生成代码经 `ToolGenerator.validate()` 质量检查
- ✅ approve 走已有 DockerSandbox/SSHSandbox 编译验证（若配置）
- ✅ 全程 Feature Flag `SUPER_AGENT_EVOLUTION_TOOLGEN=true` 控制，默认关闭

### 验收标准
- [ ] 模拟一个高频缺口 → 生成一条 `pending_review` 提案，含完整可编译代码
- [ ] 提案默认不生效（工具池无该工具）
- [ ] approve 后经沙箱验证通过才标记 approved
- [ ] Feature Flag 关闭时整条链路不触发

---

## 八、P1-3 · activation-manager 胶水层填充

### 问题
`activation-manager.ts:162-212` 的 8 个 activateXxx() 仅打日志；`doRollback` 空实现；`activate()` 从未被调用。

### 方案
1. 让 `ActivationManager` 持有 8 个真实模块的引用（构造注入 EvolutionEngine 的 gapDetector/toolGenerator/toolRegistrar 等）。
2. 每个 `activateXxx()` 真正做事：设置 `enabled` 标志 + 绑定事件监听（如 activateCapabilityGapDetector 就是把 P1-1 的接入开关打开）。
3. `doRollback` 真正解绑监听/置 enabled=false。
4. 由进化引擎在启动时按 `SUPER_AGENT_EVOLUTION_STAGE`（0=关，1=仅检测，2=检测+提案）分阶段调用 `activate()`。

### 涉及文件
- `packages/core/src/evolution/activation-manager.ts`（8 方法填充真实逻辑 + doRollback）
- `packages/core/src/evolution/engine.ts`（启动时按 stage 调 activate）
- `packages/api/src/context.ts`（传 stage 配置）

### 验收标准
- [ ] `SUPER_AGENT_EVOLUTION_STAGE=1` 启动后，`getStatus()` 显示 CapabilityGapDetector `activated:true`
- [ ] stage=2 额外激活 ToolGenerator
- [ ] rollback 后对应能力真正停用（事件监听解绑）
- [ ] stage=0（默认）全部不激活，行为与现状一致（零回归）

---

## 九、P2-1 · 通道管理补齐（钉钉/企微 + 凭证校验）

### 方案
1. **凭证校验前置**：channel 启动前校验必填凭证，缺失时返回明确"缺 XXX 配置"错误（而非静默失败），前端渠道页展示。
2. **钉钉/企微对齐飞书**：补 Doctor（连接自检）+ Security（签名校验）适配器，对齐飞书已有实现。
3. 合规性：核对三家官方 API 的签名/加解密/回调校验要求，逐项打勾。

### 涉及文件
- `services/im-gateway/` 各渠道适配器
- `packages/api/src/routes/channels.ts`（凭证校验 + doctor 端点）

### 验收标准
- [ ] 缺凭证时渠道页显示明确缺失项
- [ ] 钉钉/企微有 doctor 自检 + 签名校验
- [ ] 三家回调签名校验符合官方文档（逐项核对表）

---

## 十、P2-2 · 知识库性能优化（非阻塞增强）

### 方案
1. 大规模文档：向量检索加 topN 预筛 + 分页；FTS5 索引确认生效（非 LIKE 降级）。
2. Docling sidecar：补部署说明文档 + 健康检查，OCR 场景降级路径验证。

### 涉及文件
- `packages/core/src/knowledgebase/retrieval/`（性能）
- `docs/`（Docling 部署说明）

### 验收标准
- [ ] 1000+ chunk 知识库检索 P95 < 500ms
- [ ] 确认走 FTS5 而非 LIKE（生产 better-sqlite3）
- [ ] Docling 部署文档完整

---

## 十一、P2-3 · MCP + 多 Agent 回归测试兜底

### 方案
补集成测试，锁定"已可用"状态防回归：
1. MCP：mock 一个 stdio MCP server，验证连接→工具注册→Agent 调用全链路。
2. 多 Agent：验证 Hierarchical 分解→分派→汇总；AgentMatcher 两级匹配。

### 涉及文件
- `packages/core/src/mcp/__tests__/`
- `packages/core/src/collaboration/__tests__/`

### 验收标准
- [ ] MCP 全链路集成测试通过
- [ ] 多 Agent 三种模式各有测试覆盖
- [ ] `pnpm test` 全绿

---

## 十二、总测试计划（测试金字塔）

1. **单元测试**（最先）
   - AutoMemorySystem 提取/关联逻辑
   - SkillLoader 多目录 + source 标记
   - CapabilityGapDetector 接入
   - 空壳工具委托映射
2. **集成测试**
   - 10 轮对话 → 自动记忆落库
   - 缺口检测 → 提案生成（Flag 开）
   - MCP/多Agent 全链路
3. **E2E**（最后）
   - 传文档→复杂任务→多Agent+知识库+记忆协同出结果

---

## 十三、风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 自动记忆增加 LLM 成本 | 每 10 轮才触发 + 异步 | 关 autoMemory 注入 |
| 进化提案生成误注册工具 | Feature Flag + 人工审核 + 沙箱 | Flag 默认关闭 |
| 技能多目录扫描性能 | 快照缓存复用 | 回退单目录 |
| 通道适配改动影响现有飞书 | 只加钉钉/企微，飞书不动 | git revert 对应文件 |
| 删除 auto-associator 有隐藏引用 | 先 grep 全量引用再删 | git 恢复 |

**全局回滚**：每个 P 阶段独立提交，可单独 revert；进化/自动记忆均由 Feature Flag / 可选注入控制，关闭即回到现状（零回归保证）。

---

## 十四、完成后预期真实度

| 模块 | 现状 | 目标 |
|------|:---:|:---:|
| 记忆管理 | 40% | **90%** |
| 技能市场 | 60% | **90%** |
| 空壳工具 | — | **可用** |
| 进化引擎 | 55% | **85%** |
| 通道管理 | 75% | **88%** |
| 知识库 | 88% | **92%** |
| MCP+多Agent | 85/90% | **稳固（测试兜底）** |
