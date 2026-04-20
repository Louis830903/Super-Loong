# Super Loong — 模块化 AI Agent 平台

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-green)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-%3E%3D3.10-blue)](https://www.python.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D9.0.0-orange)](https://pnpm.io/)

> 具备持久记忆、自我演化、多 Agent 协作和 IM 网关的通用 AI Agent 平台。

---

## 目录

- [功能亮点](#功能亮点)
- [系统要求](#系统要求)
- [一键安装](#一键安装)
  - [Windows](#windows)
  - [macOS](#macos)
  - [Linux (Ubuntu/Debian)](#linux-ubuntudebian)
- [环境配置](#环境配置)
- [启动项目](#启动项目)
- [项目结构](#项目结构)
- [IM 平台接入（可选）](#im-平台接入可选)
- [常用命令](#常用命令)
- [常见问题](#常见问题)
- [许可证](#许可证)

---

## 功能亮点

- **多模型支持** — OpenAI / Anthropic / Ollama，统一 LLM 接口
- **三层记忆系统** — Core Memory + Recall + Archival，跨会话持久化
- **自我演化引擎** — Agent 自动分析对话，提出并应用改进方案
- **多 Agent 协作** — Supervisor 编排器，支持子 Agent 并行执行
- **IM 全平台网关** — 飞书 / 企业微信 / 钉钉 / 微信 / Telegram / Discord / Slack
- **安全沙箱** — Process / Docker / SSH 三级隔离执行代码
- **技能热加载** — Markdown 定义技能，运行时动态加载
- **MCP 工具集成** — Model Context Protocol 标准工具注册
- **语音交互** — STT（语音转文字）+ TTS（文字转语音）
- **Web 管理面板** — Next.js 全功能管理界面

---

## 系统要求

| 依赖 | 版本要求 | 用途 |
|------|---------|------|
| **Node.js** | >= 20.0.0 | API 服务 + Web 前端 |
| **pnpm** | >= 9.0.0 | monorepo 包管理 |
| **Python** | >= 3.10 | IM 网关服务 |
| **Git** | 任意版本 | 版本控制 |

> Python 和 IM 网关为**可选组件**。如果不需要 IM 平台接入，可以跳过 Python 安装，
> 在 `.env` 中设置 `DISABLE_IM_GATEWAY=true` 即可。

---

## 一键安装

### Windows

**前置条件安装：**

```powershell
# 1. 安装 Node.js 20+（如果已安装可跳过）
#    推荐方式：从 https://nodejs.org/ 下载 LTS 版本安装包
#    或使用 winget：
winget install OpenJS.NodeJS.LTS

# 2. 安装 pnpm
npm install -g pnpm

# 3. 安装 Python 3.10+（如需 IM 网关）
#    推荐方式：从 https://www.python.org/ 下载安装包
#    安装时勾选 "Add Python to PATH"
#    或使用 winget：
winget install Python.Python.3.12
```

**项目安装：**

```powershell
# 克隆仓库
git clone https://github.com/Louis830903/Super-Loong.git
cd Super-Loong

# 安装 Node.js 依赖（自动处理所有工作区包）
pnpm install

# 复制环境变量模板
Copy-Item .env.example .env

# （可选）安装 IM 网关 Python 依赖
cd services/im-gateway
pip install -e ".[all]"
cd ../..
```

---

### macOS

**前置条件安装：**

```bash
# 1. 安装 Homebrew（如果没有）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. 安装 Node.js 20+
brew install node@20

# 3. 安装 pnpm
npm install -g pnpm

# 4. 安装 Python 3.10+（如需 IM 网关）
brew install python@3.12
```

**项目安装：**

```bash
# 克隆仓库
git clone https://github.com/Louis830903/Super-Loong.git
cd Super-Loong

# 安装 Node.js 依赖
pnpm install

# 复制环境变量模板
cp .env.example .env

# （可选）安装 IM 网关 Python 依赖
cd services/im-gateway
pip3 install -e ".[all]"
cd ../..
```

---

### Linux (Ubuntu/Debian)

**前置条件安装：**

```bash
# 1. 安装 Node.js 20+（通过 NodeSource）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. 安装 pnpm
npm install -g pnpm

# 3. 安装 Python 3.10+（如需 IM 网关）
sudo apt-get install -y python3 python3-pip python3-venv
```

**项目安装：**

```bash
# 克隆仓库
git clone https://github.com/Louis830903/Super-Loong.git
cd Super-Loong

# 安装 Node.js 依赖
pnpm install

# 复制环境变量模板
cp .env.example .env

# （可选）安装 IM 网关 Python 依赖
cd services/im-gateway
pip3 install -e ".[all]"
cd ../..
```

---

## 环境配置

编辑项目根目录的 `.env` 文件，配置必要的环境变量：

```bash
# ========================
# 必填项 — LLM 配置
# ========================
LLM_PROVIDER=openai          # 可选：openai / anthropic / ollama
LLM_MODEL=gpt-4o-mini        # 使用的模型名称
LLM_API_KEY=sk-your-key-here # 你的 API Key
# LLM_BASE_URL=              # 自定义 API 地址（可选，用于代理或 Ollama）

# ========================
# 可选项 — 服务配置
# ========================
# PORT=3001                  # API 服务端口（默认 3001）
# HOST=0.0.0.0               # 监听地址（默认 0.0.0.0）
# LOG_LEVEL=info              # 日志级别：debug / info / warn / error
# FRONTEND_URL=http://localhost:3000  # Web 前端地址（CORS 用）

# ========================
# 可选项 — 安全
# ========================
# JWT_SECRET=                 # JWT 签名密钥（生产环境必填）
# AUTH_ENABLED=false          # 启用 API 认证

# ========================
# 可选项 — IM 网关
# ========================
# DISABLE_IM_GATEWAY=true     # 设为 true 禁用 IM 网关自动启动
# IM_GATEWAY_URL=http://localhost:8642  # 网关地址
```

> **最小化启动**：只需配置 `LLM_PROVIDER`、`LLM_MODEL`、`LLM_API_KEY` 三项即可启动。

### 使用 Ollama（本地模型，免费）

如果你没有 OpenAI/Anthropic API Key，可以使用 [Ollama](https://ollama.com/) 运行本地模型：

```bash
# 1. 安装 Ollama（详见 https://ollama.com/download）
# 2. 拉取模型
ollama pull llama3.1

# 3. 在 .env 中配置
LLM_PROVIDER=ollama
LLM_MODEL=llama3.1
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama  # Ollama 不需要真实 key，填任意值即可
```

---

## 启动项目

### 开发模式（推荐）

```bash
# 一键启动所有服务（API + Web + Core watch）
pnpm dev
```

启动后访问：
- **Web 管理面板**：http://localhost:3000
- **API 服务**：http://localhost:3001
- **IM 网关**：http://localhost:8642（如已启用）

### 单独启动各服务

```bash
# 只启动 API 后端（端口 3001）
pnpm dev:api

# 只启动 Web 前端（端口 3000）
pnpm dev:web

# 只启动 IM 网关（需先安装 Python 依赖）
pnpm dev:gateway
# 或直接运行：
cd services/im-gateway && python server.py
```

### 生产构建

```bash
# 构建所有包
pnpm build

# 启动生产服务
NODE_ENV=production node packages/api/dist/index.js
```

---

## 项目结构

```
Super-Loong/
├── packages/
│   ├── core/           # SDK 核心库 — Agent 运行时、记忆、LLM、工具
│   ├── api/            # Fastify 5 HTTP API 服务
│   ├── web/            # Next.js 16 Web 管理面板
│   └── research/       # 研究评估工具（实验性）
├── services/
│   └── im-gateway/     # Python FastAPI IM 网关
│       ├── channels/   # 平台适配器（飞书/企微/钉钉/微信等）
│       ├── core/       # 网关核心（消息管线、路由、去重）
│       └── scripts/    # WeClaw 微信桥接安装脚本
├── data/               # 运行时数据目录（自动创建）
│   ├── MEMORY.md       # Agent 笔记（自动维护）
│   ├── SOUL.md         # Agent 人设（人工编辑）
│   └── USER.md         # 用户档案（自动维护）
├── .env.example        # 环境变量模板
├── package.json        # monorepo 根配置
├── pnpm-workspace.yaml # 工作区定义
└── LICENSE             # MIT 开源协议
```

### 数据存储说明

应用数据默认存储在 `~/.super-agent/` 目录下（用户主目录），包含：

| 文件/目录 | 说明 | 自动创建 |
|----------|------|---------|
| `super-agent.db` | SQLite 主数据库 | 是 |
| `sessions/` | 会话 JSONL 转录 | 是 |
| `skills/` | 技能热加载目录 | 是 |
| `cache/` | 临时缓存 | 是 |
| `backups/` | 数据库备份 | 是 |

> 可通过环境变量 `SA_HOME` 自定义数据存储路径。

---

## IM 平台接入（可选）

Super Loong 支持 8 个 IM 平台的双向消息互通。接入前需先安装 Python 依赖。

### 支持的平台

| 平台 | 协议 | 安装命令 |
|------|------|---------|
| 飞书 (Feishu) | WebSocket / Webhook | `pip install -e ".[feishu]"` |
| 企业微信 (WeCom) | WebSocket | `pip install -e ".[wecom]"` |
| 钉钉 (DingTalk) | Stream | `pip install -e ".[dingtalk]"` |
| 微信 (WeChat) | WeClaw 桥接 | `pip install -e ".[weixin]"` |
| Telegram | Webhook | `pip install -e ".[telegram]"` |
| Discord | Gateway | `pip install -e ".[discord]"` |
| Slack | Socket Mode | `pip install -e ".[slack]"` |
| 全部安装 | — | `pip install -e ".[all]"` |

### 飞书接入示例

1. 在 [飞书开放平台](https://open.feishu.cn/) 创建应用，获取 `App ID` 和 `App Secret`
2. 编辑 `services/im-gateway/.env`：

```bash
FEISHU_APP_ID=cli_your_app_id
FEISHU_APP_SECRET=your_app_secret
FEISHU_MODE=websocket
```

3. 在 Web 管理面板 → 通道管理 → 添加飞书通道，或通过 API 配置

### 微信接入

微信接入需要 WeClaw 桥接工具：

```bash
# Windows
.\services\im-gateway\scripts\setup-weclaw.ps1

# macOS / Linux
bash services/im-gateway/scripts/setup-weclaw.sh
```

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm install` | 安装所有依赖 |
| `pnpm dev` | 一键启动开发模式（所有服务并行） |
| `pnpm dev:api` | 只启动 API 服务 |
| `pnpm dev:web` | 只启动 Web 前端 |
| `pnpm dev:gateway` | 只启动 IM 网关 |
| `pnpm build` | 构建所有包 |
| `pnpm clean` | 清理所有构建产物 |
| `pnpm test` | 运行测试 |
| `pnpm lint` | 代码检查 |
| `pnpm typecheck` | TypeScript 类型检查 |

---

## 常见问题

### Q: `pnpm install` 报错 better-sqlite3 编译失败？

**A:** 本项目使用 `sql.js`（WASM 版 SQLite），不依赖原生 `better-sqlite3`。如果报错，可以忽略或在 `.npmrc` 中添加：
```
ignore-scripts=true
```

### Q: 启动时提示 "LLM_API_KEY not configured"？

**A:** 编辑 `.env` 文件，填入你的 LLM API Key。支持 OpenAI、Anthropic 或本地 Ollama。

### Q: Python 网关启动失败？

**A:** 确认：
1. Python 版本 >= 3.10：`python --version`
2. 已安装依赖：`cd services/im-gateway && pip install -e ".[all]"`
3. 或设置 `DISABLE_IM_GATEWAY=true` 跳过网关

### Q: Web 前端打开空白？

**A:** 确认 API 服务已启动（http://localhost:3001），Web 前端通过代理连接 API。建议使用 `pnpm dev` 同时启动所有服务。

### Q: 数据存储在哪里？

**A:** 默认存储在用户主目录 `~/.super-agent/`。可通过环境变量 `SA_HOME` 自定义路径。首次启动时自动创建所有必要的目录和数据库。

### Q: 如何使用自定义/代理 API 地址？

**A:** 在 `.env` 中设置 `LLM_BASE_URL`：
```bash
LLM_BASE_URL=https://your-proxy.example.com/v1
```

### Q: 如何在服务器上部署？

**A:** 推荐使用 PM2 或 Docker：
```bash
# PM2 方式
pnpm build
pm2 start packages/api/dist/index.js --name super-agent-api

# 前端可单独部署到 Vercel/Netlify
cd packages/web && pnpm build
```

---

## 许可证

[MIT](LICENSE) © 2026 Louis830903
