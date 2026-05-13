/**
 * SysOps Security — 双层纵深防御的 Layer 2: 声明式安全策略
 *
 * 解决的核心问题:
 * SecurityManager 默认策略 defaultPermission="allow" + defaultSandbox="none"，
 * 导致所有新工具上线即无沙箱放行。
 *
 * 本模块集中声明所有新增系统操作工具的 ToolPermission 规则，
 * 在应用初始化时自动注入到默认策略的 toolPermissions 中。
 *
 * 设计原则:
 * - 不改 SecurityManager 一行代码
 * - 100% 复用已有 ToolPermission 接口
 * - 只追加未配置的工具规则，不覆盖用户已有设置
 *
 * 规则分三级:
 * 🟢 只读工具 → sandboxLevel: "none"  (18个)
 * 🟡 写入工具 → sandboxLevel: "process" (22个)
 * 🔴 极危工具 → sandboxLevel: "process" + restrictions (2个)
 */

import type { ToolPermission, SecurityPolicy } from "./sandbox.js";

/**
 * 所有新增系统操作工具的安全规则
 */
export const SYSOPS_TOOL_PERMISSIONS: ToolPermission[] = [
  // ── 终端引擎 (🔴极危) ──
  { toolName: "terminal",     action: "allow", sandboxLevel: "process",
    restrictions: { maxExecutionMs: 600_000 } },
  { toolName: "process_poll", action: "allow", sandboxLevel: "none" },
  { toolName: "process_kill", action: "allow", sandboxLevel: "process" },

  // ── Docker管理 ──
  { toolName: "docker_ps",        action: "allow", sandboxLevel: "none" },
  { toolName: "docker_logs",      action: "allow", sandboxLevel: "none" },
  { toolName: "docker_exec",      action: "allow", sandboxLevel: "process" },
  { toolName: "docker_lifecycle", action: "allow", sandboxLevel: "process" },
  { toolName: "docker_images",    action: "allow", sandboxLevel: "none" },
  { toolName: "docker_compose",   action: "allow", sandboxLevel: "process" },

  // ── 服务管理 ──
  { toolName: "service_status",  action: "allow", sandboxLevel: "none" },
  { toolName: "service_control", action: "allow", sandboxLevel: "process" },
  { toolName: "service_logs",    action: "allow", sandboxLevel: "none" },
  { toolName: "cron_manage",     action: "allow", sandboxLevel: "process" },

  // ── 网络诊断 (全部🟢只读) ──
  { toolName: "net_ping",       action: "allow", sandboxLevel: "none" },
  { toolName: "net_traceroute", action: "allow", sandboxLevel: "none" },
  { toolName: "net_ports",      action: "allow", sandboxLevel: "none" },
  { toolName: "net_dns",        action: "allow", sandboxLevel: "none" },
  { toolName: "net_curl",       action: "allow", sandboxLevel: "none" },

  // ── 系统监控 (全部🟢只读) ──
  { toolName: "sys_info",      action: "allow", sandboxLevel: "none" },
  { toolName: "sys_processes", action: "allow", sandboxLevel: "none" },
  { toolName: "sys_disk",      action: "allow", sandboxLevel: "none" },
  { toolName: "sys_memory",    action: "allow", sandboxLevel: "none" },
  { toolName: "sys_logs",      action: "allow", sandboxLevel: "none" },

  // ── 部署执行 ──
  { toolName: "deploy_git_pull",    action: "allow", sandboxLevel: "process" },
  { toolName: "deploy_build",       action: "allow", sandboxLevel: "process" },
  { toolName: "deploy_restart",     action: "allow", sandboxLevel: "process" },
  { toolName: "deploy_rollback",    action: "allow", sandboxLevel: "process" },
  { toolName: "deploy_healthcheck", action: "allow", sandboxLevel: "none" },

  // ── 开发辅助 ──
  { toolName: "git_branch",      action: "allow", sandboxLevel: "process" },
  { toolName: "git_merge",       action: "allow", sandboxLevel: "process" },
  { toolName: "git_stash",       action: "allow", sandboxLevel: "process" },
  { toolName: "git_remote",      action: "allow", sandboxLevel: "process" },
  { toolName: "git_cherry_pick", action: "allow", sandboxLevel: "process" },
  { toolName: "git_rebase",      action: "allow", sandboxLevel: "process" },
  { toolName: "pkg_install",     action: "allow", sandboxLevel: "process" },
  { toolName: "pkg_update",      action: "allow", sandboxLevel: "process" },
  { toolName: "pkg_audit",       action: "allow", sandboxLevel: "none" },
  { toolName: "pkg_outdated",    action: "allow", sandboxLevel: "none" },
  { toolName: "pkg_search",      action: "allow", sandboxLevel: "none" },
  { toolName: "test_run",        action: "allow", sandboxLevel: "process" },
  { toolName: "test_watch",      action: "allow", sandboxLevel: "process" },
  { toolName: "build_run",       action: "allow", sandboxLevel: "process" },
  { toolName: "build_dev",       action: "allow", sandboxLevel: "process" },
  { toolName: "lint_run",        action: "allow", sandboxLevel: "none" },
  { toolName: "env_create",      action: "allow", sandboxLevel: "process" },
  { toolName: "env_activate",    action: "allow", sandboxLevel: "process" },
  { toolName: "env_dotenv",      action: "allow", sandboxLevel: "process" },
  { toolName: "env_port",        action: "allow", sandboxLevel: "none" },

  // ── 桌面控制 ──
  { toolName: "mouse_click",    action: "allow", sandboxLevel: "process" },
  { toolName: "mouse_move",     action: "allow", sandboxLevel: "process" },
  { toolName: "mouse_drag",     action: "allow", sandboxLevel: "process" },
  { toolName: "mouse_scroll",   action: "allow", sandboxLevel: "process" },
  { toolName: "keyboard_type",  action: "allow", sandboxLevel: "process" },
  { toolName: "keyboard_key",   action: "allow", sandboxLevel: "process" },
  { toolName: "window_focus",   action: "allow", sandboxLevel: "process" },
  { toolName: "window_list",    action: "allow", sandboxLevel: "none" },
  { toolName: "screen_capture", action: "allow", sandboxLevel: "none" },
  { toolName: "screen_ocr",     action: "allow", sandboxLevel: "none" },
  { toolName: "app_launch",     action: "allow", sandboxLevel: "process" },
  { toolName: "app_quit",       action: "allow", sandboxLevel: "process" },
  { toolName: "app_list",       action: "allow", sandboxLevel: "none" },

  // ── Computer Use Loop (🔴极危) ──
  { toolName: "computer_use",   action: "allow", sandboxLevel: "process",
    restrictions: { maxExecutionMs: 300_000 } },

  // ── 审批工具 (🟢只读内存操作) ──
  { toolName: "approve_command", action: "allow", sandboxLevel: "none" },
];

/**
 * 将 SysOps 安全规则注入到 SecurityManager 的默认策略中
 *
 * 注入原则:
 * - 只追加未配置的工具规则
 * - 不覆盖用户已有的自定义规则
 * - 注入后自动持久化到 SQLite (通过 setPolicy)
 *
 * @param securityManager 安全管理器实例
 */
export function injectSysopsSecurityRules(securityManager: {
  getPolicy: (id: string) => SecurityPolicy | undefined;
  setPolicy: (policy: SecurityPolicy) => void;
}): void {
  const defaultPolicy = securityManager.getPolicy("default");
  if (!defaultPolicy) {
    // 默认策略不存在时不注入（极端情况）
    return;
  }

  let addedCount = 0;

  for (const rule of SYSOPS_TOOL_PERMISSIONS) {
    // 只追加未配置的工具，不覆盖用户已有规则
    const exists = defaultPolicy.toolPermissions.find(
      (p: ToolPermission) => p.toolName === rule.toolName,
    );
    if (!exists) {
      defaultPolicy.toolPermissions.push(rule);
      addedCount++;
    }
  }

  if (addedCount > 0) {
    securityManager.setPolicy(defaultPolicy);
  }
}
