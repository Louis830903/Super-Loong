/**
 * SSH Remote Sandbox — executes code on remote machines via SSH.
 *
 * Uses the `ssh2` npm package to:
 * - Connect to remote machines via SSH key or password auth
 * - Execute commands in isolated remote environments
 * - Collect stdout/stderr output
 * - Enforce timeouts by closing the SSH channel
 */

import pino from "pino";
import type { SandboxBackend, SandboxResult } from "./sandbox.js";

const logger = pino({ name: "ssh-sandbox" });

export interface SSHSandboxConfig {
  /** Remote host */
  host: string;
  /** SSH port. Default: 22 */
  port: number;
  /** Username for SSH authentication */
  username: string;
  /** Path to private key file */
  privateKeyPath?: string;
  /** Password authentication (fallback) */
  password?: string;
  /** Execution timeout in ms. Default: 30000 */
  timeout: number;
  /** Remote working directory. Default: "/tmp/sa-sandbox" */
  workDir: string;
}

const DEFAULT_CONFIG: Partial<SSHSandboxConfig> = {
  port: 22,
  timeout: 30000,
  workDir: "/tmp/sa-sandbox",
};

export class SSHSandbox implements SandboxBackend {
  private config: SSHSandboxConfig;
  private activeCount = 0;
  private maxConcurrent: number;

  constructor(config: SSHSandboxConfig, maxConcurrent = 5) {
    this.config = { ...DEFAULT_CONFIG, ...config } as SSHSandboxConfig;
    this.maxConcurrent = maxConcurrent;
  }

  get active(): number {
    return this.activeCount;
  }

  /**
   * Execute a command on the remote machine via SSH.
   *
   * @param code - Code/command to execute
   * @param language - Language: "javascript" | "python" | "shell"
   */
  async execute(
    code: string,
    language: "javascript" | "python" | "shell" = "shell",
  ): Promise<SandboxResult> {
    if (this.activeCount >= this.maxConcurrent) {
      return {
        success: false,
        output: "SSH sandbox limit reached",
        error: "Max concurrent SSH sandboxes exceeded",
        durationMs: 0,
      };
    }

    const start = Date.now();
    this.activeCount++;

    try {
      // Dynamically require ssh2 (optional dependency)
      let Client: any;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const ssh2 = require("ssh2");
        Client = ssh2.Client ?? ssh2;
        if (!Client) throw new Error("ssh2 Client not found");
      } catch {
        return {
          success: false,
          output: "ssh2 package not installed",
          error: "Install ssh2: pnpm add ssh2",
          durationMs: Date.now() - start,
        };
      }

      const command = this.buildCommand(code, language);
      const result = await this.executeSSH(Client, command);

      return {
        ...result,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ host: this.config.host, error: errMsg }, "SSH execution failed");
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

  /** Check if SSH connection can be established */
  async isAvailable(): Promise<boolean> {
    try {
      let Client: any;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ssh2 = require("ssh2");
      Client = ssh2.Client ?? ssh2;
      if (!Client) return false;

      return new Promise((resolve) => {
        const conn = new Client();
        const connectConfig = this.buildConnectConfig();

        const timer = setTimeout(() => {
          conn.end();
          resolve(false);
        }, 5000);

        conn.on("ready", () => {
          clearTimeout(timer);
          conn.end();
          resolve(true);
        }).on("error", () => {
          clearTimeout(timer);
          resolve(false);
        }).connect(connectConfig);
      });
    } catch {
      return false;
    }
  }

  private buildCommand(code: string, language: string): string {
    // P0-A3: 所有语言模式都使用单引号转义防止命令注入
    const escapedCode = code.replace(/'/g, "'\\'");
    const mkdirCmd = `mkdir -p ${this.config.workDir}`;
  
    switch (language) {
      case "javascript":
        return `${mkdirCmd} && cd ${this.config.workDir} && node -e '${escapedCode}'`;
      case "python":
        return `${mkdirCmd} && cd ${this.config.workDir} && python3 -c '${escapedCode}'`;
      default:
        // P0-A3: shell 模式也必须转义，通过 sh -c 执行防止直接拼接注入
        return `${mkdirCmd} && cd ${this.config.workDir} && sh -c '${escapedCode}'`;
    }
  }

  private buildConnectConfig(): Record<string, unknown> {
    const config: Record<string, unknown> = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      readyTimeout: this.config.timeout,
    };

    if (this.config.privateKeyPath) {
      try {
        const fs = require("node:fs");
        config.privateKey = fs.readFileSync(this.config.privateKeyPath);
      } catch (err) {
        logger.warn({ path: this.config.privateKeyPath }, "Cannot read SSH private key");
      }
    } else if (this.config.password) {
      config.password = this.config.password;
    }

    return config;
  }

  private executeSSH(
    Client: any,
    command: string,
  ): Promise<SandboxResult> {
    return new Promise((resolve) => {
      const conn = new Client();
      let settled = false;
      let stdout = "";
      let stderr = "";

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          conn.end();
          resolve({
            success: false,
            output: stdout + stderr,
            error: `SSH execution timed out after ${this.config.timeout}ms`,
            durationMs: this.config.timeout,
          });
        }
      }, this.config.timeout);

      conn.on("ready", () => {
        conn.exec(command, (err: Error | undefined, stream: any) => {
          if (err) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              conn.end();
              resolve({
                success: false,
                output: err.message,
                error: err.message,
                durationMs: 0,
              });
            }
            return;
          }

          stream.on("data", (data: Buffer) => { stdout += data.toString(); });
          stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

          stream.on("close", (exitCode: number) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              conn.end();
              resolve({
                success: exitCode === 0,
                output: (stdout + stderr).trim(),
                error: exitCode !== 0 ? `Exit code: ${exitCode}` : undefined,
                durationMs: 0,
              });
            }
          });
        });
      }).on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            success: false,
            output: err.message,
            error: `SSH connection error: ${err.message}`,
            durationMs: 0,
          });
        }
      }).connect(this.buildConnectConfig());
    });
  }
}
