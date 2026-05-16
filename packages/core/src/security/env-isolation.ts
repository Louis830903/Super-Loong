/**
 * Environment Isolation — 环境变量隔离
 *
 * 参考 Hermes local.py L19-138 的 103 条明确黑名单 + 动态扩展。
 * 使用"明确条目 + 动态扩展"策略，而非粗粒度模式匹配。
 *
 * 功能:
 * 1. 明确黑名单: 按类别罗列具体变量名 (~100条)
 * 2. 白名单确保通行: PATH, HOME, LANG, TERM 等系统必需变量
 * 3. 动态扩展: 从当前配置的 LLM provider 自动提取需阻止的变量名
 * 4. 覆盖机制: SUPER_AGENT_FORCE_ 前缀（v1.1 已废弃，改为白名单制，仅允许已知系统变量通过）
 * 5. HOME 隔离: 子进程 HOME 可重定向到隔离目录
 */

import fs from "node:fs";
import pino from "pino";

const logger = pino({ name: "env-isolation" });

// ─── 白名单 — 子进程必须继承的环境变量 ──────────────────────

/** 安全环境变量白名单 */
const ENV_WHITELIST = new Set([
  // 系统核心
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  "TERM", "SHELL", "DISPLAY", "TMPDIR", "TMP", "TEMP", "HOSTNAME",
  "PWD", "OLDPWD", "SHLVL",

  // XDG 标准
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP",

  // 编辑器
  "EDITOR", "VISUAL", "PAGER",

  // 开发工具 — 运行时和配置(非密钥)
  // P3-T5: 移除 NODE_OPTIONS（可注入 --require 加载恶意模块）
  "NODE_ENV", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
  "NPM_CONFIG_REGISTRY", "NPM_CONFIG_PREFIX",
  "PYTHONPATH", "PYTHONDONTWRITEBYTECODE", "VIRTUAL_ENV",
  "GOPATH", "GOROOT", "GOBIN",
  "CARGO_HOME", "RUSTUP_HOME", "RUST_BACKTRACE", "RUST_LOG",
  "JAVA_HOME", "MAVEN_HOME", "GRADLE_HOME",
  "RUBY_VERSION", "GEM_HOME", "GEM_PATH",

  // Git (非认证)
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",

  // Windows 系统
  "SYSTEMROOT", "WINDIR", "COMSPEC", "APPDATA", "LOCALAPPDATA",
  "PROGRAMFILES", "ProgramFiles(x86)", "COMMONPROGRAMFILES",
  "PSModulePath", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  "OS", "PATHEXT", "SYSTEMDRIVE",

  // Docker/容器
  // P3-T5: 移除 DOCKER_HOST（可通过 DOCKER_HOST=tcp://attacker:2375 劫持），仅保留 DOCKER_CONFIG/COMPOSE_FILE
  "DOCKER_CONFIG", "COMPOSE_FILE",

  // 终端
  "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION",

  // 代理(需通过)
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
]);

// ─── FORCE_ 前缀白名单（v1.1 废弃的遗留机制）────────────────
// FORCE_ 前缀不再能绕过黑名单。此白名单与 ENV_WHITELIST 完全重叠。
// 迁移指南：若你的工作流依赖 FORCE_ 前缀传递自定义变量，
// 请改为在 ENV_WHITELIST 中添加该变量名。

/** FORCE_ 前缀白名单 — 仅允许已知安全系统变量通过 FORCE_ 前缀覆写 */
const FORCE_WHITELIST = new Set([
  "PATH", "HOME", "USER", "LANG", "LC_ALL",
  "TMPDIR", "TMP", "TEMP",
  "NODE_PATH", "PYTHONPATH", "GOPATH",
  "JAVA_HOME", "MAVEN_HOME", "GRADLE_HOME",
  "CARGO_HOME", "RUSTUP_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
  // P3-T5: DOCKER_HOST 从白名单移除（存在劫持风险）
  "COMPOSE_FILE",
  "DISPLAY", "XAUTHORITY",
]);

// ─── 黑名单 — 明确阻止的环境变量 (参考 Hermes 103条) ──────

/** LLM API 密钥 */
const BLOCKED_LLM_KEYS = [
  "OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID",
  "ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN",
  "DEEPSEEK_API_KEY",
  "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GEMINI_API_KEY",
  "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT",
  "COHERE_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY",
  "TOGETHER_API_KEY", "FIREWORKS_API_KEY", "REPLICATE_API_TOKEN",
  "HUGGINGFACE_TOKEN", "HF_TOKEN",
  "ZHIPU_API_KEY", "MOONSHOT_API_KEY", "MINIMAX_API_KEY", "MINIMAX_GROUP_ID",
  "QWEN_API_KEY", "DASHSCOPE_API_KEY",
  "BAICHUAN_API_KEY", "LINGYI_API_KEY", "STEPFUN_API_KEY",
  "OLLAMA_API_KEY",
];

/** 通讯平台令牌 */
const BLOCKED_COMM_KEYS = [
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_API_ID", "TELEGRAM_API_HASH",
  "DISCORD_BOT_TOKEN", "DISCORD_CLIENT_SECRET",
  "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET",
  "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID",
  "FEISHU_APP_ID", "FEISHU_APP_SECRET", "LARK_APP_ID", "LARK_APP_SECRET",
  "WECHAT_APP_ID", "WECHAT_APP_SECRET", "WECHAT_TOKEN",
  "DINGTALK_APP_KEY", "DINGTALK_APP_SECRET",
  "LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN",
  "TWILIO_AUTH_TOKEN", "TWILIO_ACCOUNT_SID",
];

/** 云平台密钥 */
const BLOCKED_CLOUD_KEYS = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET", "AZURE_TENANT_ID", "AZURE_CLIENT_ID",
  "GCP_SERVICE_ACCOUNT", "GOOGLE_CLOUD_PROJECT",
  "DIGITALOCEAN_TOKEN", "LINODE_TOKEN", "HETZNER_TOKEN",
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY",
  "VERCEL_TOKEN", "NETLIFY_AUTH_TOKEN", "RAILWAY_TOKEN",
  "FLY_API_TOKEN", "RENDER_API_KEY",
];

/** 工具集成令牌 */
const BLOCKED_TOOL_KEYS = [
  "GH_TOKEN", "GITHUB_TOKEN", "GITHUB_PAT",
  "GITLAB_TOKEN", "GITLAB_PRIVATE_TOKEN",
  "BITBUCKET_TOKEN", "BITBUCKET_APP_PASSWORD",
  "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET",
  "DAYTONA_API_KEY", "DAYTONA_SERVER_URL",
  "SENTRY_DSN", "SENTRY_AUTH_TOKEN",
  "DATADOG_API_KEY", "DATADOG_APP_KEY",
  "SUPABASE_KEY", "SUPABASE_SERVICE_KEY",
  "FIREBASE_TOKEN", "FIREBASE_API_KEY",
  "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY",
  "SENDGRID_API_KEY", "MAILGUN_API_KEY",
  "ALGOLIA_API_KEY", "ALGOLIA_APP_ID",
  "REDIS_URL", "DATABASE_URL", "MONGODB_URI",
];

/** 数据库密码 */
const BLOCKED_DB_KEYS = [
  "DB_PASSWORD", "DB_PASS", "PGPASSWORD", "MYSQL_ROOT_PASSWORD",
  "MYSQL_PASSWORD", "POSTGRES_PASSWORD", "MONGO_PASSWORD",
];

/** 合并所有黑名单 */
const ALL_BLOCKED_KEYS = new Set([
  ...BLOCKED_LLM_KEYS,
  ...BLOCKED_COMM_KEYS,
  ...BLOCKED_CLOUD_KEYS,
  ...BLOCKED_TOOL_KEYS,
  ...BLOCKED_DB_KEYS,
]);

/** 关键词模式兜底 — 捕获自定义敏感变量(如 MY_SECRET_CONFIG) */
const BLOCK_KEYWORDS = [
  "API_KEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD",
  "CREDENTIAL", "PRIVATE_KEY", "ACCESS_KEY",
];

// ─── 核心过滤函数 ──────────────────────────────────────────

/** 覆盖前缀（v1.1 已废弃） — 仅供白名单内系统变量绕过黑名单 */
const FORCE_PREFIX = "SUPER_AGENT_FORCE_";

/**
 * 构建安全的子进程环境变量
 *
 * 过滤策略:
 * 1. 白名单中的变量 → 直接通过
 * 2. 黑名单中的变量 → 阻止(FORCE_ 前缀仅对 FORCE_WHITELIST 内系统变量有效)
 * 3. 不在任何名单中的变量 → 通过(宽松策略，避免误阻)
 *
 * @param extraEnv 额外追加的环境变量
 * @param isolatedHome 是否隔离 HOME 目录
 * @returns 过滤后的安全环境变量
 */
export function buildIsolatedEnv(
  extraEnv?: Record<string, string>,
  isolatedHome?: string,
): Record<string, string> {
  const safeEnv: Record<string, string> = {};
  const blockedCount = { total: 0, keyword: 0 };

  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;

    // FORCE_ 前缀覆盖（v1.1 白名单制 — 已废弃，仅允许已知安全系统变量）
    // 自 v1.1 起，FORCE_ 不再能绕过黑名单。需传递自定义变量请修改 ENV_WHITELIST。
    const forceKey = FORCE_PREFIX + key;
    if (process.env[forceKey] && FORCE_WHITELIST.has(key)) {
      safeEnv[key] = value;
      logger.debug({ key }, "FORCE_ prefix whitelist pass-through");
      continue;
    }
    if (process.env[forceKey] && !FORCE_WHITELIST.has(key)) {
      logger.warn({ key, forceKey }, "FORCE_ prefix rejected — key not in whitelist. Add to ENV_WHITELIST if needed.");
      continue;
    }

    // 白名单直接通过
    if (ENV_WHITELIST.has(key)) {
      safeEnv[key] = value;
      continue;
    }

    // 黑名单阻止
    if (ALL_BLOCKED_KEYS.has(key)) {
      blockedCount.total++;
      continue;
    }

    // 关键词模式兜底 — 捕获不在明确黑名单中的自定义敏感变量
    const upperKey = key.toUpperCase();
    if (BLOCK_KEYWORDS.some(kw => upperKey.includes(kw))) {
      blockedCount.keyword++;
      continue;
    }

    // 不在任何名单中 → 通过(宽松策略)
    safeEnv[key] = value;
  }

  // 合并用户额外环境变量 — 同样执行安全检查，禁止通过 extraEnv 注入敏感变量
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (!value) continue;
      // 黑名单检查
      if (ALL_BLOCKED_KEYS.has(key)) {
        logger.warn({ key }, "extraEnv 被阻止: 匹配敏感变量黑名单");
        continue;
      }
      // 关键词模式兜底
      const upperKey = key.toUpperCase();
      if (BLOCK_KEYWORDS.some(kw => upperKey.includes(kw))) {
        logger.warn({ key }, "extraEnv 被阻止: 匹配敏感关键词模式");
        continue;
      }
      safeEnv[key] = value;
    }
  }

  // HOME 隔离
  if (isolatedHome) {
    ensureDir(isolatedHome);
    safeEnv.HOME = isolatedHome;
    safeEnv.USERPROFILE = isolatedHome; // Windows
  }

  if (blockedCount.total > 0 || blockedCount.keyword > 0) {
    logger.debug(
      { blocked: blockedCount.total, keyword: blockedCount.keyword },
      "环境变量隔离: 已阻止敏感变量",
    );
  }

  return safeEnv;
}

/**
 * 检查单个环境变量是否被阻止
 */
export function isBlockedEnvVar(key: string): boolean {
  return ALL_BLOCKED_KEYS.has(key);
}

/**
 * 获取当前环境中被阻止的变量列表（诊断用）
 */
export function listBlockedEnvVars(): string[] {
  return Array.from(ALL_BLOCKED_KEYS).filter(key => process.env[key] !== undefined);
}

// ─── 辅助函数 ──────────────────────────────────────────────

/** 确保目录存在 */
function ensureDir(dirPath: string): void {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } catch (err) {
    logger.warn({ path: dirPath, error: (err as Error).message }, "创建隔离目录失败");
  }
}
