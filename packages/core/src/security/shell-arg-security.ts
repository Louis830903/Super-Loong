/**
 * Shell 参数安全校验 — 统一 Shell 参数安全校验
 *
 * 解决的核心问题:
 * 25+ 个工具文件中存在参数直接拼接进 shell 命令的注入风险。
 * 本模块提供白名单正则校验，在参数拼接前统一过滤。
 *
 * 使用方式:
 * ```typescript
 * import { validateShellArg } from "../security/shell-arg-security.js";
 * const err = validateShellArg(host, "hostname", "host");
 * if (err) return { success: false, output: `参数校验失败: ${err}` };
 * ```
 */

/**
 * 按参数语义分类的白名单正则
 *
 * - git_ref: commit hash / branch / tag / HEAD~N 等
 * - service_name: 应用名、服务名、窗口标题等（宽松的字母数字+标点）
 * - hostname: IP 地址或域名
 * - url: HTTP/HTTPS URL
 */
const SHELL_ARG_PATTERNS: Record<string, RegExp> = {
  // git ref: 40位hex / 分支名 / HEAD~N / tag 等
  git_ref: /^[a-fA-F0-9]{4,40}$|^[a-zA-Z\d][a-zA-Z\d_.\/\-@{}^~]*$/,
  // 服务名、应用名、窗口标题: 字母数字开头，禁止空格（防止 shell 拼接时注入）
  service_name: /^[a-zA-Z\d][a-zA-Z\d.\-_]{0,127}$/,
  // 主机名/域名/IP
  hostname: /^[a-zA-Z\d]([a-zA-Z\d.\-]{0,253}[a-zA-Z\d])?$/,
  // HTTP(S) URL — 禁止 shell 特殊字符
  url: /^https?:\/\/[^\s'"`;|&<>\\]{1,2048}$/,
  // cron 表达式 — 5个字段, 只允许数字/星号/逗号/连字符/斜杠
  cron_expr: /^[\d*,\/-]+(?:\s+[\d*,\/-]+){4}$/,
  // HTTP 头名称 — 仅允许字母/数字/连字符
  header_key: /^[a-zA-Z\d\-]{1,256}$/,
  // 通用 shell 安全值 — 禁止 shell 注入字符 (', `, $, |, &, ;, <, >, \n, \r)
  shell_safe: /^[^'`$|&;<>\n\r\\]{1,4096}$/,
  // 时间段格式 — 如 1h / 30m / 2d / "2024-01-01"
  time_duration: /^\d{1,4}[smhd]$|^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/,
};

/**
 * 校验即将拼入 shell 命令的参数
 *
 * @param value 待校验的参数值
 * @param kind 参数类型（git_ref / service_name / hostname / url）
 * @param label 可选的参数显示名（用于错误提示）
 * @returns null 表示通过，非 null 为错误描述
 */
export function validateShellArg(
  value: string,
  kind: string,
  label?: string,
): string | null {
  const pattern = SHELL_ARG_PATTERNS[kind];
  if (!pattern) return `未知的参数类型: ${kind}`;
  if (!value || value.length > 2048) return `${label ?? "参数"}长度异常`;
  if (!pattern.test(value)) return `${label ?? "参数"}含有不安全字符`;
  return null;
}
