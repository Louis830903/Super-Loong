/**
 * Git Tools — git_status / git_log / git_diff / git_commit × 4（同步加载）。
 *
 * 纯 child_process 实现，零外部依赖。
 * 安全增强（对标 Hermes terminal_tool.py）：
 * - execFileSync 参数数组（防命令注入）
 * - workdir 字符白名单 + .git 存在性检查
 * - git 退出码语义（diff 返回 1 不是错误）
 * - git_commit 仅允许 add+commit，禁止 push/force/reset
 */

import { z } from "zod";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import { truncateResult } from "./shared-security.js";

// ── 路径验证（复用 filesystem.ts 的 ALLOWED_ROOTS 逻辑） ──

const ALLOWED_ROOTS = [
  path.resolve(process.cwd()),
  path.resolve(os.homedir()),
  path.resolve(os.tmpdir()),
];

function validatePath(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  if (!ALLOWED_ROOTS.some((root) => resolved.startsWith(root + path.sep) || resolved === root)) {
    return `Error: Path '${filePath}' is outside allowed directories`;
  }
  return null;
}

// ── Git 安全验证（对标 Hermes _validate_workdir + .git 检查） ──

/** 路径字符白名单（对标 Hermes _WORKDIR_SAFE_RE） */
const WORKDIR_SAFE_RE = /^[A-Za-z0-9/_\\\-.~ +@=,:]+$/;

function validateGitCwd(cwd: string): string | null {
  // 1. 路径字符白名单
  if (!WORKDIR_SAFE_RE.test(cwd)) return `非法路径字符: '${cwd}'`;
  // 2. 必须在 ALLOWED_ROOTS 内
  const pathErr = validatePath(cwd);
  if (pathErr) return pathErr;
  // 3. 必须是 git 仓库（.git 目录或文件存在）
  const resolved = path.resolve(cwd);
  if (!fs.existsSync(path.join(resolved, ".git"))) {
    return `'${cwd}' 不是 git 仓库（.git 不存在）`;
  }
  return null;
}

// ── Git 退出码语义（对标 Hermes _NON_ZERO_OK_COMMANDS） ──

/** 某些 git 子命令返回非零退出码但不代表错误 */
const NON_ZERO_OK: Record<string, Set<number>> = {
  "diff": new Set([1]),     // 1 = 有差异
  "grep": new Set([1]),     // 1 = 无匹配
};

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  isError: boolean;
}

/** 统一 git 命令执行器（参数数组防注入，10s 超时） */
function runGit(args: string[], cwd?: string): GitResult {
  const resolvedCwd = cwd ? path.resolve(cwd) : process.cwd();
  try {
    const stdout = execFileSync("git", args, {
      cwd: resolvedCwd,
      timeout: 10_000,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024, // 5MB
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout: stdout || "", stderr: "", isError: false };
  } catch (err: any) {
    const code = err.status ?? 1;
    const stdout = (err.stdout as string) || "";
    const stderr = (err.stderr as string) || err.message;
    const subcommand = args[0];
    const isError = !(NON_ZERO_OK[subcommand]?.has(code));
    return { code, stdout, stderr, isError };
  }
}

// ── 工具定义 ────────────────────────────────────

/** git_status — 获取仓库状态 */
const gitStatusTool: ToolDefinition = {
  name: "git_status",
  description: "获取 Git 仓库状态（modified/staged/untracked 文件列表）。",
  parameters: z.object({
    cwd: z.string().optional().describe("工作目录路径（默认当前目录）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { cwd } = params as { cwd?: string };
    const workDir = cwd || process.cwd();
    const cwdErr = validateGitCwd(workDir);
    if (cwdErr) return { success: false, output: cwdErr, error: cwdErr };

    const result = runGit(["status", "--porcelain=v1", "-b"], workDir);
    if (result.isError) {
      return { success: false, output: `git status 失败: ${result.stderr}`, error: result.stderr };
    }

    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const branch = lines[0]?.replace("## ", "") || "unknown";
    const files = lines.slice(1);

    return {
      success: true,
      output: `分支: ${branch}\n${files.length > 0 ? files.join("\n") : "工作区干净"}`,
      data: { branch, fileCount: files.length },
    };
  },
};

/** git_log — 查看提交历史 */
const gitLogTool: ToolDefinition = {
  name: "git_log",
  description: "查看 Git 提交历史。",
  parameters: z.object({
    cwd: z.string().optional().describe("工作目录路径"),
    count: z.number().min(1).max(100).default(10).describe("显示条数（1-100）"),
    oneline: z.boolean().default(true).describe("单行格式（简洁）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { cwd, count, oneline } = params as { cwd?: string; count: number; oneline: boolean };
    const workDir = cwd || process.cwd();
    const cwdErr = validateGitCwd(workDir);
    if (cwdErr) return { success: false, output: cwdErr, error: cwdErr };

    const args = ["log", `-${count}`];
    if (oneline) args.push("--oneline", "--decorate");

    const result = runGit(args, workDir);
    if (result.isError) {
      return { success: false, output: `git log 失败: ${result.stderr}`, error: result.stderr };
    }

    const output = truncateResult(result.stdout.trim() || "暂无提交记录");
    return { success: true, output, data: { count } };
  },
};

/** 合法的 git ref 名称校验（阻止 --option 注入） */
const SAFE_REF_RE = /^[a-fA-F0-9]{4,40}$|^[a-zA-Z\d][a-zA-Z\d_.\/\-@{}^~]*$/;

/** git_diff — 查看文件差异 */
const gitDiffTool: ToolDefinition = {
  name: "git_diff",
  description: "查看 Git 文件差异。返回码 1 表示有差异（正常行为），不是错误。",
  parameters: z.object({
    cwd: z.string().optional().describe("工作目录路径"),
    file: z.string().optional().describe("指定文件路径（默认全部）"),
    staged: z.boolean().default(false).describe("查看暂存区差异"),
    commit: z.string().optional().describe("与指定 commit 比较"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { cwd, file, staged, commit } = params as {
      cwd?: string; file?: string; staged: boolean; commit?: string;
    };
    const workDir = cwd || process.cwd();
    const cwdErr = validateGitCwd(workDir);
    if (cwdErr) return { success: false, output: cwdErr, error: cwdErr };

    const args = ["diff"];
    if (staged) args.push("--cached");
    if (commit) {
      if (!SAFE_REF_RE.test(commit)) {
        return { success: false, output: `非法的 commit 引用: '${commit}'`, error: "invalid commit ref" };
      }
      args.push(commit);
    }
    args.push("--stat"); // 先显示统计摘要
    if (file) args.push("--", file);

    // 统计摘要
    const statResult = runGit(args, workDir);

    // 完整 diff（去掉 --stat）
    const fullArgs = ["diff"];
    if (staged) fullArgs.push("--cached");
    if (commit) fullArgs.push(commit); // 已在上方校验过
    if (file) fullArgs.push("--", file);
    const fullResult = runGit(fullArgs, workDir);

    // git diff 返回 1 表示有差异，不是错误
    const output = truncateResult(
      (statResult.stdout.trim() ? `--- 统计 ---\n${statResult.stdout.trim()}\n\n--- 差异 ---\n` : "") +
      (fullResult.stdout.trim() || "无差异")
    );

    return { success: true, output, data: { hasDiff: fullResult.code === 1 } };
  },
};

/** git_commit — 暂存并提交（禁止 push/force/reset） */
const gitCommitTool: ToolDefinition = {
  name: "git_commit",
  description: "暂存文件并提交到本地仓库。仅执行 git add + git commit，不会 push 到远程。",
  parameters: z.object({
    cwd: z.string().optional().describe("工作目录路径"),
    message: z.string().describe("提交信息"),
    files: z.array(z.string()).optional().describe("要暂存的文件列表（默认全部 -A）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { cwd, message, files } = params as { cwd?: string; message: string; files?: string[] };
    const workDir = cwd || process.cwd();
    const cwdErr = validateGitCwd(workDir);
    if (cwdErr) return { success: false, output: cwdErr, error: cwdErr };

    if (!message.trim()) {
      return { success: false, output: "提交信息不能为空", error: "empty message" };
    }

    // Step 1: git add
    const addArgs = files && files.length > 0
      ? ["add", "--", ...files]
      : ["add", "-A"];
    const addResult = runGit(addArgs, workDir);
    if (addResult.isError) {
      return { success: false, output: `git add 失败: ${addResult.stderr}`, error: addResult.stderr };
    }

    // Step 2: git commit
    const commitResult = runGit(["commit", "-m", message], workDir);
    if (commitResult.isError) {
      // 没有内容可提交（正常情况）
      if (commitResult.stdout.includes("nothing to commit")) {
        return { success: true, output: "没有需要提交的更改", data: { committed: false } };
      }
      return { success: false, output: `git commit 失败: ${commitResult.stderr || commitResult.stdout}`, error: commitResult.stderr };
    }

    return {
      success: true,
      output: `✅ 提交成功\n${commitResult.stdout.trim()}`,
      data: { committed: true },
    };
  },
};

export const gitTools: ToolDefinition[] = [gitStatusTool, gitLogTool, gitDiffTool, gitCommitTool];
