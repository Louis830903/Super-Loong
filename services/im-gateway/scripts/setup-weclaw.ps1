<# 
.SYNOPSIS
    Super Agent - 微信 ClawBot 接入安装脚本 (WeClaw)

.DESCRIPTION
    自动安装 WeClaw 桥接工具，配置连接到 Super Agent IM 网关，
    启动服务并提示用户扫码绑定微信 ClawBot。

.NOTES
    前置条件:
    - 微信已安装 ClawBot 插件
    - Node.js 18+ 环境
    - Super Agent IM 网关已启动 (默认 :8642)
#>

param(
    [string]$GatewayUrl = "http://localhost:8642",
    [string]$ApiKey = "",
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Fail { param([string]$msg) Write-Host "  [X] $msg" -ForegroundColor Red }

Write-Host "`n========================================" -ForegroundColor Magenta
Write-Host "  Super Agent - WeChat ClawBot Setup" -ForegroundColor Magenta
Write-Host "========================================`n" -ForegroundColor Magenta

# ── Step 1: 检测 Node.js ──────────────────────────────────
Write-Step "检测 Node.js 环境"
try {
    $nodeVersion = & node --version 2>&1
    if ($nodeVersion -match "v(\d+)\.") {
        $major = [int]$Matches[1]
        if ($major -ge 18) {
            Write-Ok "Node.js $nodeVersion (>= 18)"
        } else {
            Write-Fail "Node.js 版本过低 ($nodeVersion)，需要 18+"
            exit 1
        }
    }
} catch {
    Write-Fail "未找到 Node.js，请先安装 Node.js 18+ (https://nodejs.org)"
    exit 1
}

# ── Step 2: 检测 IM 网关连通性 ────────────────────────────
Write-Step "检测 IM Gateway 连通性"
try {
    $healthResp = Invoke-RestMethod -Uri "$GatewayUrl/health" -TimeoutSec 5
    if ($healthResp.status -eq "ok") {
        Write-Ok "IM Gateway 在线 ($GatewayUrl)"
    } else {
        Write-Warn "IM Gateway 返回异常状态: $($healthResp.status)"
    }
} catch {
    Write-Fail "无法连接 IM Gateway ($GatewayUrl)"
    Write-Host "  请先启动 IM 网关: cd services/im-gateway; python server.py" -ForegroundColor Gray
    exit 1
}

# ── Step 3: 安装 WeClaw ──────────────────────────────────
if (-not $SkipInstall) {
    Write-Step "安装 WeClaw 桥接工具"
    
    # 检查是否已安装
    $weclawPath = Get-Command weclaw -ErrorAction SilentlyContinue
    if ($weclawPath) {
        $weclawVer = & weclaw --version 2>&1
        Write-Ok "WeClaw 已安装 ($weclawVer)"
    } else {
        Write-Host "  正在下载并安装 WeClaw..." -ForegroundColor Gray
        try {
            # WeClaw 官方安装脚本（Windows 用 PowerShell 下载）
            $installUrl = "https://github.com/fastclaw-ai/weclaw/releases/latest/download/weclaw-windows-amd64.exe"
            $installDir = "$env:LOCALAPPDATA\weclaw"
            $installPath = "$installDir\weclaw.exe"
            
            New-Item -ItemType Directory -Force -Path $installDir | Out-Null
            Invoke-WebRequest -Uri $installUrl -OutFile $installPath -UseBasicParsing
            
            # 添加到 PATH
            $envPath = [Environment]::GetEnvironmentVariable("Path", "User")
            if ($envPath -notlike "*$installDir*") {
                [Environment]::SetEnvironmentVariable("Path", "$envPath;$installDir", "User")
                $env:Path += ";$installDir"
            }
            
            Write-Ok "WeClaw 已安装到 $installPath"
        } catch {
            Write-Warn "自动安装失败，请手动安装 WeClaw"
            Write-Host "  参考: https://github.com/fastclaw-ai/weclaw" -ForegroundColor Gray
        }
    }
}

# ── Step 4: 生成配置文件 ─────────────────────────────────
Write-Step "生成 WeClaw 配置文件"
$configDir = "$env:USERPROFILE\.weclaw"
$configPath = "$configDir\config.json"

New-Item -ItemType Directory -Force -Path $configDir | Out-Null

$config = @{
    agents = @{
        "super-agent" = @{
            type = "http"
            endpoint = "$GatewayUrl/weclaw/chat"
            headers = @{}
            default = $true
        }
    }
}

# 如果提供了 API Key，添加到 headers
if ($ApiKey) {
    $config.agents."super-agent".headers["X-API-Key"] = $ApiKey
}

$config | ConvertTo-Json -Depth 5 | Set-Content -Path $configPath -Encoding UTF8
Write-Ok "配置已写入 $configPath"
Write-Host "  endpoint: $GatewayUrl/weclaw/chat" -ForegroundColor Gray

# ── Step 5: 启动 WeClaw ─────────────────────────────────
Write-Step "启动 WeClaw"
Write-Host ""
Write-Host "  请执行以下命令启动 WeClaw 并扫码绑定微信:" -ForegroundColor Yellow
Write-Host ""
Write-Host "    weclaw start" -ForegroundColor White
Write-Host ""
Write-Host "  启动后:" -ForegroundColor Gray
Write-Host "    1. 用微信扫描终端显示的二维码" -ForegroundColor Gray
Write-Host "    2. 在微信 ClawBot 插件中确认绑定" -ForegroundColor Gray
Write-Host "    3. 发送消息测试 (例: '你好')" -ForegroundColor Gray
Write-Host ""

# ── Step 6: 验证连通性 ──────────────────────────────────
Write-Step "验证 WeClaw 端点"
try {
    $statusResp = Invoke-RestMethod -Uri "$GatewayUrl/weclaw/status" -TimeoutSec 5
    Write-Ok "WeClaw 端点正常 (/weclaw/status)"
} catch {
    Write-Warn "WeClaw 端点暂不可达 (可能需要先启动 weclaw start)"
}

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  安装完成!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  常用命令:" -ForegroundColor Gray
Write-Host "    weclaw start     - 启动 WeClaw (前台运行)" -ForegroundColor Gray
Write-Host "    weclaw start -d  - 后台启动" -ForegroundColor Gray
Write-Host "    weclaw status    - 查看运行状态" -ForegroundColor Gray
Write-Host "    weclaw stop      - 停止服务" -ForegroundColor Gray
Write-Host ""
