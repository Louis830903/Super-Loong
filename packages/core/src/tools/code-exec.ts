/**
 * Code Execution Tools — run Python, JavaScript, and Shell code in sandbox.
 */

import { z } from "zod";
import { spawn, execFileSync } from "node:child_process";
import type { ToolDefinition, ToolResult } from "../types/index.js";

/** Detect the best PowerShell executable on Windows (pwsh 7+ preferred, powershell 5.1 fallback). */
let _pwshPath: string | undefined;
async function findPowerShell(): Promise<string> {
  if (_pwshPath) return _pwshPath;
  try {
    execFileSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore", timeout: 5000 });
    _pwshPath = "pwsh";
  } catch {
    _pwshPath = "powershell";
  }
  return _pwshPath;
}

async function executeCode(cmd: string, args: string[], timeout = 30000): Promise<ToolResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGKILL");
        resolve({ success: false, output: stdout + stderr, error: `Timeout after ${timeout}ms` });
      }
    }, timeout);

    proc.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const output = (stdout + stderr).trim();
        resolve({
          success: code === 0,
          output: output || `Exit code: ${code}`,
          error: code !== 0 ? `Exit code: ${code}` : undefined,
        });
      }
    });

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ success: false, output: err.message, error: err.message });
      }
    });
  });
}

// Platform detection — used by execution logic only, NOT injected into tool descriptions.
// OS/shell info is injected into the system prompt by PromptEngine.buildRuntimeSection()
// following the OpenClaw/Hermes separation-of-concerns pattern.
const isWin = process.platform === "win32";

export const runPythonTool: ToolDefinition = {
  name: "run_python",
  description: "Execute Python code and return the output. Use print() to produce output. To send generated files (charts, images, CSVs, etc.) to the user, save them with a known path, then call write_file to deliver or output MEDIA:/absolute/path.",
  parameters: z.object({
    code: z.string().describe("Python code to execute"),
    timeout: z.number().default(30000).describe("Timeout in milliseconds"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { code, timeout } = params as { code: string; timeout: number };
    const pythonCmd = isWin ? "python" : "python3";
    return executeCode(pythonCmd, ["-c", code], timeout);
  },
};

export const runJavaScriptTool: ToolDefinition = {
  name: "run_javascript",
  description: "Execute JavaScript/Node.js code and return the output. Use console.log() to produce output. To send generated files to the user, save them with a known path, then call write_file to deliver or output MEDIA:/absolute/path.",
  parameters: z.object({
    code: z.string().describe("JavaScript code to execute"),
    timeout: z.number().default(30000).describe("Timeout in milliseconds"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { code, timeout } = params as { code: string; timeout: number };
    return executeCode("node", ["-e", code], timeout);
  },
};

export const runShellTool: ToolDefinition = {
  name: "run_shell",
  description: "Execute a shell command on the host and return stdout/stderr. Check the Runtime section for OS and shell details. To send generated files to the user, note the output path, then call write_file to deliver or output MEDIA:/absolute/path.",
  parameters: z.object({
    command: z.string().describe("Shell command to execute (use syntax matching the host OS shell)"),
    timeout: z.number().default(30000).describe("Timeout in milliseconds"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { command, timeout } = params as { command: string; timeout: number };
    if (isWin) {
      // Prefer pwsh (PowerShell 7+), fall back to powershell (5.1)
      const shell = await findPowerShell();
      return executeCode(shell, ["-NoProfile", "-Command", command], timeout);
    }
    return executeCode("sh", ["-c", command], timeout);
  },
};

export const codeExecTools: ToolDefinition[] = [
  runPythonTool,
  runJavaScriptTool,
  runShellTool,
];
