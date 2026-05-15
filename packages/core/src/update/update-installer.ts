/**
 * 一键自动更新安装模块 — Bootstrap Updater 模式。
 *
 * 设计原则：
 * - 不引入新 npm 依赖（解压用系统命令，复杂化模板内嵌 TS）
 * - 引导脚本独立于 API 进程生存（detached + unref）
 * - 下载 3 次重试 + 指数退避，容忍国内网络抖动
 * - 每步错误回滚：`pm2 stop all` 失败→中止；文件移动失败→从备份恢复
 * - 用户数据自动保全：`.env` / `logs/` / `data/` 从备份复制；
 *   `~/.super-agent/`（技能、数据库、配置）在 app 目录外天然不受影响
 */

import { spawn, execSync } from "node:child_process";
import { mkdir, writeFile, access, rm, readFile, copyFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";
import pino from "pino";

const logger = pino({ name: "update-installer" });

// ─── 类型定义 ─────────────────────────────────────

/** 安装结果 */
export interface InstallResult {
  success: boolean;
  /** 目标版本 */
  version: string;
  /** 失败时的错误消息 */
  error?: string;
  /** 安装阶段（用于前端进度展示） */
  stage?: "downloading" | "extracting" | "validating" | "staging" | "restarting";
  /** 下载进度（bytes） */
  downloaded?: number;
  /** 总大小（bytes） */
  total?: number;
}

/** 下载进度回调 */
export type ProgressCallback = (received: number, total: number) => void;

/** PM2 运行模式 */
export type RunMode = "pm2" | "direct";

// ─── 常量 ─────────────────────────────────────

/** 单次下载超时：10 分钟（便携包约 50MB+，国内网络可能较慢） */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** 重试次数 */
const MAX_RETRIES = 3;

/** 重试退避（秒） */
const RETRY_DELAYS = [1000, 2000, 4000];

// ═══════════════════════════════════════════════════════════════
// Windows PowerShell 引导脚本（模板字符串，运行时写入临时文件）
// ═══════════════════════════════════════════════════════════════

const POWERSHELL_TEMPLATE = `# Super Agent 自动更新引导脚本（Windows）— 增量替换版
# 设计原则：
#   C1 — 第一步立即停服，消除 PM2 竞态条件
#   C2 — 增量替换：只更新 api/core/web/node_modules/ + ecosystem.config.cjs
#        保留 services/（含 Python venv）、.env、logs/、data/ 不动
#   C3 — 每步检测退出码，失败时从备份恢复
#   C5 — 支持 PM2 / 直连双模式
param($TempDir, $AppDir, $Mode)

$ErrorActionPreference = "Stop"
$UpdaterLog = Join-Path $AppDir "logs\\update.log"

function Write-Log {
    param($Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts [Updater] $Message" | Out-File -FilePath $UpdaterLog -Append -Encoding utf8
    Write-Host "[Updater] $Message"
}

# 增量替换的四个 Node.js 子目录
$ReplaceDirs = @("api", "core", "web", "node_modules")

try {
    # === 第一步：立即停止所有服务（消除 PM2 竞态） ===
    Write-Log "Stopping all services..."
    if ($Mode -eq "pm2") {
        pm2 stop all 2>&1 | Out-File $UpdaterLog -Append -Encoding utf8
        if ($LASTEXITCODE -ne 0) {
            Write-Log "WARNING: pm2 stop returned non-zero, continuing..."
        }
        Start-Sleep -Seconds 3
    } else {
        Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 2
    }
    Write-Log "Services stopped."

    # === 第二步：备份 Node.js 子目录（增量，不动 services/） ===
    $ts = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupSuffix = ".old-$ts"
    Write-Log "Backing up api/core/web/node_modules (incremental)..."
    foreach ($dir in $ReplaceDirs) {
        $src = Join-Path $AppDir $dir
        if (Test-Path $src) {
            Move-Item $src "$src$backupSuffix"
            Write-Log "  $dir -> $dir$backupSuffix"
        } else {
            Write-Log "  $dir (not found, skip)"
        }
    }
    # 备份旧 ecosystem（便于回滚）
    $ecosystemPath = Join-Path $AppDir "ecosystem.config.cjs"
    if (Test-Path $ecosystemPath) {
        Copy-Item $ecosystemPath "$ecosystemPath$backupSuffix"
        Write-Log "  ecosystem.config.cjs (backup copy)"
    }
    Write-Log "Backup complete. services/ + .env + logs/ + data/ preserved."

    # === 第三步：增量部署新版本 ===
    $srcDir = Join-Path $TempDir "super-agent"
    Write-Log "Deploying new version (incremental)..."
    if (-not (Test-Path $srcDir)) {
        throw "Extracted directory not found: $srcDir"
    }
    foreach ($dir in $ReplaceDirs) {
        $src = Join-Path $srcDir $dir
        if (Test-Path $src) {
            Move-Item $src (Join-Path $AppDir $dir)
            Write-Log "  $dir deployed"
        } else {
            Write-Log "  WARNING: $dir missing from update package"
        }
    }
    # 替换 ecosystem.config.cjs（便携版用扁平路径）
    $newEcosystem = Join-Path $srcDir "ecosystem.config.cjs"
    if (Test-Path $newEcosystem) {
        Move-Item $newEcosystem $ecosystemPath -Force
        Write-Log "  ecosystem.config.cjs updated"
    } else {
        Write-Log "  WARNING: ecosystem.config.cjs missing from update package"
    }
    Write-Log "New version deployed (services/ untouched)."

    # === 第四步：重启服务 ===
    Write-Log "Restarting services (mode=$Mode)..."
    if ($Mode -eq "pm2") {
        if (-not (Test-Path $ecosystemPath)) {
            throw "ecosystem.config.cjs not found at $ecosystemPath"
        }
        pm2 start $ecosystemPath --env production 2>&1 | Out-File $UpdaterLog -Append -Encoding utf8
        if ($LASTEXITCODE -ne 0) {
            throw "pm2 start failed with exit code $LASTEXITCODE"
        }
        pm2 save 2>&1 | Out-File $UpdaterLog -Append -Encoding utf8
    } else {
        $apiPath = Join-Path $AppDir "api\\index.js"
        if (-not (Test-Path $apiPath)) {
            throw "api/index.js not found at $apiPath"
        }
        Start-Process node -ArgumentList $apiPath -WindowStyle Hidden
    }
    Write-Log "Update complete! Services restarted."

} catch {
    $errMsg = $_.Exception.Message
    Write-Log "ERROR: $errMsg"
    Write-Log "Attempting rollback (incremental)..."

    # 回滚：删除新部署的子目录，恢复备份
    foreach ($dir in $ReplaceDirs) {
        $target = Join-Path $AppDir $dir
        if (Test-Path $target) {
            Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
        }
        $backup = "$target$backupSuffix"
        if (Test-Path $backup) {
            Move-Item $backup $target
            Write-Log "  $dir restored from backup"
        }
    }
    # 恢复旧 ecosystem
    $ecoBackup = "$ecosystemPath$backupSuffix"
    if (Test-Path $ecoBackup) {
        Move-Item $ecoBackup $ecosystemPath -Force
        Write-Log "  ecosystem.config.cjs restored"
    }
    Write-Log "Rollback complete. Old version restored."

    # 尝试重启旧版服务
    try {
        if ($Mode -eq "pm2") {
            pm2 start $ecosystemPath --env production
        } else {
            Start-Process node -ArgumentList (Join-Path $AppDir "api\\index.js") -WindowStyle Hidden
        }
    } catch {
        Write-Log "WARNING: Failed to restart old version after rollback"
    }

    # 写错误日志
    $errorLog = Join-Path $AppDir "logs\\update-error.log"
    "$errMsg" | Out-File $errorLog -Encoding utf8
    exit 1
}
`;

// ═══════════════════════════════════════════════════════════════
// Linux/macOS Bash 引导脚本
// ═══════════════════════════════════════════════════════════════

const BASH_TEMPLATE = `#!/usr/bin/env bash
# Super Agent 自动更新引导脚本（Linux/macOS）— 增量替换版
set -euo pipefail

TEMP_DIR="$1"
APP_DIR="$2"
MODE="$3"
UPDATER_LOG="$APP_DIR/logs/update.log"

# 增量替换的四个 Node.js 子目录
REPLACE_DIRS=("api" "core" "web" "node_modules")

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [Updater] $1" | tee -a "$UPDATER_LOG"
}

# 增量回滚：删除新部署的子目录，恢复备份
rollback() {
    local err_msg="\$1"
    log "ERROR: $err_msg"
    log "Attempting rollback (incremental)..."

    for dir in "\${REPLACE_DIRS[@]}"; do
        if [ -d "$APP_DIR/$dir" ]; then
            rm -rf "$APP_DIR/$dir" 2>/dev/null || true
        fi
        if [ -d "$APP_DIR/$dir$BACKUP_SUFFIX" ]; then
            mv "$APP_DIR/$dir$BACKUP_SUFFIX" "$APP_DIR/$dir"
            log "  $dir restored from backup"
        fi
    done

    # 恢复旧 ecosystem
    if [ -f "$APP_DIR/ecosystem.config.cjs$BACKUP_SUFFIX" ]; then
        mv "$APP_DIR/ecosystem.config.cjs$BACKUP_SUFFIX" "$APP_DIR/ecosystem.config.cjs"
        log "  ecosystem.config.cjs restored"
    fi

    log "Rollback complete. Old version restored."

    # 尝试重启旧版服务
    if [ "$MODE" = "pm2" ]; then
        pm2 start "$APP_DIR/ecosystem.config.cjs" --env production || true
    else
        nohup node "$APP_DIR/api/index.js" > /dev/null 2>&1 &
    fi

    echo "$err_msg" > "$APP_DIR/logs/update-error.log" 2>/dev/null || true
    exit 1
}

mkdir -p "$(dirname "$UPDATER_LOG")" 2>/dev/null || true

# === 第一步：立即停止所有服务 ===
log "Stopping all services..."
if [ "$MODE" = "pm2" ]; then
    pm2 stop all >> "$UPDATER_LOG" 2>&1 || log "WARNING: pm2 stop returned non-zero"
    sleep 3
else
    pkill -f "node api/index.js" 2>/dev/null || true
    sleep 2
fi
log "Services stopped."

# === 第二步：备份 Node.js 子目录（增量，不动 services/） ===
BACKUP_SUFFIX=".old-$(date +%s)"
log "Backing up api/core/web/node_modules (incremental)..."
for dir in "\${REPLACE_DIRS[@]}"; do
    if [ -d "$APP_DIR/$dir" ]; then
        mv "$APP_DIR/$dir" "$APP_DIR/$dir$BACKUP_SUFFIX"
        log "  $dir -> $dir$BACKUP_SUFFIX"
    else
        log "  $dir (not found, skip)"
    fi
done
# 备份旧 ecosystem（便于回滚）
if [ -f "$APP_DIR/ecosystem.config.cjs" ]; then
    cp "$APP_DIR/ecosystem.config.cjs" "$APP_DIR/ecosystem.config.cjs$BACKUP_SUFFIX"
    log "  ecosystem.config.cjs (backup copy)"
fi
log "Backup complete. services/ + .env + logs/ + data/ preserved."

# === 第三步：增量部署新版本 ===
SRC_DIR="$TEMP_DIR/super-agent"
if [ ! -d "$SRC_DIR" ]; then
    rollback "Extracted directory not found: $SRC_DIR"
fi
log "Deploying new version (incremental)..."
for dir in "\${REPLACE_DIRS[@]}"; do
    if [ -d "$SRC_DIR/$dir" ]; then
        mv "$SRC_DIR/$dir" "$APP_DIR/$dir"
        log "  $dir deployed"
    else
        log "  WARNING: $dir missing from update package"
    fi
done
# 替换 ecosystem.config.cjs（便携版用扁平路径）
if [ -f "$SRC_DIR/ecosystem.config.cjs" ]; then
    mv "$SRC_DIR/ecosystem.config.cjs" "$APP_DIR/ecosystem.config.cjs"
    log "  ecosystem.config.cjs updated"
else
    log "  WARNING: ecosystem.config.cjs missing from update package"
fi
log "New version deployed (services/ untouched)."

# === 第四步：重启 ===
log "Restarting services (mode=$MODE)..."
if [ "$MODE" = "pm2" ]; then
    [ -f "$APP_DIR/ecosystem.config.cjs" ] || rollback "ecosystem.config.cjs not found"
    pm2 start "$APP_DIR/ecosystem.config.cjs" --env production >> "$UPDATER_LOG" 2>&1 || rollback "pm2 start failed"
    pm2 save >> "$UPDATER_LOG" 2>&1
else
    [ -f "$APP_DIR/api/index.js" ] || rollback "api/index.js not found"
    nohup node "$APP_DIR/api/index.js" > /dev/null 2>&1 &
fi
log "Update complete! Services restarted."
`;

// ═══════════════════════════════════════════════════════════════
// 对外接口
// ═══════════════════════════════════════════════════════════════

/**
 * 执行一键更新安装。
 *
 * @param downloadUrl  便携包下载 URL
 * @param version       目标版本号
 * @param appDir        应用安装目录
 * @param onProgress    下载进度回调（可选）
 * @returns InstallResult
 */
export async function installUpdate(
  downloadUrl: string,
  version: string,
  appDir: string,
  onProgress?: ProgressCallback,
): Promise<InstallResult> {
  const tempDir = path.join(appDir, "temp", `update-v${version}`);

  try {
    // 1. 下载
    const zipPath = path.join(tempDir, "update.zip");
    await mkdir(tempDir, { recursive: true });
    const dlResult = await downloadZip(downloadUrl, zipPath, onProgress);
    if (!dlResult.success) {
      return { success: false, version, error: dlResult.error, stage: "downloading" };
    }

    // 2. 解压
    const extractDir = path.join(tempDir, "extracted");
    await mkdir(extractDir, { recursive: true });
    const exResult = await extractZip(zipPath, extractDir);
    if (!exResult.success) {
      return { success: false, version, error: exResult.error, stage: "extracting" };
    }

    // 3. 校验安装包
    const pkgDir = path.join(extractDir, "super-agent");
    const valResult = await validatePackage(pkgDir);
    if (!valResult.success) {
      return { success: false, version, error: valResult.error, stage: "validating" };
    }

    // 4. 生成引导脚本
    const pid = process.pid;
    const mode = detectRunMode();
    const scriptPath = await generateBootstrap(extractDir, appDir, pid, mode);

    // 5. 启动引导进程
    spawnBootstrap(scriptPath, extractDir, appDir, mode);

    return {
      success: true,
      version,
      stage: "restarting",
    };
  } catch (err: unknown) {
    const msg = (err as { message?: string }).message ?? String(err);
    logger.error({ err: msg, version }, "Update installation failed");
    // 清理临时文件
    try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { success: false, version, error: msg };
  }
}

// ─── 下载 ZIP ────────────────────────────────────

interface DownloadResult {
  success: boolean;
  error?: string;
}

async function downloadZip(
  url: string,
  destPath: string,
  onProgress?: ProgressCallback,
): Promise<DownloadResult> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[attempt - 1] ?? 4000;
        logger.info({ attempt, delay }, "Retrying download...");
        await new Promise((r) => setTimeout(r, delay));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Super-Agent-Update-Installer" },
      });

      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentLength = response.headers.get("content-length");
      const total = contentLength ? parseInt(contentLength, 10) : 0;
      let downloaded = 0;

      // 流式下载到文件，实时回调进度
      const body = response.body;
      if (!body) {
        throw new Error("Response body is null");
      }

      const fileStream = createWriteStream(destPath);
      const reader = body.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          downloaded += value.byteLength;
          if (onProgress && total > 0) {
            onProgress(downloaded, total);
          }
          fileStream.write(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
        fileStream.end();
      }

      // 等待文件完全写入
      await new Promise<void>((resolve, reject) => {
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
      });

      logger.info({ url, size: downloaded }, "Download complete");
      return { success: true };
    } catch (err: unknown) {
      const msg = (err as { message?: string }).message ?? String(err);
      lastError = msg;
      logger.warn({ attempt, err: msg }, "Download attempt failed");
    }
  }

  return { success: false, error: `下载失败（已重试${MAX_RETRIES}次）: ${lastError}` };
}

// ─── 解压 ZIP ────────────────────────────────────

interface ExtractResult {
  success: boolean;
  error?: string;
}

async function extractZip(zipPath: string, destDir: string): Promise<ExtractResult> {
  const platform = os.platform();

  try {
    if (platform === "win32") {
      // Windows: 使用 PowerShell Expand-Archive
      execSync(
        `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`,
        { stdio: "pipe", timeout: 120_000 },
      );
    } else {
      // Linux/macOS: 使用系统 unzip
      execSync(`unzip -o "${zipPath}" -d "${destDir}"`, {
        stdio: "pipe",
        timeout: 120_000,
      });
    }
    logger.info({ destDir }, "Extraction complete");
    return { success: true };
  } catch (err: unknown) {
    const msg = (err as { message?: string }).message ?? String(err);
    logger.error({ err: msg }, "Extraction failed");
    return { success: false, error: `解压失败: ${msg}` };
  }
}

// ─── 校验安装包 ──────────────────────────────────

interface ValidateResult {
  success: boolean;
  error?: string;
}

async function validatePackage(dir: string): Promise<ValidateResult> {
  const required = [
    "api/index.js",
    "node_modules",
    "core",
  ] as const;

  for (const rel of required) {
    const full = path.join(dir, rel);
    try {
      await access(full);
    } catch {
      return { success: false, error: `安装包缺少关键文件: ${rel}` };
    }
  }

  logger.info("Package validation passed");
  return { success: true };
}

// ─── 生成引导脚本 ────────────────────────────────

async function generateBootstrap(
  extractDir: string,
  appDir: string,
  _pid: number,
  mode: RunMode,
): Promise<string> {
  const platform = os.platform();
  let scriptPath: string;
  let scriptContent: string;

  if (platform === "win32") {
    scriptPath = path.join(extractDir, "updater.ps1");
    scriptContent = POWERSHELL_TEMPLATE;
  } else {
    scriptPath = path.join(extractDir, "updater.sh");
    scriptContent = BASH_TEMPLATE;
  }

  await writeFile(scriptPath, scriptContent, { encoding: "utf-8", mode: 0o755 });

  // 将实际参数写入脚本旁的 args 文件（避免命令行转义问题）
  const argsPath = path.join(extractDir, "updater-args.txt");
  await writeFile(argsPath, JSON.stringify({ extractDir, appDir, mode }), "utf-8");

  logger.info({ scriptPath, mode }, "Bootstrap script generated");
  return scriptPath;
}

// ─── 启动引导进程 ────────────────────────────────

function spawnBootstrap(
  scriptPath: string,
  extractDir: string,
  appDir: string,
  mode: RunMode,
): void {
  const platform = os.platform();
  let command: string;
  let args: string[];

  if (platform === "win32") {
    command = "powershell.exe";
    args = [
      "-ExecutionPolicy", "Bypass",
      "-NoProfile",
      "-File", scriptPath,
      "-TempDir", extractDir,
      "-AppDir", appDir,
      "-Mode", mode,
    ];
  } else {
    command = "bash";
    args = [scriptPath, extractDir, appDir, mode];
  }

  logger.info({ command, args }, "Spawning bootstrap process");

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  // 解除父子关系，确保 API 退出后引导脚本继续运行
  child.unref();

  logger.info({ pid: child.pid }, "Bootstrap spawned, API will exit");
}

// ─── 检测运行模式 ────────────────────────────────

/**
 * 检测当前进程是否由 PM2 管理。
 * PM2 会设置 pm_id 环境变量。
 */
export function detectRunMode(): RunMode {
  if (process.env.pm_id !== undefined) {
    return "pm2";
  }
  return "direct";
}
