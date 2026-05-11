/**
 * PlatformAdapter — 跨平台适配层
 *
 * 提供统一的平台检测、Shell选择、路径规范化和跨平台命令映射。
 * 所有后续工具模块（终端引擎/运维/开发/桌面）通过本模块自动适配 macOS/Linux/Windows。
 *
 * 设计原则:
 * - 纯函数 + 惰性单例缓存，零副作用
 * - 复用 readiness.ts 的检测思路（hasBinary 安全白名单 + which/where）
 * - 与现有 code-exec.ts 的 findPowerShell() 保持一致的 pwsh 优先策略
 */

import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import pino from "pino";
import { validateShellArg } from "../security/shell-arg-security.js";

const logger = pino({ name: "platform-adapter" });

// ─── 核心类型定义 ──────────────────────────────────────────

/** 支持的操作系统标识 */
export type OSPlatform = "darwin" | "linux" | "win32";

/** 统一平台信息（惰性初始化后不可变） */
export interface PlatformInfo {
  /** 操作系统: 'darwin' | 'linux' | 'win32' */
  os: OSPlatform;
  /** 人类可读的OS标签: 'macos' | 'linux' | 'windows' */
  osLabel: string;
  /** CPU架构: 'x64' | 'arm64' 等 */
  arch: string;
  /** 默认Shell路径: '/bin/bash' | '/bin/zsh' | 'pwsh' | 'powershell' */
  shell: string;
  /** Shell命令参数: '-c' (bash/sh) | '-Command' (PowerShell) */
  shellFlag: string;
  /** 用户主目录 */
  homeDir: string;
  /** 临时目录 */
  tempDir: string;
  /** 环境变量路径分隔符: ':' (Unix) | ';' (Windows) */
  pathSep: string;
  /** 文件系统路径分隔符: '/' (Unix) | '\\' (Windows) */
  dirSep: string;
  /** OS版本号 */
  release: string;
  /** 是否为WSL环境 */
  isWSL: boolean;
  /** 是否运行在Docker容器中 */
  isDocker: boolean;
}

// ─── 跨平台命令映射 ──────────────────────────────────────────

/** 命令映射表类型 — 同一意图在不同平台的CLI实现 */
export type PlatformCommand = string | ((arg: string) => string);

export interface PlatformCommandMap {
  darwin: PlatformCommand;
  linux: PlatformCommand;
  win32: PlatformCommand;
}

/**
 * 跨平台命令映射表
 * key: 语义化操作名称
 * value: 三平台的CLI命令实现
 */
export const PLATFORM_COMMANDS: Record<string, PlatformCommandMap> = {
  // ── 服务管理 ──
  service_list: {
    darwin: "launchctl list",
    linux: "systemctl list-units --type=service --output=json",
    win32: "Get-Service | ConvertTo-Json -Depth 2",
  },
  service_status: {
    darwin: (name: string) => `launchctl print system/${name}`,
    linux: (name: string) => `systemctl status ${name} --output=json`,
    win32: (name: string) => `Get-Service -Name '${name}' | ConvertTo-Json`,
  },
  service_start: {
    darwin: (name: string) => `launchctl kickstart -k system/${name}`,
    linux: (name: string) => `systemctl start ${name}`,
    win32: (name: string) => `Start-Service -Name '${name}'`,
  },
  service_stop: {
    darwin: (name: string) => `launchctl bootout system/${name}`,
    linux: (name: string) => `systemctl stop ${name}`,
    win32: (name: string) => `Stop-Service -Name '${name}'`,
  },
  service_restart: {
    darwin: (name: string) => `launchctl kickstart -k system/${name}`,
    linux: (name: string) => `systemctl restart ${name}`,
    win32: (name: string) => `Restart-Service -Name '${name}'`,
  },

  // ── 进程管理 ──
  process_list: {
    darwin: "ps aux",
    linux: "ps aux",
    win32: "Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet | ConvertTo-Json",
  },
  process_kill: {
    darwin: (pid: string) => `kill ${pid}`,
    linux: (pid: string) => `kill ${pid}`,
    win32: (pid: string) => `Stop-Process -Id ${pid} -Force`,
  },

  // ── 磁盘与文件系统 ──
  disk_usage: {
    darwin: "df -h",
    linux: "df -h",
    win32: "Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free | ConvertTo-Json",
  },
  dir_size: {
    darwin: (dir: string) => `du -sh '${dir}'`,
    linux: (dir: string) => `du -sh '${dir}'`,
    win32: (dir: string) => `(Get-ChildItem '${dir}' -Recurse | Measure-Object -Property Length -Sum).Sum`,
  },

  // ── 网络诊断 ──
  port_list: {
    darwin: "lsof -i -P -n | grep LISTEN",
    linux: "ss -tlnp",
    win32: "Get-NetTCPConnection -State Listen | ConvertTo-Json",
  },
  ping: {
    darwin: (host: string) => `ping -c 4 '${host}'`,
    linux: (host: string) => `ping -c 4 '${host}'`,
    win32: (host: string) => `Test-Connection -ComputerName '${host}' -Count 4`,
  },
  traceroute: {
    darwin: (host: string) => `traceroute '${host}'`,
    linux: (host: string) => `traceroute '${host}'`,
    win32: (host: string) => `tracert '${host}'`,
  },
  dns_lookup: {
    darwin: (domain: string) => `dig '${domain}'`,
    linux: (domain: string) => `dig '${domain}'`,
    win32: (domain: string) => `Resolve-DnsName '${domain}' | ConvertTo-Json`,
  },

  // ── 系统信息 ──
  system_info: {
    darwin: "system_profiler SPHardwareDataType SPSoftwareDataType",
    linux: "cat /etc/os-release && uname -a",
    win32: "Get-ComputerInfo | Select-Object OsName,OsVersion,CsTotalPhysicalMemory,CsProcessors | ConvertTo-Json",
  },
  memory_info: {
    darwin: "vm_stat && sysctl hw.memsize",
    linux: "free -h",
    win32: "Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 20 ProcessName,@{N='MemMB';E={[math]::Round($_.WorkingSet/1MB,1)}} | ConvertTo-Json",
  },
  cpu_info: {
    darwin: "sysctl -n machdep.cpu.brand_string && sysctl -n hw.ncpu",
    linux: "lscpu",
    win32: "Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors | ConvertTo-Json",
  },

  // ── 系统日志 ──
  system_logs: {
    darwin: "log show --last 1h --predicate 'eventType == logEvent' --style compact | tail -50",
    linux: "journalctl --since '1 hour ago' --no-pager -n 50",
    win32: "Get-EventLog -LogName System -Newest 50 | Select-Object TimeGenerated,EntryType,Source,Message | ConvertTo-Json",
  },

  // ── 截屏 ──
  screenshot: {
    darwin: (outPath: string) => `screencapture -x '${outPath}'`,
    linux: (outPath: string) => `scrot '${outPath}'`,
    win32: (outPath: string) =>
      `Add-Type -AssemblyName System.Windows.Forms; ` +
      `$bmp = [System.Drawing.Bitmap]::new([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); ` +
      `$g = [System.Drawing.Graphics]::FromImage($bmp); ` +
      `$g.CopyFromScreen(0,0,0,0,$bmp.Size); ` +
      `$bmp.Save('${outPath}'); $g.Dispose(); $bmp.Dispose()`,
  },

  // ── 应用控制 ──
  app_launch: {
    darwin: (app: string) => `open -a '${app}'`,
    linux: (app: string) => `xdg-open '${app}' &`,
    win32: (app: string) => `Start-Process '${app}'`,
  },
  app_list: {
    darwin: "osascript -e 'tell application \"System Events\" to get name of every process whose background only is false'",
    linux: "wmctrl -l 2>/dev/null || xdotool search --onlyvisible --name '' getwindowname 2>/dev/null",
    win32: "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json",
  },
};

// ─── 平台检测实现 ──────────────────────────────────────────

/** 惰性缓存 — 全局唯一实例 */
let _cachedPlatformInfo: PlatformInfo | null = null;

/**
 * 检测当前操作系统的默认Shell
 *
 * - macOS/Linux: 读取 $SHELL 环境变量，回退 /bin/sh
 * - Windows: 优先 pwsh (PowerShell 7+)，回退 powershell (5.1)
 *
 * 与 code-exec.ts 的 findPowerShell() 保持一致的检测策略
 */
function detectShell(): { shell: string; shellFlag: string } {
  const platform = process.platform;

  if (platform === "win32") {
    // 与 code-exec.ts findPowerShell() 保持一致: pwsh 优先
    try {
      execFileSync("pwsh", ["-NoProfile", "-Command", "exit 0"], {
        stdio: "ignore",
        timeout: 5000,
      });
      return { shell: "pwsh", shellFlag: "-Command" };
    } catch {
      return { shell: "powershell", shellFlag: "-Command" };
    }
  }

  // macOS/Linux: 读取 $SHELL，回退 /bin/sh
  const userShell = process.env.SHELL || "/bin/sh";
  return { shell: userShell, shellFlag: "-c" };
}

/**
 * 检测是否运行在WSL(Windows Subsystem for Linux)环境中
 */
function detectWSL(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const release = os.release().toLowerCase();
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}

/**
 * 检测是否运行在Docker容器中
 */
function detectDocker(): boolean {
  if (process.platform === "win32") return false;
  try {
    // 方法1: 检查 /.dockerenv 文件
    const fs = require("node:fs");
    if (fs.existsSync("/.dockerenv")) return true;
    // 方法2: 检查 cgroup (Linux)
    if (process.platform === "linux") {
      const cgroup = fs.readFileSync("/proc/1/cgroup", "utf-8");
      return cgroup.includes("docker") || cgroup.includes("containerd");
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 获取平台人类可读标签
 * 对标 readiness.ts getCurrentPlatform() 的命名风格
 */
function getOsLabel(platform: string): string {
  switch (platform) {
    case "darwin": return "macos";
    case "win32": return "windows";
    case "linux": return "linux";
    default: return platform;
  }
}

// ─── 公开 API ──────────────────────────────────────────────

/**
 * 获取当前平台信息 — 惰性初始化 + 全局缓存
 *
 * 首次调用时检测并缓存，后续调用直接返回缓存结果。
 * 线程安全: Node.js 单线程模型下无竞态风险。
 */
export function getPlatformInfo(): PlatformInfo {
  if (_cachedPlatformInfo) return _cachedPlatformInfo;

  const { shell, shellFlag } = detectShell();
  const platform = process.platform as OSPlatform;

  _cachedPlatformInfo = {
    os: platform,
    osLabel: getOsLabel(platform),
    arch: os.arch(),
    shell,
    shellFlag,
    homeDir: os.homedir(),
    tempDir: os.tmpdir(),
    pathSep: platform === "win32" ? ";" : ":",
    dirSep: platform === "win32" ? "\\" : "/",
    release: os.release(),
    isWSL: detectWSL(),
    isDocker: detectDocker(),
  };

  logger.info(
    { os: _cachedPlatformInfo.osLabel, arch: _cachedPlatformInfo.arch, shell },
    "平台检测完成",
  );

  return _cachedPlatformInfo;
}

/**
 * 获取跨平台命令
 *
 * @param commandKey 命令名称(PLATFORM_COMMANDS 中的 key)
 * @param args 可选参数（当命令映射为函数时传入）
 * @returns 当前平台对应的CLI命令字符串，未找到返回 null
 *
 * @example
 * ```typescript
 * // 无参命令
 * getCommand("process_list")  // macOS: "ps aux" / Win: "Get-Process | ..."
 *
 * // 带参命令
 * getCommand("service_status", "nginx")  // Linux: "systemctl status nginx --output=json"
 * ```
 */
export function getCommand(commandKey: string, ...args: string[]): string | null {
  const mapping = PLATFORM_COMMANDS[commandKey];
  if (!mapping) return null;

  const { os: platform } = getPlatformInfo();
  const cmd = mapping[platform];
  if (!cmd) return null;

  if (typeof cmd === "function") {
    if (args.length === 0) {
      logger.warn({ commandKey }, "命令需要参数但未提供");
      return null;
    }
    // 参数安全校验 — 统一拦截注入攻击
    const err = validateShellArg(args[0], "service_name", commandKey);
    if (err) {
      logger.warn({ commandKey, arg: args[0], error: err }, "参数校验失败");
      return null;
    }
    return cmd(args[0]);
  }

  return cmd;
}

/**
 * 构建Shell执行参数
 *
 * 根据当前平台返回 spawn() 所需的命令和参数数组。
 * 与 code-exec.ts 保持一致的执行策略:
 * - Unix: sh -c "command"
 * - Windows: pwsh/powershell -NoProfile -Command "command"
 *
 * @param command 要执行的命令字符串
 * @returns [executable, args[]] 用于 child_process.spawn()
 */
export function buildShellArgs(command: string): [string, string[]] {
  const info = getPlatformInfo();

  if (info.os === "win32") {
    // PowerShell: -NoProfile 避免加载用户配置(速度+安全)
    return [info.shell, ["-NoProfile", info.shellFlag, command]];
  }

  // macOS/Linux: sh -c "command"
  // 使用 sh 而非 bash，兼容 alpine/容器环境(无 bash)
  return ["sh", [info.shellFlag, command]];
}

/**
 * 规范化路径 — 统一为当前平台的路径格式
 *
 * @param inputPath 待规范化的路径
 * @returns 当前平台格式的规范路径
 */
export function normalizePath(inputPath: string): string {
  // 使用 node:path 自动处理平台差异
  return path.normalize(inputPath);
}

/**
 * 获取所有可用的命令映射名称列表
 */
export function getAvailableCommands(): string[] {
  return Object.keys(PLATFORM_COMMANDS);
}

/**
 * 清除平台信息缓存（仅用于测试）
 */
export function _resetPlatformCache(): void {
  _cachedPlatformInfo = null;
}
