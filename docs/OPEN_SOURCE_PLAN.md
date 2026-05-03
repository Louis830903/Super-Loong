# Super Agent 开源准备计划

> 创建日期：2026-05-02
> 审查日期：2026-05-02（审查报告见 [AUDIT_REPORT.md](./AUDIT_REPORT.md)）
> 状态：已审查，待执行

---

## 概览

本文档列出了将 Super Agent 项目开源前需要完成的所有准备工作，按优先级分为三个等级：

- **P0**：不处理绝对不能开源（阻塞项）
- **P1**：强烈建议处理（安全/隐私风险）
- **P2**：开源社区标配 + 审查补漏（提升项目质量）
- **额外**：锦上添花

> 审查发现的 8 个遗漏项已全部整合到对应优先级中（标注 🆕）。

---

## 已确认决策

| # | 决策项 | 决定 | 原因 |
|---|--------|------|------|
| D1 | AGENTS.md | ❌ 不开源 | 含内部开发规范和 AI 代理指令，保留在上级 workspace |
| D2 | `models.json` | ✅ 作为模板跟踪 | 自定义模型配置文件，空模板，方便用户扩展 |
| D3 | `services/kb-parser/` | ✅ 跟踪 | 是知识库解析微服务，属于功能的一部分 |
| D4 | `data/MEMORY.md` 等 | ✅ 保留为模板 | 当前是空模板（只有注释），有开源价值 |
| D5 | `services/video-forge/` | ✅ 跟踪 | 已是功能的一部分（Python 视频微服务） |

---

## P0 — 阻塞项（不处理绝对不能开源）

| # | 事项 | 当前状态 | 处理方式 | 状态 |
|---|------|---------|---------|------|
| 1 | **选择并添加 LICENSE** | ❌ 无 | 推荐 MIT（宽松）或 Apache 2.0（专利保护）。在根目录创建 `LICENSE` 文件 | ⬜ |
| 2 | **修改根 `package.json`** | `"private": true` | 去掉或改为 `false`，补充 `repository`、`author`、`keywords` | ⬜ |
| 3 | **`.env` 安全验证** | `.env` 含真实 Key | ✅ `.gitignore` 已排除，git 历史中无 `.env` 记录 | ⬜ |

---

## P1 — 安全/隐私风险（不处理后果严重）

| # | 事项 | 当前状态 | 处理方式 | 状态 |
|---|------|---------|---------|------|
| 4 | **清理个人测试文件** | 根目录散落 ~25 个 mp3/png/xlsx/html/md | 见下方清单，全部删除 | ⬜ |
| 5 | **清理 `data/` 数据库文件** | `super-agent.db`(208KB) + 备份 | 已在 `.gitignore`（`*.db`、`*.db.bak`），确认 clean checkout 不含 | ⬜ |
| 6 | **清理内部审计文档 + git 历史** 🆕 增强 | `AUDIT-FIX-SPEC`(45KB)、`FIX-PLAN`(22KB) 已被 git 跟踪 | ① `git rm` 移除 ② **如含敏感内容**，用 `git filter-repo` 从全量历史删除 | ⬜ |
| 7 | **`.qoder/` 加入 `.gitignore`** 🆕 | 当前不在 `.gitignore`，虽未跟踪但 `git add .` 会意外提交 | 在 `.gitignore` 中添加 `.qoder/` 行 | ⬜ |
| 8 | **`package-lock.json` 排除** 🆕 | 根目录存在（未跟踪），项目用 pnpm，两者共存会误导贡献者 | 在 `.gitignore` 中添加 `package-lock.json` | ⬜ |
| 9 | **`.env.example` 审查** | 所有字段均为空占位符 ✅ | 最终确认无残留真实值 | ⬜ |
| 10 | **`SA_ENCRYPTION_KEY` 轮换** | `.env` 中有明文密钥 | 生成新密钥 → 旧密钥设为 LEGACY → 运行 migrateKeys() 自动重加密 5 provider + 4 config → 删除 LEGACY → 验证可解密 ✅ | ✅ |

### 待清理的个人测试文件清单

```
speech.mp3, speech_dragon.mp3, test_voice.mp3,
voice_test_for_user.mp3, voice_test_user.mp3,
大龙龙介绍.mp3, 大龙龙语音.mp3, 我是你的大龙龙_标准男声.mp3,
朗读_我是你的大龙龙.mp3, 语音测试文件.mp3, 请下载播放_阿里云语音测试.mp3,
test-screenshot-1.png, test-screenshot-2.png, test-screenshot-3.png,
test_data_50.xlsx, 信息收集表单.html, 精酿啤酒电商销售策略分析报告.md
```

---

## P2 — 开源社区标配 + 审查补漏

| # | 事项 | 当前状态 | 处理方式 | 状态 |
|---|------|---------|---------|------|
| 11 | **编写 `README.md`** | ❌ 无（`REPO-WIKI.md` 可改编） | 项目简介、特性列表、架构图、快速开始、环境要求、配置说明、开发指南 | ⬜ |
| 12 | **`CONTRIBUTING.md`** | ❌ 无 | 贡献指南：Issue/PR 流程、代码规范、测试要求 | ⬜ |
| 13 | **`CODE_OF_CONDUCT.md`** | ❌ 无 | 社区行为准则（Contributor Covenant 模板） | ⬜ |
| 14 | **`SECURITY.md`** | ❌ 无 | 安全漏洞报告流程和联系方式 | ⬜ |
| 15 | **`CHANGELOG.md`** | ❌ 无 | 版本变更记录 | ⬜ |
| 16 | **GitHub 仓库配置** | 需确定组织名 | `AIDC-AI/super-agent`，设置 Description + Topics | ⬜ |
| 17 | **CI/CD 完善** | 仅有 `benchmark.yml` | ① 补充 lint/test/build workflow ② **`benchmark.yml` 不再 `git push` 到仓库**（改 artifact 输出或 gh-pages）🆕 | ⬜ |
| 18 | **Issue/PR 模板** | ❌ 无 | `.github/ISSUE_TEMPLATE/`、`.github/PULL_REQUEST_TEMPLATE.md` | ⬜ |
| 19 | **清理根目录散落源码/脚本** | `test-api.mjs`、`tmp_video_req.json`、`tsc_*.txt`、`vitest_output.txt`、`check_mic.ps1` | 移到 `test/` 或删除 | ⬜ |
| 20 | **审查所有子包 `package.json`** 🆕 | 6 个子包（core/api/web/monitor/research/web-types） | 检查 `private`、`publishConfig`、`version` 字段 | ⬜ |
| 21 | **确保 `services/kb-parser/` 被跟踪** 🆕 | 当前被 `.gitignore` 排除 | 从 `.gitignore` 移除 `services/kb-parser/` 规则，`git add` 纳入版本控制 | ⬜ |
| 22 | **`models.json` 作为模板跟踪** 🆕 | 未跟踪，空模板 | 从 `.gitignore` 移除（如需要），`git add` 纳入版本控制。README 中说明用途 | ⬜ |
| 23 | **扫描 `services/video-forge/` Python 源码** 🆕 | Python 源码已在 git 中 | 扫描硬编码密钥/API URL/endpoint ID，确认无泄露 | ⬜ |
| 24 | **`services/` 子目录 `.env` 安全** | 三个子服务均无 `.env` 泄露 ✅ | 最终确认 video-forge、im-gateway、kb-parser 均无 | ⬜ |

---

## 额外建议

| # | 事项 | 说明 | 状态 |
|---|------|------|------|
| 25 | **添加 `.editorconfig`** | 统一编辑器设置（缩进、换行符、字符集） | ⬜ |
| 26 | **GitHub 仓库 Description + Topics** | `ai-agent`, `multi-agent`, `llm`, `typescript`, `nextjs`, `knowledge-base` 等 | ⬜ |
| 27 | **发布 v0.1.0 Release** | 带 Release Notes 的 tag，含特性列表和已知限制 | ⬜ |

---

## 推荐执行顺序

```
P0 (1-3) → P1 (4-10) → P2 (11-24) → 额外 (25-27)
```

### 第一阶段：P0（估计 1-2 小时）

| 步骤 | 内容 |
|------|------|
| 1 | 确定 LICENSE（MIT / Apache 2.0） |
| 2 | 修改根 `package.json`，审查子包 `package.json`（#20 关联） |
| 3 | 最终确认 `.env.example` 无泄露 |

### 第二阶段：P1（估计 2-3 小时）

| 步骤 | 内容 |
|------|------|
| 4 | 删除个人测试文件（25 个 mp3/png/xlsx/html/md） |
| 5 | 确认 `data/` 数据库文件被 `.gitignore` 覆盖 |
| 6 | `git rm` 内部审计文档，评估是否需要 `git filter-repo` |
| 7 | `.qoder/` 加入 `.gitignore` |
| 8 | `package-lock.json` 加入 `.gitignore` |
| 9 | `.env.example` 最终审查 |
| 10 | `SA_ENCRYPTION_KEY` 轮换 + 数据库迁移 |

### 第三阶段：P2（估计 1-2 天）

| 步骤 | 内容 |
|------|------|
| 11-15 | 编写社区文档（README、CONTRIBUTING、CODE_OF_CONDUCT、SECURITY、CHANGELOG） |
| 16 | GitHub 仓库创建 + 配置 |
| 17 | CI/CD：补充 lint/test/build，修复 benchmark.yml 的 git push |
| 18 | Issue/PR 模板 |
| 19 | 根目录脚本/输出文件清理 |
| 20 | 审查所有子包 `package.json` |
| 21 | `services/kb-parser/` 从 `.gitignore` 移除并跟踪 |
| 22 | `models.json` 作为模板跟踪 |
| 23 | 扫描 `services/video-forge/` Python 源码硬编码 |
| 24 | 最终确认 `services/` 无 `.env` 泄露 |

### 第四阶段：额外（估计 0.5 天）

| 步骤 | 内容 |
|------|------|
| 25 | `.editorconfig` |
| 26 | GitHub 仓库元数据 |
| 27 | v0.1.0 Release |

---

## 依赖与冲突分析

| 依赖关系 | 说明 |
|----------|------|
| #2 → #20 | 根 `package.json` 改完后，需同步审查所有子包 |
| #10 单独执行 | 加密密钥轮换是数据库迁移操作，独立于其他所有项 |
| #21 需确认 | 移除 `.gitignore` 规则后，确认 kb-parser 的 `.gitignore` 自身不排除了关键文件 |
| #23 需先做 | Python 源码扫描应在开源审查早期完成，如果发现问题会影响其他项 |

### 冲突项：无

所有项目互不冲突，可以按阶段顺序执行。`#10`（密钥轮换）是唯一需要停服的操作，建议在其他项完成后、push 到 GitHub 之前执行。

---

## 不影响功能保证

| 类别 | 数量 | 说明 |
|------|------|------|
| 增删文件 | 20 项 | LICENSE、README、CONTRIBUTING、.editorconfig 等——纯新增或删除非源码文件 |
| 修改配置 | 4 项 | `.gitignore`、`package.json`、CI workflow、Issue 模板——不改业务逻辑 |
| 数据库操作 | 1 项 | `SA_ENCRYPTION_KEY` 轮换——加解密迁移，不改变表结构 |
| 只读审查 | 2 项 | `.env.example` 审查、Python 源码扫描——只看不改 |

**总计 27 项，0 项影响程序功能。**

---

## 待确认事项

1. **LICENSE 选择**：MIT（最宽松）还是 Apache 2.0（含专利保护）？
2. **仓库归属**：个人账号还是组织账号（如 AIDC-AI）？
3. **开源范围**：是否包含 `services/` 下的所有微服务？还是只开源核心包？
4. **文档语言**：README 等文档用中文还是英文（或双语）？

---

> 本计划将根据实际情况持续更新。每完成一项请将状态更新为 ✅。
