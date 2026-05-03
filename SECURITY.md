# 安全策略

## 报告安全漏洞

如果你发现了安全漏洞，**请不要在公开 Issue 中报告**。

请通过以下方式私下报告：

1. 在 GitHub 上创建安全通告（Security Advisory）：  
   https://github.com/Louis830903/Super-Loong/security/advisories/new
2. 或发送邮件给项目维护者

请在报告中包含：

- 漏洞的详细描述
- 复现步骤
- 受影响版本
- 可能的修复建议（如有）

## 处理流程

1. 收到报告后，我们将在 **48 小时内** 确认收到
2. 在 **7 天内** 提供初步评估
3. 修复发布后，会在 CHANGELOG 中公开致谢（除非你要求匿名）

## 安全最佳实践

### API Key 管理

- **绝不**将 `.env` 文件提交到 Git（已在 `.gitignore` 中排除）
- 使用 `SA_ENCRYPTION_KEY` 加密数据库中的 API Key
- 定期轮换你的 API Key

### 代码执行沙箱

本项目支持代码执行工具（Python/JavaScript/Shell）。默认情况下，用户自定义 Agent 的代码执行是**禁用**的。启用前请确保：

- 在可信环境中运行
- 设置 `SUPER_AGENT_SANDBOX_LEVEL=docker` 以使用容器隔离
- 了解潜在风险

### 依赖安全

- 定期运行 `pnpm audit` 检查已知漏洞
- 关注依赖更新通告

## 支持的版本

| 版本 | 支持状态 |
|------|---------|
| 0.1.x | ✅ 当前支持 |

## 致谢

感谢所有负责任地报告安全问题的研究者。
