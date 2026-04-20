/**
 * Docker Container Sandbox — executes code in isolated Docker containers.
 *
 * Uses `docker run --rm` via child_process to provide:
 * - Full process isolation
 * - Memory and CPU limits
 * - Network isolation (default: none)
 * - Automatic cleanup (--rm flag)
 * - Timeout enforcement via docker kill
 */

import { spawn } from "node:child_process";
import pino from "pino";
import type { SandboxBackend, SandboxResult } from "./sandbox.js";

const logger = pino({ name: "docker-sandbox" });

export interface DockerSandboxConfig {
  /** Docker image to use. Default: "node:20-slim" */
  image: string;
  /** Memory limit. Default: "128m" */
  memoryLimit: string;
  /** CPU limit. Default: "0.5" */
  cpuLimit: string;
  /** Network mode. Default: "none" (no network access) */
  networkMode: string;
  /** Execution timeout in ms. Default: 30000 */
  timeout: number;
  /** Working directory inside container. Default: "/workspace" */
  workDir: string;
  /** Optional volume mounts (host:container format) */
  volumes?: string[];
}

const DEFAULT_CONFIG: DockerSandboxConfig = {
  image: "node:20-slim",
  memoryLimit: "128m",
  cpuLimit: "0.5",
  networkMode: "none",
  timeout: 30000,
  workDir: "/workspace",
};

export class DockerSandbox implements SandboxBackend {
  private config: DockerSandboxConfig;
  private activeCount = 0;
  private maxConcurrent: number;
  private _available: boolean | null = null;
  // C-6: TTL 缓存，避免永久缓存 Docker 可用性状态
  private _availableCheckedAt = 0;
  private static readonly AVAILABILITY_TTL_MS = 5 * 60 * 1000; // 5 分钟

  constructor(config?: Partial<DockerSandboxConfig>, maxConcurrent = 5) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.maxConcurrent = maxConcurrent;
  }

  get active(): number {
    return this.activeCount;
  }

  /** Check if Docker is available on the system (5 分钟 TTL 缓存) */
  async isAvailable(): Promise<boolean> {
    // C-6: TTL 过期后重新检查
    if (this._available !== null && (Date.now() - this._availableCheckedAt) < DockerSandbox.AVAILABILITY_TTL_MS) {
      return this._available;
    }
    try {
      const result = await this.runCommand("docker", ["version", "--format", "{{.Server.Version}}"], 5000);
      this._available = result.success;
      this._availableCheckedAt = Date.now();
      if (this._available) {
        logger.info({ version: result.output.trim() }, "Docker available");
      }
      return this._available;
    } catch {
      this._available = false;
      this._availableCheckedAt = Date.now();
      logger.warn("Docker not available on this system");
      return false;
    }
  }

  /**
   * Execute code inside a Docker container.
   *
   * @param code - Code string to execute
   * @param language - Language: "javascript" | "python" | "shell"
   * @param args - Optional arguments passed as environment variables
   */
  async execute(
    code: string,
    language: "javascript" | "python" | "shell" = "javascript",
    args: Record<string, string> = {},
  ): Promise<SandboxResult> {
    if (!(await this.isAvailable())) {
      return {
        success: false,
        output: "Docker is not available",
        error: "Docker runtime not found",
        durationMs: 0,
      };
    }

    if (this.activeCount >= this.maxConcurrent) {
      return {
        success: false,
        output: "Docker sandbox limit reached",
        error: "Max concurrent Docker sandboxes exceeded",
        durationMs: 0,
      };
    }

    const start = Date.now();
    this.activeCount++;

    try {
      // Build docker run command
      const containerName = `sa-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const dockerArgs = this.buildDockerArgs(containerName, language, args);

      // Determine the command to run inside the container
      const { cmd, shellArgs } = this.getLanguageCommand(language, code);

      dockerArgs.push(this.getImageForLanguage(language), cmd, ...shellArgs);

      const result = await this.runCommand("docker", dockerArgs, this.config.timeout);

      return {
        ...result,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: errMsg,
        error: errMsg,
        durationMs: Date.now() - start,
      };
    } finally {
      this.activeCount--;
    }
  }

  private buildDockerArgs(
    containerName: string,
    language: string,
    envVars: Record<string, string>,
  ): string[] {
    const args = [
      "run",
      "--rm",
      "--name", containerName,
      "--memory", this.config.memoryLimit,
      "--cpus", this.config.cpuLimit,
      "--network", this.config.networkMode,
      "--workdir", this.config.workDir,
      "--no-healthcheck",
      "--pids-limit", "50",
    ];

    // Add environment variables
    for (const [key, value] of Object.entries(envVars)) {
      args.push("-e", `${key}=${value}`);
    }

    // Add volume mounts
    if (this.config.volumes) {
      for (const vol of this.config.volumes) {
        args.push("-v", vol);
      }
    }

    return args;
  }

  private getImageForLanguage(language: string): string {
    switch (language) {
      case "python": return "python:3.12-slim";
      case "shell": return "alpine:3.19";
      default: return this.config.image;
    }
  }

  private getLanguageCommand(language: string, code: string): { cmd: string; shellArgs: string[] } {
    switch (language) {
      case "python":
        return { cmd: "python3", shellArgs: ["-c", code] };
      case "shell":
        return { cmd: "sh", shellArgs: ["-c", code] };
      default:
        return { cmd: "node", shellArgs: ["-e", code] };
    }
  }

  private runCommand(cmd: string, args: string[], timeout: number): Promise<SandboxResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const proc = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      proc.stdout.on("data", (data) => { stdout += data.toString(); });
      proc.stderr.on("data", (data) => { stderr += data.toString(); });

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill("SIGKILL");
          // Also try to kill the docker container by name if this is a docker run
          if (args[0] === "run" && args.includes("--name")) {
            const nameIdx = args.indexOf("--name") + 1;
            if (nameIdx < args.length) {
              spawn("docker", ["kill", args[nameIdx]], { stdio: "ignore" });
            }
          }
          resolve({
            success: false,
            output: stdout + stderr,
            error: `Execution timed out after ${timeout}ms`,
            durationMs: timeout,
          });
        }
      }, timeout);

      proc.on("close", (exitCode) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const output = (stdout + stderr).trim();
          resolve({
            success: exitCode === 0,
            output,
            error: exitCode !== 0 ? `Exit code: ${exitCode}` : undefined,
            durationMs: 0,
          });
        }
      });

      proc.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            success: false,
            output: err.message,
            error: err.message,
            durationMs: 0,
          });
        }
      });
    });
  }
}
