/**
 * File System Tools — read, write, list, search files.
 */

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ToolDefinition, ToolResult, ToolContext } from "../types/index.js";
import { validateWritePath, isBinaryFile, isBlockedDevicePath, checkFileSize } from "./shared-security.js";

// B-15: 路径遍历保护 — 白名单根目录校验
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

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "Read the contents of a file at the given path. Returns the file content as text or base64.",
  parameters: z.object({
    path: z.string().describe("Absolute or relative file path"),
    encoding: z.enum(["utf-8", "base64"]).default("utf-8").describe("File encoding"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { path: filePath, encoding } = params as { path: string; encoding: string };
    const pathErr = validatePath(filePath);
    if (pathErr) return { success: false, output: pathErr, error: pathErr };
    // 安全基座：设备路径阻断 + 大小守卫 + 二进制检测
    const devErr = isBlockedDevicePath(filePath);
    if (devErr) return { success: false, output: devErr, error: devErr };
    const sizeErr = checkFileSize(filePath, 10 * 1024 * 1024); // 10MB 读取上限
    if (sizeErr) return { success: false, output: sizeErr, error: sizeErr };
    if (encoding === "utf-8" && isBinaryFile(filePath)) {
      return { success: false, output: `文件 '${filePath}' 是二进制格式，请使用 encoding: 'base64' 读取`, error: "binary_file" };
    }
    try {
      const content = fs.readFileSync(filePath, encoding as BufferEncoding);
      return { success: true, output: content, data: { path: filePath, size: content.length } };
    } catch (err: any) {
      return { success: false, output: `Cannot read file: ${err.message}`, error: err.message };
    }
  },
};

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. The written file is automatically sent as an attachment to the user — use this to deliver generated documents, images, code files, etc.",
  parameters: z.object({
    path: z.string().describe("File path to write to"),
    content: z.string().describe("Content to write"),
    encoding: z.enum(["utf-8", "base64"]).default("utf-8"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { path: filePath, content, encoding } = params as { path: string; content: string; encoding: string };
    const pathErr = validatePath(filePath);
    if (pathErr) return { success: false, output: pathErr, error: pathErr };
    // 安全基座：写入路径黑名单
    const writeErr = validateWritePath(filePath);
    if (writeErr) return { success: false, output: writeErr, error: writeErr };
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, encoding as BufferEncoding);
      const resolved = path.resolve(filePath);
      return {
        success: true,
        output: `Written ${content.length} chars to ${filePath}`,
        data: { filePath: resolved, size: content.length },
      };
    } catch (err: any) {
      return { success: false, output: `Cannot write file: ${err.message}`, error: err.message };
    }
  },
};

export const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description: "List the contents of a directory, showing files and subdirectories.",
  parameters: z.object({
    path: z.string().describe("Directory path to list"),
    recursive: z.boolean().default(false).describe("Whether to list recursively"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { path: dirPath, recursive } = params as { path: string; recursive: boolean };
    try {
      const entries = listDir(dirPath, recursive, 0, 3);
      return { success: true, output: entries.join("\n"), data: { count: entries.length } };
    } catch (err: any) {
      return { success: false, output: `Cannot list directory: ${err.message}`, error: err.message };
    }
  },
};

function listDir(dirPath: string, recursive: boolean, depth: number, maxDepth: number): string[] {
  const entries: string[] = [];
  const items = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const item of items) {
    const prefix = "  ".repeat(depth);
    const fullPath = path.join(dirPath, item.name);
    if (item.isDirectory()) {
      entries.push(`${prefix}[dir] ${item.name}/`);
      if (recursive && depth < maxDepth) {
        entries.push(...listDir(fullPath, true, depth + 1, maxDepth));
      }
    } else {
      const stat = fs.statSync(fullPath);
      entries.push(`${prefix}[file] ${item.name} (${formatSize(stat.size)})`);
    }
  }
  return entries;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export const searchFilesTool: ToolDefinition = {
  name: "search_files",
  description: "Search for files matching a glob-like pattern in a directory.",
  parameters: z.object({
    directory: z.string().describe("Root directory to search in"),
    pattern: z.string().describe("File name pattern (e.g., '*.ts', '*.json')"),
    maxResults: z.number().default(50).describe("Maximum results to return"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { directory, pattern, maxResults } = params as { directory: string; pattern: string; maxResults: number };
    try {
      const results: string[] = [];
      searchFilesRecursive(directory, pattern, results, maxResults, 0, 5);
      return {
        success: true,
        output: results.length > 0 ? results.join("\n") : "No files found",
        data: { count: results.length },
      };
    } catch (err: any) {
      return { success: false, output: `Search failed: ${err.message}`, error: err.message };
    }
  },
};

function searchFilesRecursive(dir: string, pattern: string, results: string[], max: number, depth: number, maxDepth: number): void {
  if (results.length >= max || depth > maxDepth) return;
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (results.length >= max) return;
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory() && !item.name.startsWith(".") && item.name !== "node_modules") {
        searchFilesRecursive(fullPath, pattern, results, max, depth + 1, maxDepth);
      } else if (item.isFile() && matchPattern(item.name, pattern)) {
        results.push(fullPath);
      }
    }
  } catch { /* permission errors */ }
}

function matchPattern(name: string, pattern: string): boolean {
  const regex = pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regex}$`, "i").test(name);
}

export const filesystemTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  searchFilesTool,
];
