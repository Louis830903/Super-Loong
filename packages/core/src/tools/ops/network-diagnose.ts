/**
 * 网络诊断工具 — 跨平台 CLI-First 封装
 *
 * 5个工具: net_ping / net_traceroute / net_ports / net_dns / net_curl
 *
 * 全部为只读工具(🟢 sandboxLevel: "none")
 */

import { z } from "zod";
import pino from "pino";
import type { ToolDefinition, ToolContext, ToolResult } from "../../types/index.js";
import { getPlatformInfo, getCommand } from "../../platform/adapter.js";
import { validateShellArg } from "../../security/shared-security.js";
import { runShellCmd } from "../run-shell-cmd.js";

const logger = pino({ name: "network-diagnose" });

// ─── net_ping ────────────────────────────────────────────

const netPingTool: ToolDefinition = {
  name: "net_ping",
  description: "Ping 测试: 检测主机可达性和延迟。跨平台支持。",
  parameters: z.object({
    host: z.string().describe("目标主机(IP或域名)"),
    count: z.number().optional().describe("发送的 ICMP 包数量, 默认4"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { host, count } = z.object({
      host: z.string(),
      count: z.number().optional(),
    }).parse(params);

    const info = getPlatformInfo();
    const n = count ?? 4;

    // 参数安全校验 — host 不允许 shell 特殊字符
    const hostErr = validateShellArg(host, "hostname", "host");
    if (hostErr) return { success: false, output: `参数校验失败: ${hostErr}` };

    let cmd: string;
    if (info.os === "win32") {
      cmd = `ping -n ${n} ${host}`;
    } else {
      cmd = `ping -c ${n} ${host}`;
    }

    return runShellCmd(cmd);
  },
};

// ─── net_traceroute ──────────────────────────────────────

const netTracerouteTool: ToolDefinition = {
  name: "net_traceroute",
  description: "路由追踪: 显示到目标主机的网络路径。macOS/Linux(traceroute) / Windows(tracert)。",
  parameters: z.object({
    host: z.string().describe("目标主机(IP或域名)"),
    maxHops: z.number().optional().describe("最大跳数, 默认30"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { host, maxHops } = z.object({
      host: z.string(),
      maxHops: z.number().optional(),
    }).parse(params);

    const info = getPlatformInfo();
    const hops = maxHops ?? 30;

    // 参数安全校验 — host 不允许 shell 特殊字符
    const hostErr = validateShellArg(host, "hostname", "host");
    if (hostErr) return { success: false, output: `参数校验失败: ${hostErr}` };

    let cmd: string;
    if (info.os === "win32") {
      cmd = `tracert -h ${hops} ${host}`;
    } else {
      cmd = `traceroute -m ${hops} ${host}`;
    }

    return runShellCmd(cmd, { timeoutMs: 120_000 });
  },
};

// ─── net_ports ───────────────────────────────────────────

const netPortsTool: ToolDefinition = {
  name: "net_ports",
  description: "查看端口监听状态。macOS(lsof) / Linux(ss) / Windows(Get-NetTCPConnection)。",
  parameters: z.object({
    port: z.number().optional().describe("过滤指定端口号"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { port } = z.object({ port: z.number().optional() }).parse(params);

    const info = getPlatformInfo();
    let cmd: string;

    switch (info.os) {
      case "darwin":
        cmd = port ? `lsof -i :${port} -P -n` : "lsof -i -P -n | head -50";
        break;
      case "linux":
        cmd = port ? `ss -tlnp sport = :${port}` : "ss -tlnp";
        break;
      case "win32":
        cmd = port
          ? `Get-NetTCPConnection -LocalPort ${port} | ConvertTo-Json -Depth 2`
          : "Get-NetTCPConnection -State Listen | Select-Object -First 50 | ConvertTo-Json -Depth 2";
        break;
      default:
        return { success: false, output: "不支持的平台" };
    }

    return runShellCmd(cmd);
  },
};

// ─── net_dns ─────────────────────────────────────────────

const netDnsTool: ToolDefinition = {
  name: "net_dns",
  description: "DNS 查询: 解析域名的 IP 地址和记录。使用 nslookup (跨平台通用)。",
  parameters: z.object({
    domain: z.string().describe("要查询的域名"),
    type: z.enum(["A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA"]).optional().describe("DNS 记录类型, 默认 A"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { domain, type } = z.object({
      domain: z.string(),
      type: z.enum(["A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA"]).optional(),
    }).parse(params);

    // nslookup 跨平台通用 — domain 参数安全校验
    const domainErr = validateShellArg(domain, "hostname", "domain");
    if (domainErr) return { success: false, output: `参数校验失败: ${domainErr}` };

    const cmd = type
      ? `nslookup -type=${type} ${domain}`
      : `nslookup ${domain}`;

    return runShellCmd(cmd, { timeoutMs: 15_000 });
  },
};

// ─── net_curl ────────────────────────────────────────────

const netCurlTool: ToolDefinition = {
  name: "net_curl",
  description: "HTTP 请求测试: 发送 HTTP 请求并返回响应信息。用于 API 测试和连通性检查。",
  parameters: z.object({
    url: z.string().describe("请求 URL"),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"]).optional().describe("HTTP 方法, 默认 GET"),
    headers: z.record(z.string()).optional().describe("请求头, 如 {'Content-Type': 'application/json'}"),
    body: z.string().optional().describe("请求体(POST/PUT/PATCH时)"),
    verbose: z.boolean().optional().describe("是否显示详细信息(含请求/响应头), 默认false"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { url, method, headers, body, verbose } = z.object({
      url: z.string(),
      method: z.enum(["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"]).optional(),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
      verbose: z.boolean().optional(),
    }).parse(params);

    const info = getPlatformInfo();

    // 参数安全校验 — url 不允许 shell 特殊字符
    const urlErr = validateShellArg(url, "url", "url");
    if (urlErr) return { success: false, output: `参数校验失败: ${urlErr}` };

    // 构建 curl 命令 (跨平台通用)
    const parts: string[] = ["curl", "-sS", "-w", "'\\n%{http_code}'"];
    if (verbose) parts.push("-v");
    if (method && method !== "GET") parts.push("-X", method);
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        // 头名称和头值安全校验 — 防止 shell 注入
        const keyErr = validateShellArg(k, "header_key", "header name");
        if (keyErr) return { success: false, output: `参数校验失败: ${keyErr}` };
        const valErr = validateShellArg(v, "shell_safe", "header value");
        if (valErr) return { success: false, output: `参数校验失败: ${valErr}` };
        parts.push("-H", `'${k}: ${v}'`);
      }
    }
    if (body) {
      // 请求体安全校验 — 禁止 shell 注入字符
      const bodyErr = validateShellArg(body, "shell_safe", "body");
      if (bodyErr) return { success: false, output: `参数校验失败: ${bodyErr}` };
      parts.push("-d", `'${body}'`);
    }
    parts.push(`'${url}'`);

    const cmd = parts.join(" ");
    return runShellCmd(cmd);
  },
};

// ─── 导出 ────────────────────────────────────────────────

export const networkTools: ToolDefinition[] = [
  netPingTool,
  netTracerouteTool,
  netPortsTool,
  netDnsTool,
  netCurlTool,
];
