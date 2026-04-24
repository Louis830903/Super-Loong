/**
 * 多Agent协作工作空间管理模块。
 *
 * 职责：为每次 Crew/GroupChat 执行创建独立工作空间目录，
 * 统一归档任务产出文件（文本+附件），生成 README 索引，
 * 定期清理过期目录。
 *
 * 设计原则：
 * - 只负责目录和文件管理，ZIP打包放在 api 层（jszip 在 api 包中）
 * - 通过 resolveHome() 获取数据根目录，与 paths.ts 保持一致
 * - 低耦合：不依赖 orchestrator 内部类型，只通过纯参数传递
 */

import * as fs from "node:fs";
import * as path from "node:path";
import pino from "pino";
import { resolveHome } from "../config/paths.js";

const logger = pino({ name: "collab-workspace" });

// ─── 接口定义 ──────────────────────────────────────────────────

export interface WorkspaceConfig {
  /** Crew/GroupChat 的唯一ID */
  collabId: string;
  /** 协作名称（用于目录命名） */
  name: string;
  /** 协作类型 */
  type: "crew" | "groupchat";
}

export interface WorkspaceInfo {
  /** 工作空间根目录绝对路径 */
  rootDir: string;
  /** 协作ID */
  collabId: string;
  /** README.md 路径 */
  readmePath: string;
}

/** 简化的附件信息（避免依赖 core 的 Attachment 类型） */
export interface WorkspaceAttachment {
  path?: string;
  filename?: string;
}

/** 简化的任务输出信息（用于生成 README） */
export interface WorkspaceTaskOutput {
  taskId: string;
  agentId: string;
  output: string;
  attachments?: WorkspaceAttachment[];
}

/** 简化的消息信息（GroupChat README 生成用） */
export interface WorkspaceMessage {
  id: string;
  agentId: string;
  agentName: string;
  content: string;
  role: string;
}

// ─── 常量 ──────────────────────────────────────────────────────

/** 工作空间产出的子目录名称 */
const COLLAB_OUTPUTS_DIR = "collab-outputs";

/** 默认过期天数 */
const DEFAULT_MAX_AGE_DAYS = 30;

/** 清理定时器间隔（24小时） */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ─── 核心函数 ──────────────────────────────────────────────────

/**
 * 返回 `resolveHome()/collab-outputs/` 的绝对路径。
 * 供 API 白名单使用（最小权限原则：只放行此子目录）。
 */
export function getCollabOutputsRoot(): string {
  return path.join(resolveHome(), COLLAB_OUTPUTS_DIR);
}

/**
 * 为一次协作执行创建独立的工作空间目录。
 * 目录路径: {SA_HOME}/collab-outputs/{collabId}/
 */
export async function createWorkspace(config: WorkspaceConfig): Promise<WorkspaceInfo> {
  const root = getCollabOutputsRoot();
  const workspaceDir = path.join(root, config.collabId);

  await fs.promises.mkdir(workspaceDir, { recursive: true });

  logger.info(
    { collabId: config.collabId, type: config.type, dir: workspaceDir },
    "工作空间已创建",
  );

  return {
    rootDir: workspaceDir,
    collabId: config.collabId,
    readmePath: path.join(workspaceDir, "README.md"),
  };
}

/**
 * 将纯文本输出保存为 .md 文件（兜底保存：无附件的任务输出也有文件记录）。
 * 文件名格式: {index}-{taskId}.md
 */
export async function saveTaskOutput(
  ws: WorkspaceInfo,
  taskId: string,
  agentId: string,
  output: string,
  index: number,
): Promise<string> {
  // 清理 taskId 中的非法文件名字符
  const safeTaskId = taskId.replace(/[<>:"/\\|?*]/g, "_");
  const filename = `${String(index).padStart(2, "0")}-${safeTaskId}.md`;
  const filePath = path.join(ws.rootDir, filename);

  const header = `# Task: ${taskId}\n> Agent: ${agentId}\n\n`;
  await fs.promises.writeFile(filePath, header + output, "utf-8");

  logger.debug({ collabId: ws.collabId, filename }, "任务输出已保存");
  return filePath;
}

/**
 * 将不在工作空间目录内的附件复制过来。
 *
 * 逻辑：
 * - 如果 attachment.path 以 workspace.rootDir 开头 → 跳过（已在工作空间内）
 * - 如果 attachment.path 存在且文件存在 → 复制到 workspace，冲突时加序号后缀
 * - 否则（url-only 或 base64-only）→ 跳过
 */
export async function collectExternalAttachments(
  ws: WorkspaceInfo,
  attachments: WorkspaceAttachment[],
): Promise<void> {
  if (!attachments.length) return;

  for (const att of attachments) {
    if (!att.path) continue;

    const resolved = path.resolve(att.path);

    // 已在工作空间内，跳过
    if (resolved.startsWith(ws.rootDir + path.sep) || resolved === ws.rootDir) {
      continue;
    }

    // 源文件不存在，跳过
    try {
      await fs.promises.access(resolved, fs.constants.R_OK);
    } catch {
      logger.debug({ path: att.path }, "外部附件不可读，跳过");
      continue;
    }

    // 计算目标文件名（冲突时加序号后缀）
    const originalName = att.filename || path.basename(resolved);
    let targetPath = path.join(ws.rootDir, originalName);
    let counter = 1;
    while (fs.existsSync(targetPath)) {
      const ext = path.extname(originalName);
      const base = path.basename(originalName, ext);
      targetPath = path.join(ws.rootDir, `${base}_${counter}${ext}`);
      counter++;
    }

    try {
      await fs.promises.copyFile(resolved, targetPath);
      logger.debug({ from: resolved, to: targetPath }, "外部附件已复制到工作空间");
    } catch (err: any) {
      logger.warn({ path: att.path, error: err.message }, "复制外部附件失败");
    }
  }
}

/**
 * 生成 README.md 汇总索引。
 * 支持 Crew（taskOutputs）和 GroupChat（messages）两种模式。
 */
export async function generateReadme(
  ws: WorkspaceInfo,
  taskOutputs: WorkspaceTaskOutput[] | null,
  collabName: string,
  status: string,
  messages?: WorkspaceMessage[],
): Promise<void> {
  const lines: string[] = [];
  const now = new Date().toISOString();

  lines.push(`# ${collabName}`);
  lines.push("");
  lines.push(`> 状态: **${status}** | 生成时间: ${now}`);
  lines.push("");

  // 列出目录中的所有文件
  try {
    const files = await fs.promises.readdir(ws.rootDir);
    const outputFiles = files.filter(f => f !== "README.md");
    if (outputFiles.length > 0) {
      lines.push("## 产出文件");
      lines.push("");
      for (const f of outputFiles) {
        lines.push(`- [${f}](./${f})`);
      }
      lines.push("");
    }
  } catch {
    // 目录读取失败不影响 README 生成
  }

  // Crew 模式：列出任务摘要
  if (taskOutputs) {
    lines.push("## 任务摘要");
    lines.push("");
    for (const [i, to] of taskOutputs.entries()) {
      lines.push(`### ${i + 1}. ${to.taskId} (${to.agentId})`);
      lines.push("");
      // 截取前200字作为摘要
      const preview = to.output.slice(0, 200).replace(/\n/g, " ");
      lines.push(`${preview}${to.output.length > 200 ? "..." : ""}`);
      lines.push("");
    }
  }

  // GroupChat 模式：列出对话摘要
  if (messages) {
    lines.push("## 对话摘要");
    lines.push("");
    const nonSystem = messages.filter(m => m.role !== "system");
    lines.push(`共 ${nonSystem.length} 条消息`);
    lines.push("");
    for (const msg of nonSystem.slice(0, 10)) {
      const preview = msg.content.slice(0, 100).replace(/\n/g, " ");
      lines.push(`- **${msg.agentName}**: ${preview}${msg.content.length > 100 ? "..." : ""}`);
    }
    if (nonSystem.length > 10) {
      lines.push(`- ...及其他 ${nonSystem.length - 10} 条消息`);
    }
    lines.push("");
  }

  await fs.promises.writeFile(ws.readmePath, lines.join("\n"), "utf-8");
  logger.debug({ collabId: ws.collabId }, "README.md 已生成");
}

/**
 * 查询已存在的工作空间路径。
 * 如果目录不存在，返回 undefined。
 */
export function getWorkspacePath(collabId: string): string | undefined {
  const dir = path.join(getCollabOutputsRoot(), collabId);
  return fs.existsSync(dir) ? dir : undefined;
}

/**
 * 清理超过 N 天的旧工作空间目录。
 * 扫描 collab-outputs/ 下的子目录，根据目录修改时间判断是否过期。
 */
export async function cleanExpiredWorkspaces(maxAgeDays: number = DEFAULT_MAX_AGE_DAYS): Promise<number> {
  const root = getCollabOutputsRoot();
  if (!fs.existsSync(root)) return 0;

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dirPath = path.join(root, entry.name);
      try {
        const stat = await fs.promises.stat(dirPath);
        if (stat.mtimeMs < cutoff) {
          await fs.promises.rm(dirPath, { recursive: true, force: true });
          cleaned++;
          logger.info({ dir: entry.name }, "过期工作空间已清理");
        }
      } catch (err: any) {
        logger.warn({ dir: entry.name, error: err.message }, "清理工作空间失败");
      }
    }
  } catch (err: any) {
    logger.warn({ error: err.message }, "扫描 collab-outputs 目录失败");
  }

  if (cleaned > 0) {
    logger.info({ cleaned, maxAgeDays }, "工作空间清理完成");
  }

  return cleaned;
}

/**
 * 启动工作空间清理定时器（24小时间隔）。
 * 复用 MediaStore 的 TTL 定时器模式：setInterval + unref，不阻塞进程退出。
 * 在 CollaborationOrchestrator 初始化时调用一次。
 */
export function startWorkspaceCleanupTimer(maxAgeDays: number = DEFAULT_MAX_AGE_DAYS): void {
  // 启动时立即执行一次清理（异步，不阻塞）
  cleanExpiredWorkspaces(maxAgeDays).catch((err) =>
    logger.warn({ error: err }, "启动时工作空间清理失败"),
  );

  // 定时清理（24小时间隔，unref 不阻塞进程退出）
  const timer = setInterval(() => {
    cleanExpiredWorkspaces(maxAgeDays).catch((err) =>
      logger.warn({ error: err }, "定时工作空间清理失败"),
    );
  }, CLEANUP_INTERVAL_MS);
  timer.unref();

  logger.info({ maxAgeDays, intervalHours: 24 }, "工作空间清理定时器已启动");
}

/**
 * 检测 Python 环境是否具备文档生成能力。
 * 返回各库的可用状态，供前端提示用户安装缺失的库。
 */
export async function checkPythonDocLibs(): Promise<{
  available: string[];
  missing: string[];
}> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const libs = [
    { importName: "pptx", pipName: "python-pptx" },
    { importName: "docx", pipName: "python-docx" },
    { importName: "openpyxl", pipName: "openpyxl" },
    { importName: "fpdf", pipName: "fpdf2" },
    { importName: "PIL", pipName: "pillow" },
  ];

  // 构造一个 Python 脚本检测所有库
  const checkScript = `
import json
results = {}
${libs.map((l) => `
try:
    __import__("${l.importName}")
    results["${l.pipName}"] = True
except ImportError:
    results["${l.pipName}"] = False
`).join("")}
print(json.dumps(results))
`.trim();

  try {
    const { stdout } = await execFileAsync("python", ["-c", checkScript], {
      timeout: 10_000,
    });

    const results = JSON.parse(stdout.trim()) as Record<string, boolean>;
    const available: string[] = [];
    const missing: string[] = [];
    for (const [name, ok] of Object.entries(results)) {
      if (ok) available.push(name);
      else missing.push(name);
    }
    return { available, missing };
  } catch (err: any) {
    logger.warn({ error: err.message }, "Python 环境检测失败（可能未安装 Python）");
    // Python 不可用时，所有库标记为 missing
    return {
      available: [],
      missing: libs.map((l) => l.pipName),
    };
  }
}
