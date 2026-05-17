# 🚀 方案A：源码 + PM2 生产环境常驻部署指南

> **保姆级教程 — 从零到常驻后台，5 步搞定**

本方案使用 **PM2 进程守护** + **源码构建** 的方式部署 Super Agent。部署完成后，程序会开机自启、崩溃自动恢复、24 小时常驻后台。

---

## 📋 方案概览

```
┌──────────────────────────────────────────────────────────┐
│                      PM2 进程守护                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │  API 服务 │  │ Web 前端 │  │ IM 网关  │  │视频引擎  │ │
│  │ (Node.js)│  │(Next.js) │  │ (Python) │  │ (Python) │ │
│  │  :3001   │  │  :3000   │  │  :8642   │  │  :8720   │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │
│       ↑              ↑              ↑             ↑       │
│       └──────────────┴──────────────┴─────────────┘       │
│                    崩溃自动重启                              │
│                    开机自动启动                              │
│                    日志统一收集                              │
└──────────────────────────────────────────────────────────┘
```

| 特性 | 说明 |
|------|------|
| **进程守护** | PM2 管理 4 个进程，崩溃自动拉起 |
| **开机自启** | 重启电脑后自动恢复所有服务 |
| **内存保护** | API 进程超过 512MB 自动重启 |
| **崩溃保护** | 10 秒内崩溃超过 5 次停止重试 |
| **配置隔离** | `.env.production` 独立于开发环境 |
| **跨平台** | Windows / Linux / macOS 一套配置复用 |

---

## ⏱️ 时间预估

| 步骤 | 耗时 | 说明 |
|------|:---:|------|
| 安装 Node.js + Git | 5~15 分钟 | 首次需要下载安装包 |
| 下载项目 | 1~5 分钟 | 取决于网速 |
| 安装依赖 | 3~10 分钟 | `pnpm install` 自动完成 |
| 配置密钥 | 2~5 分钟 | 获取 API Key + 填写 `.env.production` |
| 构建 + 启动 | 2~5 分钟 | `pnpm build` + `start.bat` |

> 💡 **总计约 15~40 分钟**，大部分时间花在下载上。

---

## 第一步：环境准备

### 1.1 安装 Node.js（必需）

Node.js 是程序运行的"引擎"，版本要求 **≥ 20.0.0**。

**下载地址**：
- 官网：https://nodejs.org （选 LTS 版本）
- 国内镜像：https://npmmirror.com/mirrors/node/ （选 `v20.x.x` 或更高，下载 `.msi`）

**验证安装**：
```powershell
node --version   # 应显示 v20.x.x 或更高
npm --version    # 应显示 10.x.x 或更高
```

### 1.2 安装 Git（必需）

Git 用于下载项目代码。

**下载地址**：
- 官网：https://git-scm.com/download/win
- 国内镜像：https://npmmirror.com/mirrors/git-for-windows/

**验证安装**：
```powershell
git --version    # 应显示 git version 2.x.x
```

### 1.3 安装 Python（可选，按需）

> 如果你**不需要**以下功能，可跳过此步：
> - 飞书/钉钉/企微 IM 网关
> - 视频生成
> - PDF/Word/PPT 文档解析

**版本要求**：Python ≥ 3.11

**下载地址**：
- 官网：https://www.python.org/downloads/
- 国内镜像：https://npmmirror.com/mirrors/python/

⚠️ **安装时务必勾选 "Add Python to PATH"！**

**验证安装**：
```powershell
python --version   # 应显示 Python 3.11.x 或更高
```

---

## 第二步：下载项目源码

### 方式一：Git 克隆（推荐）

```powershell
# 从 GitHub 克隆
git clone https://github.com/Louis830903/Super-Loong.git
cd Super-Loong
```

> 📌 **GitHub 访问慢？** 改用 Gitee 镜像：
> ```powershell
> git clone https://gitee.com/louis830903/Super-Loong.git
> cd Super-Loong
> ```

### 方式二：下载 ZIP 包

1. 打开 https://github.com/Louis830903/Super-Loong
2. 点击绿色 **Code** 按钮 → **Download ZIP**
3. 解压到你想放的目录（如 `D:\Super-Loong`）
4. 在 PowerShell 中进入该目录

---

## 第三步：安装项目依赖

### 3.1 安装 pnpm（全局）

Super Agent 使用 `pnpm` 管理依赖，比 npm 快 3 倍：

```powershell
npm install -g pnpm
```

**验证**：
```powershell
pnpm --version    # 应显示 9.x.x 或更高
```

### 3.2 安装项目依赖

```powershell
pnpm install
```

> 📌 这步会根据 `pnpm-workspace.yaml` 自动安装所有子包（core、api、web）的依赖。

### 3.3 安装 Python 微服务依赖（可选，按需）

如果你需要 IM 网关、视频生成或文档解析：

```powershell
# IM 网关
python -m pip install -r services\im-gateway\requirements.txt

# 视频生成
python -m pip install -r services\video-forge\requirements.txt

# 文档解析
python -m pip install -r services\kb-parser\requirements.txt
```

> `start.bat` 会在启动时自动检查并安装这些依赖，你也可以手动安装。

---

## 第四步：配置生产环境

### 4.1 创建生产环境变量文件

```powershell
copy .env.example .env.production
```

### 4.2 编辑 `.env.production`，填入必填项

用记事本打开：
```powershell
notepad .env.production
```

**必须修改的 3 项**：

```bash
# 1. JWT 密钥（安全令牌签名用）
# 生成方式：node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=a1b2c3d4e5f6...（粘贴你生成的 128 位十六进制字符串）

# 2. 凭据加密密钥（保护 API Key 等敏感数据）
# 生成方式：openssl rand -hex 32
SA_ENCRYPTION_KEY=d4e5f6a1b2c3...（粘贴你生成的 64 位十六进制字符串）

# 3. 大模型 API Key（至少配置一个）
LLM_API_KEY=sk-your-real-api-key-here
```

### 4.3 完整配置项速查

| 环境变量 | 必填 | 说明 |
|----------|:---:|------|
| `JWT_SECRET` | ✅ | JWT 令牌签名密钥，128 位十六进制 |
| `SA_ENCRYPTION_KEY` | ✅ | 凭据加密密钥，64 位十六进制 |
| `LLM_API_KEY` | ✅ | 大模型 API Key |
| `LLM_PROVIDER` | ❌ | 默认 `qwen` |
| `LLM_MODEL` | ❌ | 默认 `qwen-plus` |
| `LLM_BASE_URL` | ❌ | 自定义 API 地址时填写 |
| `LOG_LEVEL` | ❌ | 生产环境建议 `warn` |
| `FRONTEND_URL` | ❌ | 前端地址，默认 `http://localhost:3000` |
| `IM_GATEWAY_URL` | ❌ | IM 网关地址，默认 `http://localhost:8642` |
| `DISABLE_IM_GATEWAY` | ❌ | 设为 `true` 禁用 IM 功能 |
| `DISABLE_VIDEO_FORGE` | ❌ | 设为 `true` 禁用视频生成 |

### 4.4 各厂商 API Key 配置

| 厂商 | 环境变量 | 获取地址 |
|------|----------|----------|
| 阿里千问 | `DASHSCOPE_API_KEY` | https://dashscope.aliyun.com |
| DeepSeek | `DEEPSEEK_API_KEY` | https://platform.deepseek.com |
| 智谱 GLM | `ZHIPU_API_KEY` | https://open.bigmodel.cn |
| Kimi | `MOONSHOT_API_KEY` | https://platform.moonshot.cn |
| 豆包 | `ARK_API_KEY` | https://console.volcengine.com |
| MiniMax | `MINIMAX_API_KEY` | https://platform.minimaxi.com |
| OpenAI | `OPENAI_API_KEY` | https://platform.openai.com |
| 本地 Ollama | `OLLAMA_BASE_URL` | 无需 Key，本地安装即可 |

> 💡 **至少配置一个**。推荐阿里千问（国内访问快、价格低）。

---

## 第五步：构建并启动

### 5.1 构建生产产物

```powershell
pnpm build
```

> 这步会编译所有 TypeScript 代码，生成 `packages/api/dist/` 和 `packages/web/.next/`。

**构建输出**：
```
packages/api/dist/index.js    ← API 入口
packages/web/.next/            ← Next.js 前端构建产物
```

### 5.2 一键启动

**Windows**：
```powershell
start.bat
```

**Linux / macOS**：
```bash
chmod +x start.sh
./start.sh
```

`start.bat` / `start.sh` 会自动完成：
1. 检查 PM2 是否安装（未安装则自动安装）
2. 检查构建产物是否存在（不存在则自动构建）
3. 检查 Python 微服务依赖（按需安装）
4. 启动所有 4 个服务进程
5. 配置系统开机自启

### 5.3 启动成功标志

看到以下输出说明成功：

```
  ╔══════════════════════════════════════════╗
  ║     Super Agent 生产模式已启动！         ║
  ╚══════════════════════════════════════════╝

   管理面板: http://localhost:3000
   API 服务:  http://localhost:3001
   IM 网关:   http://localhost:8642
```

---

## 🛠️ 日常管理

### 查看服务状态

```powershell
# 方式一：脚本命令
start.bat status

# 方式二：npm 命令
pnpm status:prod

# 方式三：直接 PM2
pm2 status
```

**正常输出**：
```
┌─────┬──────────────────────────┬─────────┬─────────┬──────────┐
│ id  │ name                     │ status  │ restart │ uptime   │
├─────┼──────────────────────────┼─────────┼─────────┼──────────┤
│ 0   │ super-agent-api          │ online  │ 0       │ 2h       │
│ 1   │ super-agent-web          │ online  │ 0       │ 2h       │
│ 2   │ super-agent-gateway      │ online  │ 0       │ 2h       │
│ 3   │ super-agent-video-forge  │ online  │ 0       │ 2h       │
└─────┴──────────────────────────┴─────────┴─────────┴──────────┘
```

### 查看日志

```powershell
# 实时查看所有服务日志
start.bat logs

# 只看 API 日志
pm2 logs super-agent-api

# 查看错误日志（最近 50 行）
pm2 logs super-agent-api --err --lines 50
```

### 重启服务

```powershell
# 重启所有
start.bat restart

# 只重启 API
pm2 restart super-agent-api
```

### 停止服务

```powershell
start.bat stop
```

### 常用 PM2 命令速查

| 命令 | 作用 |
|------|------|
| `pm2 status` | 查看所有进程状态 |
| `pm2 logs` | 实时日志 |
| `pm2 restart all` | 重启所有 |
| `pm2 stop all` | 停止所有 |
| `pm2 delete all` | 删除所有（从 PM2 列表移除） |
| `pm2 save` | 保存当前进程列表（重启后恢复） |
| `pm2 monit` | 终端监控面板（CPU/内存） |
| `pm2 flush` | 清空日志 |

---

## 🏗️ 架构详解

### PM2 进程架构

`ecosystem.config.cjs` 定义了 4 个平级进程：

```
PM2 Daemon
├── super-agent-api (Node.js)
│   ├── 脚本: packages/api/dist/index.js
│   ├── 端口: 3001
│   ├── 内存限制: 512MB 自动重启
│   ├── 就绪检测: process.send('ready')
│   └── 环境: DISABLE_IM_GATEWAY=true, DISABLE_VIDEO_FORGE=true
│
├── super-agent-web (Next.js)
│   ├── 脚本: node_modules/next/dist/bin/next start -p 3000
│   ├── 工作目录: ./packages/web
│   ├── 端口: 3000
│   └── 崩溃保护: 10s 内 5 次停止
│
├── super-agent-gateway (Python)
│   ├── 解释器: python
│   ├── 脚本: services/im-gateway/server.py
│   ├── 端口: 8642
│   └── 环境: PYTHONUNBUFFERED=1
│
└── super-agent-video-forge (Python)
    ├── 解释器: python
    ├── 脚本: services/video-forge/main.py
    ├── 端口: 8720
    └── 环境: VIDEO_FORGE_RELOAD=0
```

### 为什么 PM2 直接管理 Python 进程？

Windows 上 PM2 fork 模式下，Node.js 子进程的 PATH 和权限环境与交互式终端不一致。如果让 API 内部 `spawn` Python 子进程（GatewayLauncher），可能会因找不到 `python` 命令或权限不足而失败。

**解决方案**：PM2 使用 `interpreter: "python"` 直接管理 Python 进程，API 内部通过 `DISABLE_IM_GATEWAY=true` 和 `DISABLE_VIDEO_FORGE=true` 禁用嵌套 spawn。

### 文件结构

```
super-agent/
├── start.bat                 ← Windows 一键启动脚本
├── start.sh                  ← Linux/macOS 一键启动脚本
├── ecosystem.config.cjs      ← PM2 进程配置
├── .env.production           ← 生产环境变量（不提交 Git）
├── .env.example              ← 环境变量参考模板
├── package.json              ← npm scripts（start:prod 等）
├── packages/
│   ├── api/dist/index.js     ← API 构建产物
│   └── web/.next/            ← 前端构建产物
├── services/
│   ├── im-gateway/server.py  ← IM 网关入口
│   └── video-forge/main.py   ← 视频引擎入口
└── logs/                     ← PM2 日志目录（自动创建）
    ├── pm2-api-error.log
    ├── pm2-api-out.log
    ├── pm2-web-error.log
    ├── pm2-web-out.log
    ├── pm2-gateway-error.log
    ├── pm2-gateway-out.log
    ├── pm2-video-forge-error.log
    └── pm2-video-forge-out.log
```

---

## 🔄 更新升级

当有新版本代码时：

```powershell
# 1. 拉取最新代码
git pull

# 2. 安装可能新增的依赖
pnpm install

# 3. 重新构建
pnpm build

# 4. 重启服务
start.bat restart
```

---

## 🆘 常见问题

### Q1: 启动后 `pm2 status` 显示 `errored` 或 `stopped`

**检查日志**：
```powershell
pm2 logs --err --lines 20
```

**常见原因**：
- `.env.production` 中 `JWT_SECRET` 或 `SA_ENCRYPTION_KEY` 未填写
- 端口被占用（3000/3001/8642）

**解决端口占用**：
```powershell
# 查找占用端口的进程
netstat -ano | findstr :3001

# 强制终止（替换 PID）
taskkill /PID <PID> /F
```

### Q2: API 启动后一直显示 `launching`，不变成 `online`

这说明 API 60 秒内未发送 `process.send('ready')` 信号。

**可能原因**：
- 内置 Agent 注册卡住（已修复，当前版本通过 `lightweight` 模式 200ms 完成）
- 数据库文件损坏

**解决**：
```powershell
# 备份并重置数据库
move data\super-agent.db data\super-agent.db.bak
start.bat restart
```

### Q3: Python 进程报错 `python: command not found`

**原因**：Python 未安装或未加入 PATH。

**解决**：
1. 确认 Python 已安装：`python --version`
2. 如果未安装，按第一步 1.3 安装
3. 如果已安装但找不到命令，重新安装并勾选 "Add Python to PATH"
4. 安装后**重启 PowerShell**

### Q4: 某个 Python 微服务不需要，如何禁用？

编辑 `ecosystem.config.cjs`，注释掉对应进程定义。例如禁用视频生成：

```javascript
// 在 apps 数组中注释掉 super-agent-video-forge 定义块
```

或者在 `.env.production` 中设置 `DISABLE_VIDEO_FORGE=true`，PM2 中对应进程会启动但可手动停止。

### Q5: 如何修改服务端口？

编辑 `.env.production`：
```bash
PORT=3001          # API 端口
```

编辑 `ecosystem.config.cjs`，修改 Web 端口：
```javascript
args: "start -p 3000",   // 改为你想要的端口
```

修改后重启：
```powershell
start.bat restart
```

### Q6: 电脑重启后服务没有自动启动

**Windows**：
```powershell
# 重新配置开机自启
npm install -g pm2-windows-startup
pm2 save
pm2 startup
```

**Linux (systemd)**：
```bash
pm2 startup systemd -u $(whoami) --hp $HOME
pm2 save
```

### Q7: PM2 日志文件太大

```powershell
# 清空所有日志
pm2 flush

# 安装日志轮转模块（自动按大小切割）
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

### Q8: 外网访问

如果你想让其他设备访问 Super Agent：

1. 防火墙开放端口 3000（前端）
2. 修改 `.env.production`：
   ```bash
   FRONTEND_URL=http://你的IP:3000
   ```
3. 访问 `http://你的IP:3000`

> ⚠️ **安全警告**：外网访问务必设置强 `JWT_SECRET`，不要使用默认空值！

---

## 🗑️ 卸载方法

```powershell
# 1. 停止所有服务
start.bat stop

# 2. 从 PM2 移除
pm2 delete all

# 3. 禁用开机自启
pm2 unstartup

# 4. 删除项目目录
cd ..
rmdir /s Super-Loong

# 5. (可选) 卸载 PM2
npm uninstall -g pm2 pm2-windows-startup
```

---

## 📊 系统资源消耗

| 进程 | 内存 | CPU（空闲） | 磁盘 |
|------|:---:|:---:|------|
| super-agent-api | ~150-300MB | ~1% | SQLite 数据库 ~10-50MB |
| super-agent-web | ~80-150MB | ~1% | .next 构建产物 ~50MB |
| super-agent-gateway | ~50-100MB | ~0.5% | 日志 |
| super-agent-video-forge | ~100-200MB | ~0.5% | 模型缓存 |

> 💡 **最低配置建议**：4 核 CPU、8GB 内存、10GB 空闲磁盘。

---

## ✅ 部署清单

部署前逐项确认：

- [ ] Node.js ≥ 20.0.0 已安装
- [ ] Git 已安装
- [ ] pnpm ≥ 9.0.0 已安装
- [ ] 项目源码已下载
- [ ] `pnpm install` 执行成功
- [ ] Python 依赖已安装（如需 IM/视频/文档解析）
- [ ] `.env.production` 已创建
- [ ] `JWT_SECRET` 已填写（128 位十六进制强密钥）
- [ ] `SA_ENCRYPTION_KEY` 已填写（64 位十六进制强密钥）
- [ ] 至少一个 LLM API Key 已填写
- [ ] `pnpm build` 执行成功
- [ ] `start.bat` / `start.sh` 执行成功
- [ ] `pm2 status` 显示 4 个进程 `online`
- [ ] `http://localhost:3000` 可正常打开

---

> 📝 **提示**：本指南只覆盖方案A（源码 + PM2）。如果你需要 Docker 部署或离线便携包部署，请参考 `超级安装部署指南.md`。
