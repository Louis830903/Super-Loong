/**
 * Docker 管理工具 — CLI-First 封装
 *
 * 6个工具: docker_ps / docker_logs / docker_exec / docker_lifecycle / docker_images / docker_compose
 *
 * 实现策略: 底层调用 docker/podman CLI, 解析JSON输出
 * 安全: docker_exec 内部调用 CommandGuard 检测容器内命令
 */

import { z } from "zod";
import { spawn } from "node:child_process";
import pino from "pino";
import type { ToolDefinition, ToolContext, ToolResult } from "../../types/index.js";
import { getPlatformInfo } from "../../platform/adapter.js";
import { hasBinary } from "../../platform/cli-detector.js";
import { processOutput } from "../output-processor.js";
import { checkCompoundCommand } from "../../security/command-guard.js";

const logger = pino({ name: "docker-manage" });

// ─── 通用辅助 ──────────────────────────────────────────

/** 检测 docker 或 podman 可用性 */
function getDockerBin(): string | null {
  if (hasBinary("docker")) return "docker";
  if (hasBinary("podman")) return "podman";
  return null;
}

/** 执行 docker CLI 命令, 返回 ToolResult */
async function runDockerCmd(args: string[], timeoutMs = 30_000): Promise<ToolResult> {
  const bin = getDockerBin();
  if (!bin) {
    return { success: false, output: "⛔ docker/podman 未安装或不在 PATH 中" };
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn(bin, args, {
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.stderr?.on("data", (d: Buffer) => errChunks.push(d));

    child.on("error", (err) => {
      resolve({ success: false, output: `执行失败: ${err.message}` });
    });

    child.on("close", (code) => {
      const stdout = processOutput(Buffer.concat(chunks).toString("utf-8"));
      const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
      const ok = code === 0;
      const output = ok ? stdout : `退出码: ${code}\n${stderr}\n${stdout}`.trim();
      resolve({ success: ok, output });
    });
  });
}

// ─── docker_ps ──────────────────────────────────────────

const dockerPsTool: ToolDefinition = {
  name: "docker_ps",
  description: "列出 Docker 容器 (运行中或全部)。返回容器 ID、名称、状态、端口映射等。",
  parameters: z.object({
    all: z.boolean().optional().describe("是否显示全部容器(包括已停止的), 默认只显示运行中"),
    filter: z.string().optional().describe("过滤条件, 如 'name=nginx' 或 'status=running'"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { all, filter } = z.object({
      all: z.boolean().optional(),
      filter: z.string().optional(),
    }).parse(params);

    const args = ["ps", "--format", "json", "--no-trunc"];
    if (all) args.push("-a");
    if (filter) args.push("--filter", filter);

    return runDockerCmd(args);
  },
};

// ─── docker_logs ─────────────────────────────────────────

const dockerLogsTool: ToolDefinition = {
  name: "docker_logs",
  description: "查看 Docker 容器日志。支持 tail 限制行数和 since 时间过滤。",
  parameters: z.object({
    container: z.string().describe("容器名称或ID"),
    tail: z.number().optional().describe("只显示最近N行日志, 默认100"),
    since: z.string().optional().describe("起始时间, 如 '1h' 或 '2024-01-01T00:00:00'"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { container, tail, since } = z.object({
      container: z.string(),
      tail: z.number().optional(),
      since: z.string().optional(),
    }).parse(params);

    const args = ["logs", "--timestamps"];
    args.push("--tail", String(tail ?? 100));
    if (since) args.push("--since", since);
    args.push(container);

    return runDockerCmd(args, 60_000);
  },
};

// ─── docker_exec ─────────────────────────────────────────

const dockerExecTool: ToolDefinition = {
  name: "docker_exec",
  description: "在 Docker 容器内执行命令。注意: 容器内命令同样受安全检测约束。",
  parameters: z.object({
    container: z.string().describe("容器名称或ID"),
    command: z.string().describe("要在容器内执行的命令"),
    workdir: z.string().optional().describe("容器内工作目录"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { container, command, workdir } = z.object({
      container: z.string(),
      command: z.string(),
      workdir: z.string().optional(),
    }).parse(params);

    // 安全: 容器内命令也要检查
    const guard = checkCompoundCommand(command);
    if (guard.isDangerous) {
      return {
        success: false,
        output: `⛔ 容器内危险命令被拦截\n类型: ${guard.category}\n说明: ${guard.description}\n命令: ${command}`,
      };
    }

    const args = ["exec"];
    if (workdir) args.push("-w", workdir);
    args.push(container, "sh", "-c", command);

    return runDockerCmd(args, 60_000);
  },
};

// ─── docker_lifecycle ────────────────────────────────────

const dockerLifecycleTool: ToolDefinition = {
  name: "docker_lifecycle",
  description: "Docker 容器生命周期管理: 启动/停止/重启/删除容器。",
  parameters: z.object({
    action: z.enum(["start", "stop", "restart", "rm"]).describe("操作类型"),
    container: z.string().describe("容器名称或ID"),
    force: z.boolean().optional().describe("强制操作(用于 stop/rm), 默认false"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { action, container, force } = z.object({
      action: z.enum(["start", "stop", "restart", "rm"]),
      container: z.string(),
      force: z.boolean().optional(),
    }).parse(params);

    const args: string[] = [action];
    if (force && (action === "stop" || action === "rm")) args.push("--force");
    args.push(container);

    return runDockerCmd(args);
  },
};

// ─── docker_images ───────────────────────────────────────

const dockerImagesTool: ToolDefinition = {
  name: "docker_images",
  description: "Docker 镜像管理: 列出/拉取/删除镜像。",
  parameters: z.object({
    action: z.enum(["list", "pull", "rmi"]).describe("操作: list(列出) / pull(拉取) / rmi(删除)"),
    image: z.string().optional().describe("镜像名称(pull/rmi时必填)"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { action, image } = z.object({
      action: z.enum(["list", "pull", "rmi"]),
      image: z.string().optional(),
    }).parse(params);

    if (action === "list") {
      return runDockerCmd(["images", "--format", "json"]);
    }
    if (!image) {
      return { success: false, output: `${action} 操作需要指定镜像名称` };
    }
    return runDockerCmd([action === "rmi" ? "rmi" : "pull", image], 120_000);
  },
};

// ─── docker_compose ──────────────────────────────────────

const dockerComposeTool: ToolDefinition = {
  name: "docker_compose",
  description: "Docker Compose 操作: up/down/restart/logs/ps。",
  parameters: z.object({
    action: z.enum(["up", "down", "restart", "logs", "ps"]).describe("Compose 操作"),
    file: z.string().optional().describe("compose 文件路径, 默认 docker-compose.yml"),
    service: z.string().optional().describe("指定服务名称(可选)"),
    detach: z.boolean().optional().describe("后台运行(up时), 默认true"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { action, file, service, detach } = z.object({
      action: z.enum(["up", "down", "restart", "logs", "ps"]),
      file: z.string().optional(),
      service: z.string().optional(),
      detach: z.boolean().optional(),
    }).parse(params);

    // 检测 docker compose (v2) 或 docker-compose (v1)
    const bin = getDockerBin();
    if (!bin) {
      return { success: false, output: "⛔ docker/podman 未安装" };
    }

    const args: string[] = ["compose"];
    if (file) args.push("-f", file);
    args.push(action);

    if (action === "up" && (detach ?? true)) args.push("-d");
    if (action === "logs") args.push("--tail", "100");
    if (service) args.push(service);

    return runDockerCmd(args, action === "up" ? 180_000 : 60_000);
  },
};

// ─── 导出 ────────────────────────────────────────────────

export const dockerTools: ToolDefinition[] = [
  dockerPsTool,
  dockerLogsTool,
  dockerExecTool,
  dockerLifecycleTool,
  dockerImagesTool,
  dockerComposeTool,
];
