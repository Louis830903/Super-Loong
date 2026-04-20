/**
 * 执行环境接口 + 内置实现
 */

// ═══════════════════════════════════════════════════════════════
// Environment Interface
// ═══════════════════════════════════════════════════════════════

/** 执行环境接口 */
export interface ExecutionEnvironment {
  name: string;
  /** 初始化环境 */
  setup(): Promise<void>;
  /** 在环境中执行命令 */
  execute(command: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** 清理环境 */
  teardown(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════
// Local Environment
// ═══════════════════════════════════════════════════════════════

/** 本地执行环境（直接在当前进程中执行） */
export class LocalEnvironment implements ExecutionEnvironment {
  name = "local";

  async setup(): Promise<void> {
    // 无需初始化
  }

  async execute(
    command: string,
    timeoutMs: number = 30_000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { execSync } = await import("node:child_process");
    try {
      const stdout = execSync(command, {
        timeout: timeoutMs,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        exitCode: err.status ?? 1,
      };
    }
  }

  async teardown(): Promise<void> {
    // 无需清理
  }
}

// ═══════════════════════════════════════════════════════════════
// Docker Environment
// ═══════════════════════════════════════════════════════════════

/** Docker 隔离执行环境 */
export class DockerEnvironment implements ExecutionEnvironment {
  name = "docker";
  private containerId: string | null = null;
  private image: string;

  constructor(image: string = "node:22-slim") {
    this.image = image;
  }

  async setup(): Promise<void> {
    const { execSync } = await import("node:child_process");
    try {
      const result = execSync(
        `docker run -d --rm ${this.image} tail -f /dev/null`,
        { encoding: "utf-8" }
      );
      this.containerId = result.trim();
    } catch (err: any) {
      throw new Error(`Docker 环境初始化失败: ${err.message}`);
    }
  }

  async execute(
    command: string,
    timeoutMs: number = 30_000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!this.containerId) {
      throw new Error("Docker 容器未初始化");
    }

    const { execSync } = await import("node:child_process");
    try {
      const stdout = execSync(
        `docker exec ${this.containerId} sh -c "${command.replace(/"/g, '\\"')}"`,
        { timeout: timeoutMs, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
      );
      return { stdout, stderr: "", exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        exitCode: err.status ?? 1,
      };
    }
  }

  async teardown(): Promise<void> {
    if (!this.containerId) return;
    const { execSync } = await import("node:child_process");
    try {
      execSync(`docker stop ${this.containerId}`, { encoding: "utf-8" });
    } catch {
      // 容器可能已停止
    }
    this.containerId = null;
  }
}
