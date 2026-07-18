# 七大模块完美修复 Spec v2

> v2 修订说明：基于 6 维度审查，修正 v1 的 4 类问题（P0-1 委托方案 import 硬伤、进化依赖拓扑缺失、前端对齐缺失、2 个遗漏空壳未纳入）。
> 目标：把复盘 + 审查发现的**所有问题**修复到真正可用，7 大能力名副其实。
> 原则：不造重复轮子、复用已有真实现、删除冗余空壳、每步代码层面验证、零回归。

---

## 〇、决策记录（全部已与用户对齐）

| # | 决策点 | 选择 |
|---|--------|------|
| D1 | 修复范围 | 全 7 模块拉满 |
| D2 | 自动记忆触发 | 每 10 轮对话触发一次（复用轮次计数，合并 1 次 LLM 调用，异步不阻塞） |
| D3 | 空壳工具 voice-chat/image-understanding | **删除**（复用已有 tts_speak/stt_transcribe/vision_analyze，v1 的委托方案不可行） |
| D4 | 进化激活 | A+B：缺口检测（低风险）+ 工具骨架生成提案（人工审核，不自动热加载） |
| D5 | 遗漏空壳 KnowledgeArchiver | **真实现并接入**（对话归档为个人知识库） |
| D6 | 遗漏空壳 EcomInspectionScheduler | **删除**（依赖真实电商 API 凭证，无法完美实现，避免假功能） |
| D7 | 前端对齐 | 后端 + 前端最小展示（列表加标签/入口，确保用户可见） |

---

## 一、审查修正对照表（v1 → v2）

| 审查问题 | 严重度 | v1 缺陷 | v2 修正 |
|------|:---:|------|------|
| P0-1 委托方案 | 🔴 阻断 | 委托 `sttTranscribeTool` 等，但这些是模块内 `const` 未 export，import 不到；且 `audioUrl`↔`audioPath`、`imageUrl`↔`image` 参数语义不匹配 | 改为**删除两个空壳**，Agent 直接用已注册的 `tts_speak`/`stt_transcribe`/`vision_analyze`/`ocr_extract`（功能更全） |
| 进化依赖拓扑 | 🔴 阻断 | 未明确 8 模块激活依赖顺序 | 补依赖拓扑图 + stage 分级严格按序激活（见 §七） |
| 前端对齐缺失 | 🟡 质量 | 3 个新端点无前端说明 | 每个新端点补前端最小展示（见 §四/§六/§七） |
| 遗漏空壳 | 🟡 质量 | KnowledgeArchiver/EcomInspection 未纳入 | 归档真实现（§八）+ 电商巡检删除（§九） |
| 跨包类型改动 | 🟡 影响面 | 未强调 source 字段影响 3 包 | 明确破坏性 + 老数据 source 缺失兼容（见 §四） |

---

## 二、关键证据（已代码核实，实施依据）

| 事实 | 证据位置 | 对计划的意义 |
|------|------|------|
| `tts_speak`/`stt_transcribe`/`voice_status` 是真实现，聚合导出 `voiceTools` | voice-tools.ts:118/167/205/234 | 语音能力已存在，空壳可删 |
| `vision_analyze`/`ocr_extract`/`vision_config` 真实现，导出 `visionTools` | vision.ts:248/278/313/360 | 图片能力已存在，空壳可删 |
| 单个工具是模块内 `const`，**未单独 export** | voice-tools.ts:117 / vision.ts:247 | v1 委托方案 import 不到 → 必须删空壳 |
| `stt_transcribe` 只认 `audioPath` 本地路径，文件不存在报错 | voice-tools.ts:170,183 | 参数与空壳 `audioUrl` 不兼容 |
| `AgentRuntimeOptions` 已有 `memoryManager?`/`manager?` | runtime.ts:81-93 | 自动记忆/进化接入无需改构造签名 |
| `recordEvolutionInteraction()` 已在 chat/chatStream 收尾调用 | runtime.ts:795/816/1152/1168 | 自动记忆挂载点现成 |
| `AutoMemorySystem` 未从 core/index.ts 导出 | index.ts grep 0 匹配 | 需补导出 |
| 进化依赖：AutoLearner ← CapabilityGapDetector + ToolDiscoverer | index.ts:343-356 @deprecated 注释 | 激活必须按依赖序 |
| KnowledgeArchiver 空壳（无 LLM 提炼，堆叠所有记忆） | knowledge-archiver.ts:32-53 | 需真实现 |
| EcomInspectionScheduler 空壳（checkWechatOrders 假数据） | ecom-inspection.ts:42-60 | 依赖真凭证，删除 |

---

## 三、执行顺序（依赖拓扑，低风险→高风险）

```
P0-1 删除 2 个冗余空壳工具        ← 最小改动，先清障（D3）
P0-2 技能市场多目录 + source 标记  ← 独立（D7 前端同步）
P0-3 记忆自动化接通               ← 核心能力（D2）
P0-4 KnowledgeArchiver 真实现接入  ← 依赖记忆（D5）
P1-1 进化 A：缺口检测接入          ← 依赖 recordInteraction（D7 前端）
P1-2 进化 B：骨架生成提案          ← 依赖 A（D7 前端）
P1-3 activation-manager 依赖拓扑激活 ← 依赖 A/B（D4）
P2-1 删除 EcomInspectionScheduler   ← 独立（D6）
P2-2 通道管理 钉钉/企微 + 凭证校验
P2-3 知识库性能优化
P2-4 MCP+多Agent 回归测试兜底
```

---

## 四、P0-1 · 删除 2 个冗余空壳工具（D3，修正 v1 硬伤）

### 问题
`voice-chat.ts`/`image-understanding.ts` execute 写"实现略"返回假结果，且未注册。v1 想委托复用真实工具，但真实工具未单独 export + 参数语义不匹配，委托不可行。

### 方案：直接删除（真实能力已由现有工具覆盖）
| 空壳工具 | 已存在的真实替代 | 能力对比 |
|------|------|------|
| `voice_chat` | `tts_speak` + `stt_transcribe` | 真实：多发音人/本地播放/格式选择，更强 |
| `image_understanding` | `vision_analyze` + `ocr_extract` | 真实：SSRF 检查/50MB 下载/自适应缩放/OCR，更强 |

### 涉及文件
- **删除** `packages/core/src/tools/voice-chat.ts`
- **删除** `packages/core/src/tools/image-understanding.ts`
- `packages/core/src/tools/index.ts`：确认 loaders 未引用这俩（grep 确认无残留）
- 全项目 grep `voiceChatTool`/`imageUnderstandingTool` 确认无 import

### 验收标准
- [ ] 两文件已删除，全项目无引用残留
- [ ] `getAllBuiltinTools()` 含 `tts_speak`/`stt_transcribe`/`vision_analyze`/`ocr_extract`（真实工具）
- [ ] `pnpm --filter @super-agent/core build` 通过
- [ ] 语音/图片能力仍可用（调真实工具，未配置时返回明确"未配置"提示而非假结果）

---

## 五、P0-2 · 技能市场发现本地技能（D7 前端同步）

### 问题
`SkillLoader([paths.skills()])` 只扫 `~/.super-agent/skills`，项目内技能发现不了；无法区分本地/市场技能。

### 方案：多目录扫描 + source 来源标记 + 前端标签
1. **context.ts**：SkillLoader 传多目录——`paths.skills()` + 项目级（`SA_SKILLS_DIR` → `<cwd>/skills`，存在才加）。
2. **来源标记**：`Skill` + `SkillSnapshotEntry` 增加可选 `source?: "user"|"project"|"marketplace"`。
3. **前端最小展示**（D7）：技能市场页每个技能卡片加来源标签（本地/项目/市场）。

### 涉及文件
- `packages/api/src/context.ts:140`（多目录）
- `packages/core/src/skills/loader.ts`（loadAll 记录来源目录 → source）
- `packages/core/src/skills/snapshot-cache.ts`（SkillSnapshotEntry 加 source，缓存存取不丢失）
- `packages/core/src/types/index.ts`（Skill/SkillFrontmatter 加可选 source）
- `packages/api/src/routes/skills.ts`（列表返回 source；市场按 source 过滤）
- `packages/web/src/`（技能页卡片加来源标签 — 前端最小改动）

### 影响面提示（审查维度 3）
- ⚠️ **跨 3 包改动**（core types → api routes → web UI）。`source` 设为**可选字段** → 老快照/老数据无此字段时按 `undefined` 处理（UI 显示"未知来源"或默认"user"），保证向后兼容。

### 关键实现（context.ts）
```ts
const skillDirs = [paths.skills()];
const projectSkills = process.env.SA_SKILLS_DIR
  || (existsSync(path.join(process.cwd(), "skills")) ? path.join(process.cwd(), "skills") : null);
if (projectSkills && !skillDirs.includes(projectSkills)) skillDirs.push(projectSkills);
const skillLoader = new SkillLoader(skillDirs);
```

### 验收标准
- [ ] 项目 `skills/` 放测试技能，重启后 `GET /api/skills` 列出且 `source:"project"`
- [ ] `~/.super-agent/skills` 技能 `source:"user"`
- [ ] 快照缓存二次加载 source 不丢失
- [ ] 前端技能页能看到来源标签
- [ ] 老数据（无 source）不报错，UI 有兜底展示

---

## 六、P0-3 · 记忆自动化接通（D2，核心能力）

### 问题
`AutoMemorySystem` 从未实例化 → 自动记忆空壳。`MemoryAutoAssociator` 重复且 `parseInt(中文实体名)` 恒 0。

### 方案
1. **删除** `MemoryAutoAssociator`（auto-associator.ts）——重复 + Bug + 3 次 LLM 调用。
2. **修正** `AutoMemorySystem`：
   - `linkEntityToGraph`：用 `kg.getOrCreateEntityId(name)` 取真实 entityId（现传 sessionId 当 objectId 类型错误）。
   - `linkToPreviousSessions`：`same_as` 自指无意义 → 改为按实体名跨 session 关联已存在实体。
3. **补导出**：core/index.ts 导出 `AutoMemorySystem`（当前未导出）。
4. **实例化接入**：context.ts 装配（memoryManager + knowledgeGraph + LLMProvider）；manager 创建 agent 时注入；runtime 复用 `this.llm`/`this.memoryManager`。
5. **触发**：chat/chatStream 收尾（L795/1152 旁），session.metadata 记 `autoMemoryTurnCount`，`% 10 === 0` 时取最近 20 条消息异步 `processConversation`，try/catch 不阻塞。

### 涉及文件
- `packages/core/src/memory/auto-memory.ts`（修正 3 方法）
- `packages/core/src/memory/auto-associator.ts`（**删除**）
- `packages/core/src/index.ts`（导出 AutoMemorySystem）
- `packages/core/src/agent/runtime.ts`（持有 autoMemory + 收尾触发）
- `packages/core/src/agent/manager.ts`（注入 autoMemory）
- `packages/api/src/context.ts`（装配）

### 触发逻辑（runtime.ts 收尾）
```ts
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
- [ ] `auto-associator.ts` 删除，无引用残留
- [ ] `AutoMemorySystem` 被 new 并注入（grep 可见）
- [ ] 10 轮后 `memories` 表出现 `type=recall` 自动摘要（含 entities/topics/actionItems）
- [ ] 知识图谱三元组 entityId 为真实值（非 0）
- [ ] 第 11 轮起 `recall` 能搜到自动记的内容
- [ ] 主回复延迟无明显增加

---

## 七、P0-4 · KnowledgeArchiver 真实现接入（D5）

### 问题
`archiveConversation` 把某 agent 全部记忆无脑堆叠成 Markdown，无 LLM 提炼、无去重、无结构化——归档质量低，且从未接入。

### 方案
1. **真实现**：`generateKnowledgeEntry` 改为 LLM 提炼——传入对话/记忆，产出结构化知识条目（标题+要点+标签），而非堆叠原文。复用可用 LLMProvider。
2. **归档粒度**：按 sessionId 归档单次会话（不是拉取 agent 全部记忆），避免重复归档。
3. **接入触发**：会话结束 或 用户显式"归档到知识库"指令时调用（不自动高频触发，避免成本）。
4. **前端最小展示**（D7）：知识库页展示归档条目列表 + 分类统计（复用 `getStats`）。

### 涉及文件
- `packages/core/src/memory/knowledge-archiver.ts`（generateKnowledgeEntry 改 LLM 提炼 + 按 session 归档）
- `packages/core/src/index.ts`（导出 KnowledgeArchiver）
- `packages/api/src/context.ts`（装配）
- `packages/api/src/routes/`（归档触发端点 + 列表/统计端点）
- `packages/web/src/`（知识库页展示归档条目 — 前端最小改动）

### 验收标准
- [ ] `generateKnowledgeEntry` 走 LLM 提炼，输出结构化条目（非原文堆叠）
- [ ] 归档按 session 粒度，重复归档不产生冗余
- [ ] `getStats` 按 category 正确统计
- [ ] 前端知识库页能看到归档条目
- [ ] 未配置 LLM 时降级为原文归档 + 明确提示（不报错）

---

## 八、P1-1 · 进化 A：能力缺口检测接入（D7 前端）

### 方案
1. EvolutionEngine 持有 `CapabilityGapDetector` 实例。
2. `recordInteraction()`（engine.ts:335）内调 `gapDetector.detect(...)`，异步容错。
3. 新 gap → `emit("gap:detected")` + 持久化 `capability_gaps` 表。
4. `GET /api/evolution/gaps` 端点。
5. **前端**（D7）：进化页新增"能力缺口"区块，展示"系统发现你可能需要 X 能力"。

### 涉及文件
- `packages/core/src/evolution/engine.ts:335`
- `packages/core/src/evolution/capability-gap-detector.ts`（补持久化）
- `packages/core/src/persistence/`（capability_gaps 表 DDL）
- `packages/api/src/routes/evolution.ts`（gaps 端点）
- `packages/web/src/`（进化页缺口区块）

### 验收标准
- [ ] Agent 自报"无法访问实时数据"后 `gap:detected` 触发
- [ ] 连续 3 次同类工具失败 → 检测到缺口
- [ ] `GET /api/evolution/gaps` 返回结果
- [ ] 前端进化页展示缺口
- [ ] 检测异步不阻塞主流程

---

## 九、P1-2 · 进化 B：工具骨架生成提案（D4，人工审核）

### 方案（安全边界：只生成提案，人工审核 + 沙箱验证后才应用，绝不自动热加载）
1. 缺口达阈值（`solvable:true` 且出现 N 次）→ `toolGenerator.generateSkeleton(req)`。
2. `this.llm` 填充 `{EXECUTE_BODY}`（`fillExecuteBody`）→ 完整候选代码。
3. 存 `tool_proposals` 表（status=`pending_review`）+ 落地 `evolution-generated/`（不注册不加载）。
4. `GET /api/evolution/proposals` + `POST /api/evolution/proposals/:id/approve`（批准才走沙箱验证 + 追加 loaderEntry + 提示重启）。
5. **前端**（D7）：进化页新增"工具提案"区块，展示待审核提案 + 批准按钮。

### 安全约束（必须遵守）
- ❌ 不自动注册/热加载
- ✅ `ToolGenerator.validate()` 质量检查
- ✅ approve 走 DockerSandbox/SSHSandbox 编译验证
- ✅ Feature Flag `SUPER_AGENT_EVOLUTION_TOOLGEN=true`，默认关闭

### 涉及文件
- `packages/core/src/evolution/engine.ts`（缺口→提案编排）
- `packages/core/src/evolution/tool-generator.ts`（复用）
- `packages/core/src/persistence/`（tool_proposals 表）
- `packages/api/src/routes/evolution.ts`（proposals 端点）
- `packages/web/src/`（提案审核区块）

### 验收标准
- [ ] 模拟高频缺口 → 生成 `pending_review` 提案（完整可编译代码）
- [ ] 提案默认不生效（工具池无该工具）
- [ ] approve 后经沙箱验证通过才 approved
- [ ] Feature Flag 关闭时整条链路不触发
- [ ] 前端可见提案 + 审核

---

## 十、P1-3 · activation-manager 依赖拓扑激活（D4，修正审查问题）

### 问题
8 个 activateXxx() 仅打日志；`activate()` 从未被调用；**审查发现**：v1 未处理模块间激活依赖。

### 依赖拓扑（据 index.ts:343-356 @deprecated 注释）
```
Stage 1（基础感知）：CapabilityGapDetector   ← 无依赖，最先
Stage 2（工具生成）：ToolGenerator, ToolRegistrar  ← 依赖 Stage 1
Stage 3（自主学习）：ToolDiscoverer → AutoLearner  ← AutoLearner 依赖 GapDetector + ToolDiscoverer
其余（IntentLearner/IntentDecomposer/AdaptiveExecutor）：Stage 3 后
```

### 方案
1. `ActivationManager` 构造注入真实模块引用（EvolutionEngine 的 gapDetector/toolGenerator 等）。
2. 每个 `activateXxx()` 真正做事：置 enabled + 绑定事件（如 activateCapabilityGapDetector = 打开 P1-1 接入开关）。
3. `doRollback` 真正解绑监听 + enabled=false。
4. **严格按依赖序激活**：激活前校验前置模块已激活，否则抛错（不激活"依赖未就绪"模块）。
5. 启动时按 `SUPER_AGENT_EVOLUTION_STAGE`（0=关/1=仅检测/2=检测+生成/3=全自主）分阶段调 `activate()`。

### 涉及文件
- `packages/core/src/evolution/activation-manager.ts`（8 方法真实逻辑 + doRollback + 依赖校验）
- `packages/core/src/evolution/engine.ts`（按 stage 调 activate）
- `packages/api/src/context.ts`（传 stage 配置）

### 验收标准
- [ ] `STAGE=1` → getStatus() 显示 CapabilityGapDetector `activated:true`
- [ ] `STAGE=3` 激活 AutoLearner 前，GapDetector + ToolDiscoverer 已激活（依赖校验生效）
- [ ] 依赖未就绪时激活抛明确错误（不静默）
- [ ] rollback 后能力真正停用
- [ ] `STAGE=0`（默认）全不激活，零回归

---

## 十一、P2-1 · 删除 EcomInspectionScheduler（D6）

### 问题
`checkWechatOrders`/`checkDouyinOrders`/`checkStockIssues` 全返回假数据，依赖真实电商平台 API 凭证，无法完美实现。保留 = 假功能误导。

### 方案
删除空壳。电商能力保留在已有的 `ecom-operator` 技能（浏览器自动化路径），不做假的定时巡检。

### 涉及文件
- **删除** `packages/core/src/cron/ecom-inspection.ts`
- 全项目 grep `EcomInspectionScheduler` 确认无引用残留

### 验收标准
- [ ] 文件删除，无引用残留
- [ ] `pnpm --filter @super-agent/core build` 通过

---

## 十二、P2-2 · 通道管理补齐（钉钉/企微 + 凭证校验）

### 方案
1. **凭证校验前置**：channel 启动前校验必填凭证，缺失返回明确"缺 XXX 配置"（前端渠道页展示）。
2. **钉钉/企微对齐飞书**：补 Doctor（连接自检）+ Security（签名校验）适配器。
3. 核对三家官方 API 签名/加解密/回调校验，逐项打勾。

### 涉及文件
- `services/im-gateway/` 各渠道适配器
- `packages/api/src/routes/channels.ts`（凭证校验 + doctor 端点）

### 验收标准
- [ ] 缺凭证时渠道页显示明确缺失项
- [ ] 钉钉/企微有 doctor 自检 + 签名校验
- [ ] 三家回调签名符合官方文档（核对表）

---

## 十三、P2-3 · 知识库性能优化（非阻塞增强）

### 方案
1. 大规模：向量检索 topN 预筛 + 分页；确认 FTS5 生效（非 LIKE 降级）。
2. Docling sidecar：补部署说明 + 健康检查。

### 验收标准
- [ ] 1000+ chunk 检索 P95 < 500ms
- [ ] 确认走 FTS5（生产 better-sqlite3）
- [ ] Docling 部署文档完整

---

## 十四、P2-4 · MCP + 多 Agent 回归测试兜底

### 方案
1. MCP：mock stdio server，验证连接→注册→调用全链路。
2. 多 Agent：验证 Hierarchical 分解→分派→汇总 + AgentMatcher 两级匹配。

### 验收标准
- [ ] MCP 全链路集成测试通过
- [ ] 多 Agent 三模式各有覆盖
- [ ] `pnpm test` 全绿

---

## 十五、总测试计划（测试金字塔）

1. **单元测试**（最先）：AutoMemorySystem 提取/关联、SkillLoader 多目录+source、CapabilityGapDetector 接入、KnowledgeArchiver LLM 提炼、activation 依赖校验
2. **集成测试**：10 轮→自动记忆落库、缺口→提案（Flag 开）、MCP/多Agent 全链路、归档→知识库
3. **E2E**（最后）：传文档→复杂任务→多Agent+知识库+记忆+归档协同

---

## 十六、风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 删空壳工具有隐藏引用 | 先 grep 全量引用再删 | git 恢复 |
| 自动记忆 LLM 成本 | 每 10 轮 + 异步 | 关 autoMemory 注入 |
| 归档 LLM 成本 | 会话结束/显式触发，非高频 | 降级原文归档 |
| 进化提案误注册 | Feature Flag + 人工审核 + 沙箱 | Flag 默认关 |
| 激活依赖顺序错乱 | 依赖校验前置抛错 | STAGE=0 全关 |
| source 字段跨包 | 可选字段 + 老数据兜底 | 回退单目录 |
| 通道改动影响飞书 | 只加钉钉/企微，飞书不动 | git revert |

**全局零回归保证**：每 P 阶段独立提交可单独 revert；自动记忆/归档/进化均由可选注入或 Feature Flag / STAGE 控制，关闭即回现状。

---

## 十七、完成后预期真实度

| 模块 | 现状 | 目标 |
|------|:---:|:---:|
| 记忆管理 | 40% | **92%** |
| 技能市场 | 60% | **90%** |
| 空壳工具 | 冗余假实现 | **删除，用真实工具** |
| 进化引擎 | 55% | **85%** |
| 个人知识库归档 | 空壳 | **可用** |
| 通道管理 | 75% | **88%** |
| 知识库 | 88% | **92%** |
| MCP+多Agent | 85/90% | **稳固（测试兜底）** |

---

## 十八、v2 相比 v1 的关键改进总结

1. ✅ **P0-1 从"委托"改为"删除"**——修正 import 硬伤 + 参数不匹配，更符合低耦合/不造轮子
2. ✅ **补进化依赖拓扑**——4 个 stage 严格按序 + 依赖校验，杜绝激活"依赖未就绪"模块
3. ✅ **每个新端点补前端最小展示**——技能来源标签、缺口区块、提案审核、归档列表，确保用户可见
4. ✅ **纳入 2 个遗漏空壳**——KnowledgeArchiver 真实现、EcomInspection 删除
5. ✅ **强调跨包类型改动 + 老数据兼容**——source 可选字段兜底
