/**
 * Super Agent 一键初始化脚本 — `pnpm setup`
 *
 * 自动完成首次安装所需的全部准备：
 *   1. 从 .env.example 创建 .env（如不存在）
 *   2. 自动生成 SA_ENCRYPTION_KEY（如未设置或为弱密钥）
 *   3. 安装 Node.js 依赖（pnpm install）
 *   4. 自举 Python 微服务依赖（pip install -r requirements.txt）
 *   5. 打印配置清单
 *
 * 用法：npx tsx scripts/setup.ts   （或 `pnpm setup`）
 *
 * 设计原则：
 *   - 零 npm 依赖（仅用 Node.js 内置模块）
 *   - 幂等：重复运行安全，不会覆盖已有配置
 *   - 非阻塞：Python 自举失败仅警告，不影响后续步骤
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";

// ==================== 工具函数 ====================

/** 已知弱密钥黑名单 */
const KNOWN_WEAK_KEYS = new Set([
  "super-agent-default-encryption-key-v1",
  "super-agent-default-encryption-key",
  "default-encryption-key",
  "changeme",
  "password",
]);

function isWeakKey(key: string): boolean {
  return key.length < 32 || KNOWN_WEAK_KEYS.has(key);
}

/** 向上查找 pnpm-workspace.yaml，定位 monorepo 根 */
function findMonorepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 解析 .env 文件中的键值对（仅处理简单 KEY=VALUE） */
function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return result;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // 去掉可选引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** 将键值写回 .env 文件（替换已有 key 或追加） */
function writeEnvKey(envPath: string, key: string, value: string): void {
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `${key}=${value}\n`, "utf-8");
    return;
  }

  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("#") || !trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    if (trimmed.slice(0, eqIdx).trim() === key) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }

  if (!found) lines.push(`${key}=${value}`);

  fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");
}

/** 生成强随机加密密钥（base64，48 字节） */
function generateEncryptionKey(): string {
  return randomBytes(48).toString("base64");
}

/** 检测 Python 3.11+ 是否可用 */
function detectPython(): { path: string; version: string } | null {
  const candidates = process.platform === "win32" ? ["python"] : ["python3", "python"];
  for (const cmd of candidates) {
    try {
      const out = execSync(`${cmd} --version`, { encoding: "utf-8", timeout: 10000 }).trim();
      const m = out.match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
      if (!m) continue;
      const major = parseInt(m[1], 10);
      const minor = parseInt(m[2], 10);
      if (major > 3 || (major === 3 && minor >= 11)) {
        return { path: cmd, version: `${major}.${minor}.${m[3]}` };
      }
    } catch {
      // 命令不存在，尝试下一个
    }
  }
  return null;
}

// ==================== 主流程 ====================

function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║     Super Agent — 一键初始化 (setup)     ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // ── Step 1: 定位 monorepo 根 ──
  const root = findMonorepoRoot(process.cwd());
  if (!root) {
    console.error("[错误] 未找到 pnpm-workspace.yaml，请在 monorepo 根目录或其子目录运行此脚本。");
    process.exit(1);
  }
  console.log(`[1/5] Monorepo 根目录: ${root}\n`);

  // ── Step 2: 创建 .env ──
  const envPath = path.join(root, ".env");
  const envExamplePath = path.join(root, ".env.example");

  if (!fs.existsSync(envPath)) {
    if (fs.existsSync(envExamplePath)) {
      fs.copyFileSync(envExamplePath, envPath);
      console.log("[2/5] .env 已从 .env.example 创建");
    } else {
      fs.writeFileSync(envPath, "", "utf-8");
      console.log("[2/5] .env 已创建（空）");
    }
  } else {
    console.log("[2/5] .env 已存在，跳过");
  }

  // ── Step 3: 配置 SA_ENCRYPTION_KEY ──
  const envVars = parseEnvFile(envPath);
  const existingKey = envVars["SA_ENCRYPTION_KEY"] || "";

  if (!existingKey || isWeakKey(existingKey)) {
    const newKey = generateEncryptionKey();
    writeEnvKey(envPath, "SA_ENCRYPTION_KEY", newKey);
    console.log(`[3/5] SA_ENCRYPTION_KEY 已生成 (${newKey.slice(0, 8)}...)`);
  } else {
    console.log("[3/5] SA_ENCRYPTION_KEY 已配置（强度达标）");
  }

  // 删除可能残留的 LEGACY 行（新环境不需要）
  const envContent = fs.readFileSync(envPath, "utf-8");
  if (envContent.includes("SA_ENCRYPTION_KEY_LEGACY=")) {
    const cleaned = envContent
      .split("\n")
      .filter((l) => !l.trim().startsWith("SA_ENCRYPTION_KEY_LEGACY="))
      .join("\n");
    fs.writeFileSync(envPath, cleaned + "\n", "utf-8");
  }

  // ── Step 4: Seed 内置技能 ──
  console.log("[4/7] Seed 内置技能到运行时目录...");

  const builtinSkillsDir = path.join(root, "packages", "api", "data", "skills");
  const runtimeSkillsDir = path.join(os.homedir(), ".super-agent", "skills");

  if (fs.existsSync(builtinSkillsDir)) {
    // 确保运行时目录存在
    fs.mkdirSync(runtimeSkillsDir, { recursive: true });

    // 递归复制内置技能文件（幂等：已存在的文件不会被覆盖）
    let copiedCount = 0;
    const entries = fs.readdirSync(builtinSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      const src = path.join(builtinSkillsDir, entry.name);
      const dest = path.join(runtimeSkillsDir, entry.name);
      if (!fs.existsSync(dest)) {
        fs.cpSync(src, dest, { recursive: true });
        copiedCount++;
      }
    }
    console.log(`  ✅ 已 Seed ${copiedCount} 个内置技能${copiedCount === 0 ? "（均已就位）" : ""}`);
  } else {
    console.warn(`  ⚠️  内置技能目录不存在: ${builtinSkillsDir}`);
  }

  // ── Step 5: 自动开启高级功能 ──
  console.log("[5/7] 配置高级功能开关...");

  // 全链路追踪 —— 自动开启，方便用户发现问题
  if (!parseEnvFile(envPath)["ENABLE_TRACING"]) {
    writeEnvKey(envPath, "ENABLE_TRACING", "true");
    console.log("  ✅ ENABLE_TRACING=true（全链路追踪已开启）");
  } else {
    console.log("  ENABLE_TRACING 已配置，跳过");
  }

  // A2A 协作协议 —— 自动开启，跨 Agent 通信
  if (!parseEnvFile(envPath)["ENABLE_A2A"]) {
    writeEnvKey(envPath, "ENABLE_A2A", "true");
    console.log("  ✅ ENABLE_A2A=true（A2A 协作协议已开启）");
  } else {
    console.log("  ENABLE_A2A 已配置，跳过");
  }

  // ── Step 6: Node.js 依赖 ──
  console.log("[6/7] 安装 Node.js 依赖（pnpm install）...");
  try {
    execSync("pnpm install", { cwd: root, stdio: "inherit", timeout: 300000 });
  } catch {
    console.warn("[警告] pnpm install 失败，请手动运行。");
  }

  // ── Step 7: Python 微服务依赖自举 ──
  console.log("[7/7] Python 微服务依赖...");

  const python = detectPython();
  if (!python) {
    console.warn("  [警告] 未检测到 Python 3.11+，跳过 Python 微服务自举。");
    console.warn("  安装 Python 后请手动运行: pip install -r requirements.txt（分别进入 services/im-gateway, services/video-forge, services/kb-parser）");
  } else {
    const serviceDirs = [
      { dir: "services/im-gateway", name: "IM Gateway" },
      { dir: "services/video-forge", name: "Video-Forge" },
      { dir: "services/kb-parser", name: "KB-Parser" },
    ];
    let installedCount = 0;
    for (const svc of serviceDirs) {
      const svcPath = path.join(root, svc.dir);
      if (fs.existsSync(path.join(svcPath, "requirements.txt"))) {
        console.log(`  ${svc.name}: pip install -r requirements.txt...`);
        try {
          const result = spawnSync(python.path, ["-m", "pip", "install", "-r", "requirements.txt"], {
            cwd: svcPath,
            stdio: "pipe",
            timeout: 180000,
          });
          if (result.status === 0) {
            console.log(`  ${svc.name} 依赖安装成功！`);
            installedCount++;
          } else {
            const stderr = result.stderr?.toString() || "";
            console.warn(`  [警告] ${svc.name} pip install 退出码 ${result.status}${stderr ? ": " + stderr.slice(0, 120) : ""}`);
          }
        } catch (err: any) {
          console.warn(`  [警告] ${svc.name} pip install 失败: ${err.message}`);
        }
      } else {
        console.warn(`  [警告] ${svc.dir}/requirements.txt 不存在，跳过`);
      }
    }
    if (installedCount > 0) {
      console.log(`  共 ${installedCount}/${serviceDirs.length} 个 Python 微服务依赖已安装`);
    }
  }

  // ── 总结 ──
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║            初始化完成！                  ║");
  console.log("╚══════════════════════════════════════════╝\n");

  const finalEnv = parseEnvFile(envPath);

  const checks: { label: string; ok: boolean; hint?: string }[] = [
    { label: "SA_ENCRYPTION_KEY", ok: !!finalEnv["SA_ENCRYPTION_KEY"] && !isWeakKey(finalEnv["SA_ENCRYPTION_KEY"]) },
    { label: "内置技能", ok: fs.existsSync(path.join(os.homedir(), ".super-agent", "skills")) },
    { label: "ENABLE_TRACING", ok: finalEnv["ENABLE_TRACING"] === "true" },
    { label: "ENABLE_A2A", ok: finalEnv["ENABLE_A2A"] === "true" },
    { label: "Node.js 依赖", ok: fs.existsSync(path.join(root, "node_modules")) },
    { label: "DASHSCOPE_API_KEY", ok: !!finalEnv["DASHSCOPE_API_KEY"], hint: "编辑 .env 填入 API Key" },
    { label: "DEEPSEEK_API_KEY", ok: !!finalEnv["DEEPSEEK_API_KEY"], hint: "编辑 .env 填入 API Key" },
    { label: "ZHIPU_API_KEY", ok: !!finalEnv["ZHIPU_API_KEY"], hint: "编辑 .env 填入 API Key" },
    { label: "MOONSHOT_API_KEY", ok: !!finalEnv["MOONSHOT_API_KEY"], hint: "编辑 .env 填入 API Key" },
    { label: "ARK_API_KEY", ok: !!finalEnv["ARK_API_KEY"], hint: "编辑 .env 填入 API Key（豆包/图片生成）" },
    { label: "Python 3.11+", ok: !!python },
    { label: "IM Gateway 依赖", ok: fs.existsSync(path.join(root, "services", "im-gateway", "requirements.txt")) },
    { label: "Video-Forge 依赖", ok: fs.existsSync(path.join(root, "services", "video-forge", "requirements.txt")) },
    { label: "KB-Parser 依赖", ok: fs.existsSync(path.join(root, "services", "kb-parser", "requirements.txt")) },
  ];

  console.log("配置检查：");
  for (const c of checks) {
    const icon = c.ok ? "  ✅" : "  ⬜";
    const hint = !c.ok && c.hint ? `  ← ${c.hint}` : "";
    console.log(`${icon} ${c.label}${hint}`);
  }

  console.log("\n下一步：");
  console.log("  1. 编辑 .env，填入至少一个 LLM Provider 的 API Key");
  console.log("  2. 运行 pnpm dev 启动全部服务");
  console.log("  3. 打开 http://localhost:3000\n");
}

main();
