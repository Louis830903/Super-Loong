/**
 * 环境快照采集 — Agent 启动时自动采集系统环境信息。
 *
 * 采集内容：
 *   - 操作系统版本
 *   - 已安装应用列表
 *   - 当前运行的进程
 *   - 文件系统结构（常用目录）
 *   - 网络状态（能否访问外网、代理配置）
 *
 * 环境快照注入到系统提示词中，Agent 始终知道自己处于什么环境。
 * 环境变化时自动更新（应用安装/卸载触发 re-snapshot）。
 */

import { platform, release, cpus, totalmem, freemem, homedir, hostname, networkInterfaces } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { exec, execSync } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import pino from "pino";

const execAsync = promisify(exec);

const logger = pino({ name: "environment-snapshot" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 操作系统信息 */
export interface OSInfo {
  platform: string;
  distro: string;
  release: string;
  arch: string;
  hostname: string;
  username: string;
  homeDir: string;
  cpuCores: number;
  totalMemoryGB: number;
  freeMemoryGB: number;
}

/** 已安装应用 */
export interface InstalledApp {
  name: string;
  version?: string;
  path?: string;
}

/** 文件系统信息 */
export interface FilesystemInfo {
  /** 常用目录列表 */
  commonDirectories: string[];
  /** 桌面路径 */
  desktopPath: string;
  /** 文档路径 */
  documentsPath: string;
  /** 下载路径 */
  downloadsPath: string;
  /** 工作目录 */
  workingDirectory: string;
}

/** 网络信息 */
export interface NetworkInfo {
  /** 能否访问外网 */
  hasInternetAccess: boolean;
  /** 代理配置 */
  proxy?: {
    http?: string;
    https?: string;
    noProxy?: string;
  };
  /** 网络接口 */
  interfaces: Array<{
    name: string;
    address: string;
    family: string;
    internal: boolean;
  }>;
}

/** 完整环境快照 */
export interface EnvironmentSnapshot {
  /** 快照 ID */
  id: string;
  /** 采集时间 */
  capturedAt: Date;
  /** 操作系统 */
  os: OSInfo;
  /** 已安装应用 */
  installedApps: InstalledApp[];
  /** 文件系统 */
  filesystem: FilesystemInfo;
  /** 网络状态 */
  network: NetworkInfo;
  /** 已安装的 Shell */
  availableShells: string[];
  /** 环境变量（脱敏后） */
  envVars: Record<string, string>;
}

/** 快照采集配置 */
export interface SnapshotConfig {
  /** 是否采集应用列表 */
  collectApps: boolean;
  /** 是否采集网络状态 */
  collectNetwork: boolean;
  /** 是否采集文件系统 */
  collectFilesystem: boolean;
  /** 应用列表命令（按平台区分） */
  appListCommands: Record<string, string>;
}

const DEFAULT_CONFIG: SnapshotConfig = {
  collectApps: true,
  collectNetwork: true,
  collectFilesystem: true,
  appListCommands: {
    win32: 'powershell -NoProfile -Command "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* 2>$null | Where-Object { $_.DisplayName } | Select-Object -ExpandProperty DisplayName"',
    linux: "dpkg-query -f '${Package} ${Version}\n' -W 2>/dev/null || rpm -qa --qf '%{NAME} %{VERSION}\n' 2>/dev/null || echo ''",
    darwin: "system_profiler SPApplicationsDataType 2>/dev/null | grep 'Location:' | sed 's/.*: //' | sort -u || ls /Applications/ 2>/dev/null",
  },
};

// ═══════════════════════════════════════════════════════════════
// 环境快照采集器
// ═══════════════════════════════════════════════════════════════

export class EnvironmentSnapshotCollector {
  private config: SnapshotConfig;
  private lastSnapshot?: EnvironmentSnapshot;
  /** 快照变更回调 */
  private onChangeCallbacks: Array<(snapshot: EnvironmentSnapshot) => void> = [];

  constructor(config?: Partial<SnapshotConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 采集完整环境快照。
   */
  async capture(): Promise<EnvironmentSnapshot> {
    const osInfo = this.collectOSInfo();
    const installedApps = this.config.collectApps ? await this.collectInstalledApps() : [];
    const filesystem = this.config.collectFilesystem ? this.collectFilesystemInfo() : {
      commonDirectories: [],
      desktopPath: "",
      documentsPath: "",
      downloadsPath: "",
      workingDirectory: process.cwd(),
    };
    const network = this.config.collectNetwork ? this.collectNetworkInfo() : {
      hasInternetAccess: false,
      interfaces: [],
    };
    const availableShells = this.detectShells();
    const envVars = this.sanitizeEnvVars();

    const snapshot: EnvironmentSnapshot = {
      id: `env_${Date.now()}`,
      capturedAt: new Date(),
      os: osInfo,
      installedApps,
      filesystem,
      network,
      availableShells,
      envVars,
    };

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  /**
   * 获取上一次快照（如有）。
   */
  getLastSnapshot(): EnvironmentSnapshot | undefined {
    return this.lastSnapshot;
  }

  /**
   * 检查环境是否发生变化。
   */
  hasChanged(snapshot?: EnvironmentSnapshot): boolean {
    const current = snapshot ?? this.lastSnapshot;
    if (!current) return false;

    // 简易变化检测：比较已安装应用数量
    // 实际使用中可扩展为更精细的对比
    const previousAppCount = this.lastSnapshot?.installedApps.length ?? 0;
    if (previousAppCount !== current.installedApps.length) return true;

    return false;
  }

  /**
   * 注册环境变化回调。
   */
  onChange(callback: (snapshot: EnvironmentSnapshot) => void): void {
    this.onChangeCallbacks.push(callback);
  }

  /**
   * 触发变化通知。
   */
  notifyChange(snapshot: EnvironmentSnapshot): void {
    for (const cb of this.onChangeCallbacks) {
      try {
        cb(snapshot);
      } catch (err) {
        logger.warn({ err }, "Environment change callback failed");
      }
    }
  }

  // ─── 系统提示词格式化 ───────────────────────────────────

  /**
   * 将快照格式化为可注入到系统提示词中的文本块。
   */
  formatForPrompt(snapshot?: EnvironmentSnapshot): string {
    const snap = snapshot ?? this.lastSnapshot;
    if (!snap) return "";

    const parts: string[] = [
      "## 系统环境信息",
      "",
      "### 操作系统",
      `- 平台: ${snap.os.platform}`,
      `- 发行版: ${snap.os.distro}`,
      `- 架构: ${snap.os.arch}`,
      `- 主机名: ${snap.os.hostname}`,
      `- 用户名: ${snap.os.username}`,
      `- 用户主目录: ${snap.os.homeDir}`,
      `- CPU 核心数: ${snap.os.cpuCores}`,
      `- 总内存: ${snap.os.totalMemoryGB} GB`,
      `- 可用内存: ${snap.os.freeMemoryGB} GB`,
      "",
    ];

    if (snap.availableShells.length > 0) {
      parts.push("### 可用 Shell");
      for (const sh of snap.availableShells) {
        parts.push(`- ${sh}`);
      }
      parts.push("");
    }

    if (snap.filesystem.commonDirectories.length > 0) {
      parts.push("### 常用目录");
      parts.push(`- 桌面: ${snap.filesystem.desktopPath}`);
      parts.push(`- 文档: ${snap.filesystem.documentsPath}`);
      parts.push(`- 下载: ${snap.filesystem.downloadsPath}`);
      parts.push(`- 工作目录: ${snap.filesystem.workingDirectory}`);
      parts.push("");
    }

    if (snap.installedApps.length > 0) {
      parts.push("### 已安装应用（常用应用）");
      const topApps = snap.installedApps.slice(0, 30);
      for (const app of topApps) {
        parts.push(`- ${app.name}${app.version ? ` (v${app.version})` : ""}`);
      }
      if (snap.installedApps.length > 30) {
        parts.push(`- ... 及其他 ${snap.installedApps.length - 30} 个应用`);
      }
      parts.push("");
    }

    if (snap.network.hasInternetAccess !== undefined) {
      parts.push("### 网络状态");
      parts.push(`- 外网访问: ${snap.network.hasInternetAccess ? "可用" : "不可用"}`);
      if (snap.network.proxy?.http) {
        parts.push(`- HTTP 代理: ${snap.network.proxy.http}`);
      }
      if (snap.network.proxy?.https) {
        parts.push(`- HTTPS 代理: ${snap.network.proxy.https}`);
      }
      parts.push("");
    }

    return parts.join("\n");
  }

  // ─── 采集方法 ───────────────────────────────────────────

  /**
   * 采集操作系统信息。
   */
  private collectOSInfo(): OSInfo {
    const totalMem = totalmem();
    const freeMem = freemem();

    return {
      platform: process.platform,
      distro: this.getDistro(),
      release: release(),
      arch: process.arch,
      hostname: hostname(),
      username: this.getUsername(),
      homeDir: homedir(),
      cpuCores: cpus().length,
      totalMemoryGB: parseFloat((totalMem / (1024 ** 3)).toFixed(1)),
      freeMemoryGB: parseFloat((freeMem / (1024 ** 3)).toFixed(1)),
    };
  }

  /**
   * 获取发行版名称。
   */
  private getDistro(): string {
    switch (process.platform) {
      case "win32":
        try {
          return execSync("powershell -NoProfile -Command \"(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').ProductName\"", {
            encoding: "utf-8",
            timeout: 5000,
          }).trim();
        } catch {
          return "Windows";
        }
      case "darwin":
        try {
          return execSync("sw_vers -productName 2>/dev/null", { encoding: "utf-8", timeout: 5000 }).trim() || "macOS";
        } catch {
          return "macOS";
        }
      case "linux":
        try {
          const name = execSync("cat /etc/os-release 2>/dev/null | grep '^PRETTY_NAME=' | cut -d= -f2 | tr -d '\"'", {
            encoding: "utf-8",
            timeout: 5000,
          }).trim();
          return name || "Linux";
        } catch {
          return "Linux";
        }
      default:
        return "Unknown";
    }
  }

  /**
   * 获取当前用户名。
   */
  private getUsername(): string {
    try {
      if (process.platform === "win32") {
        return process.env.USERNAME || process.env.USER || "unknown";
      }
      return process.env.USER || process.env.LOGNAME || "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * 采集已安装应用列表。
   * 🔧 P1 修复：execSync → exec（异步），避免阻塞事件循环。
   * 15 秒超时 + 失败静默降级（不影响 Agent 正常运行）。
   */
  private async collectInstalledApps(): Promise<InstalledApp[]> {
    try {
      const cmd = this.config.appListCommands[process.platform];
      if (!cmd) return [];

      const { stdout } = await execAsync(cmd, {
        encoding: "utf-8",
        timeout: 15000,
        windowsHide: true,
      });

      const lines = stdout.split("\n").filter((l: string) => l.trim().length > 0);
      return lines.slice(0, 200).map((line: string) => ({
        name: line.trim(),
      }));
    } catch (err) {
      logger.warn({ err }, "Failed to collect installed apps");
      return [];
    }
  }

  /**
   * 采集文件系统信息。
   */
  private collectFilesystemInfo(): FilesystemInfo {
    const home = homedir();
    const commonDirs: string[] = [];

    // 探测常用目录
    const probeDirs = [
      join(home, "Desktop"),
      join(home, "Documents"),
      join(home, "Downloads"),
      join(home, "Pictures"),
      join(home, "Music"),
      join(home, "Videos"),
      join(home, "Projects"),
      join(home, "Code"),
      join(home, "Workspace"),
      join(home, "Dev"),
      join("D:", "Projects"),
      join("D:", "Code"),
      join("D:", "Workspace"),
    ];

    for (const dir of probeDirs) {
      if (existsSync(dir)) {
        commonDirs.push(dir);
      }
    }

    // 探测常用目录下的子目录
    for (const dir of commonDirs.slice()) {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries.slice(0, 10)) {
          if (entry.isDirectory()) {
            const fullPath = join(dir, entry.name);
            if (!commonDirs.includes(fullPath)) {
              commonDirs.push(fullPath);
            }
          }
        }
      } catch { /* skip unreadable dirs */ }
    }

    return {
      commonDirectories: commonDirs.slice(0, 30),
      desktopPath: join(home, "Desktop"),
      documentsPath: join(home, "Documents"),
      downloadsPath: join(home, "Downloads"),
      workingDirectory: process.cwd(),
    };
  }

  /**
   * 采集网络信息。
   */
  private collectNetworkInfo(): NetworkInfo {
    const interfaces: NetworkInfo["interfaces"] = [];
    let hasInternetAccess = false;

    try {
      const ifaces = networkInterfaces();
      for (const [name, addrs] of Object.entries(ifaces)) {
        if (addrs) {
          for (const addr of addrs) {
            interfaces.push({
              name,
              address: addr.address,
              family: addr.family,
              internal: addr.internal,
            });
          }
        }
      }
    } catch { /* ignore */ }

    // 检测外网访问
    try {
      // 快速检测：DNS 解析
      require("node:dns").resolve("google.com", (err: Error | null) => {
        hasInternetAccess = !err;
      });
    } catch {
      hasInternetAccess = false;
    }

    // 读取代理配置
    const proxy: NetworkInfo["proxy"] = {};
    if (process.env.HTTP_PROXY || process.env.http_proxy) {
      proxy.http = process.env.HTTP_PROXY || process.env.http_proxy;
    }
    if (process.env.HTTPS_PROXY || process.env.https_proxy) {
      proxy.https = process.env.HTTPS_PROXY || process.env.https_proxy;
    }
    if (process.env.NO_PROXY || process.env.no_proxy) {
      proxy.noProxy = process.env.NO_PROXY || process.env.no_proxy;
    }

    return {
      hasInternetAccess,
      proxy: proxy.http || proxy.https ? proxy : undefined,
      interfaces,
    };
  }

  /**
   * 检测可用 Shell。
   */
  private detectShells(): string[] {
    const shells: string[] = [];

    if (process.platform === "win32") {
      if (existsSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")) {
        shells.push("PowerShell 5.1");
      }
      if (existsSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe") || process.env.PWSH_PATH) {
        shells.push("PowerShell 7+");
      }
      if (existsSync("C:\\Windows\\System32\\cmd.exe")) {
        shells.push("CMD");
      }
      // Git Bash
      if (existsSync("C:\\Program Files\\Git\\bin\\bash.exe")) {
        shells.push("Git Bash");
      }
      // WSL
      if (existsSync("C:\\Windows\\System32\\wsl.exe")) {
        try {
          const wslDistros = execSync("wsl -l -q 2>nul", { encoding: "utf-8", timeout: 5000 })
            .split("\n")
            .filter(l => l.trim().length > 0)
            .map(l => l.trim().replace(/\s*\(Default\)\s*/, ""));
          for (const distro of wslDistros) {
            shells.push(`WSL (${distro})`);
          }
        } catch { /* WSL not available */ }
      }
    } else {
      shells.push(process.env.SHELL || "/bin/bash");
    }

    return shells;
  }

  /**
   * 脱敏环境变量（移除敏感信息）。
   */
  private sanitizeEnvVars(): Record<string, string> {
    const sensitiveKeys = new Set([
      "API_KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD",
      "AUTH", "CREDENTIAL", "PRIVATE_KEY", "ACCESS_KEY", "SECRET_KEY",
    ]);

    const safe: Record<string, string> = {};
    const relevantPrefixes = [
      "PATH", "HOME", "USER", "SHELL", "LANG", "DISPLAY",
      "NODE", "PYTHON", "JAVA", "GO", "RUST",
      "PNPM", "NPM", "YARN",
      "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
      "SUPER_AGENT",
    ];

    for (const [key, value] of Object.entries(process.env)) {
      if (!value) continue;

      // 跳过敏感键
      const upperKey = key.toUpperCase();
      if (sensitiveKeys.has(upperKey) ||
        Array.from(sensitiveKeys).some(k => upperKey.includes(k))) {
        safe[key] = "[REDACTED]";
        continue;
      }

      // 只保留相关环境变量
      const isRelevant = relevantPrefixes.some(p => upperKey.startsWith(p));
      if (!isRelevant) continue;

      // 截断过长值
      safe[key] = value.length > 200 ? value.slice(0, 200) + "..." : value;
    }

    return safe;
  }
}

// ═══════════════════════════════════════════════════════════════
// 便捷工厂函数
// ═══════════════════════════════════════════════════════════════

/** 快速采集环境快照并格式化为提示词文本 */
export async function captureEnvironmentPrompt(): Promise<string> {
  const collector = new EnvironmentSnapshotCollector();
  const snapshot = await collector.capture();
  return collector.formatForPrompt(snapshot);
}
