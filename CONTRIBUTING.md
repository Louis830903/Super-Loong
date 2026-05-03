# 贡献指南

感谢你对 Super Agent 的关注！欢迎任何形式的贡献。

## 行为准则

本项目遵循 [贡献者公约](CODE_OF_CONDUCT.md)。参与即表示同意遵守其条款。

## 如何贡献

### 报告 Bug

1. 在 [Issues](https://github.com/Louis830903/Super-Loong/issues) 中搜索，确认未被报告
2. 使用 Bug 报告模板，提供：
   - 运行环境（OS / Node.js 版本 / pnpm 版本）
   - 复现步骤
   - 预期行为 vs 实际行为
   - 相关日志或截图

### 提交功能建议

1. 在 Issues 中先讨论，确认方向后再动手
2. 说明使用场景和期望效果

### 提交代码

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feature/xxx`
3. 遵循代码规范（见下方）
4. 确保测试通过：`pnpm test`
5. 提交 PR，关联对应 Issue

## 代码规范

### 通用原则

- **低耦合**：模块之间减少依赖，接口隔离
- **简洁**：避免过度设计，不造轮子
- **中文注释**：关键逻辑用中文详细注释

### TypeScript / React

- 函数式优先，使用箭头函数
- React 使用 Hooks + Functional Component
- 类型定义完整，避免 `any`

### Python

- 遵循 PEP 8
- 使用类型提示

### Git 提交信息

```
[类型] 简短描述

详细说明（可选）
```

类型前缀：`feat` / `fix` / `docs` / `refactor` / `test` / `chore`

## 开发流程

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 运行测试
pnpm test

# 代码检查
pnpm lint

# 构建
pnpm build
```

## 测试要求

- 新功能必须包含测试
- Bug 修复必须包含回归测试
- 测试独立运行，不依赖外部状态

## 项目结构说明

详见 [README.md](README.md) 的「项目结构」部分。

## 问题求助

如果有任何问题，请通过 Issues 提出。
