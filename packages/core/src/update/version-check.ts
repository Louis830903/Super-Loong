/**
 * 内置版本检查模块 — GitHub/Gitee 双源回退查询最新版本。
 *
 * 设计原则：
 * - 纯函数、无副作用，由调用方决定何时调用和如何处理结果
 * - 优先 GitHub API，失败时自动回退到 Gitee（国内用户更稳定）
 * - 均未认证调用有速率限制，失败时静默降级（不阻塞启动）
 * - 通过 SUPER_AGENT_NO_VERSION_CHECK=true 可完全关闭
 * - 兼容 Docker / 离线 / 企业内网等无法访问外网的环境
 */

import pino from "pino";

const logger = pino({ name: "version-check" });

/** 版本检查结果 */
export interface VersionCheckResult {
  /** 当前运行版本 */
  current: string;
  /** 远端最新版本（查询失败时为 null） */
  latest: string | null;
  /** 是否有更新可用 */
  outdated: boolean;
  /** Release 页面 URL（供用户手动下载） */
  releaseUrl: string | null;
  /** 查询是否成功（false 表示网络/API 错误，不是版本问题） */
  success: boolean;
  /** 数据来源：github / gitee / null（查询失败） */
  source: "github" | "gitee" | null;
}

/** GitHub 仓库信息 */
const GH_OWNER = "Louis830903";
const GH_REPO = "Super-Loong";

/** GitHub API */
const GITHUB_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`;
const GITHUB_PAGE = `https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest`;

/** Gitee 仓库信息（国内镜像备份，账号/仓库名可能与 GitHub 不同） */
const GITEE_OWNER = "lv--dapang";
const GITEE_REPO = "super-loong";

/** Gitee API（GitHub 不可达时回退） */
const GITEE_API = `https://gitee.com/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/latest`;
const GITEE_PAGE = `https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/releases/latest`;

/**
 * 获取当前版本号。
 * 优先从运行时环境变量 SUPER_AGENT_VERSION 读取（Docker / CI 覆盖），
 * 否则回退到编译期硬编码版本（与 package.json 保持同步）。
 */
export function getCurrentVersion(): string {
  return process.env.SUPER_AGENT_VERSION ?? "0.1.0";
}

/**
 * 查询 GitHub Releases 是否有新版本。
 *
 * @param currentVersion  当前版本号（可选，默认取 getCurrentVersion()）
 * @param timeoutMs       API 请求超时（默认 5000ms）
 * @returns VersionCheckResult
 */
export async function checkForUpdates(
  currentVersion?: string,
  timeoutMs = 5000,
): Promise<VersionCheckResult> {
  const current = currentVersion ?? getCurrentVersion();
  const baseResult: VersionCheckResult = {
    current,
    latest: null,
    outdated: false,
    releaseUrl: null,
    success: false,
    source: null,
  };

  // 通过环境变量关闭版本检查
  if (process.env.SUPER_AGENT_NO_VERSION_CHECK === "true") {
    return baseResult;
  }

  // 优先 GitHub，失败回退 Gitee
  const ghResult = await fetchRelease(GITHUB_API, "github", timeoutMs);
  if (ghResult) {
    const latestTag = ghResult.tag_name?.replace(/^v/, "") ?? null;
    if (latestTag) {
      return {
        current,
        latest: latestTag,
        outdated: compareVersions(latestTag, current) > 0,
        releaseUrl: ghResult.html_url ?? GITHUB_PAGE,
        success: true,
        source: "github",
      };
    }
  }

  // GitHub 失败 → 回退 Gitee
  logger.debug("GitHub unreachable, falling back to Gitee");
  const giteeResult = await fetchRelease(GITEE_API, "gitee", timeoutMs);
  if (giteeResult) {
    const latestTag = giteeResult.tag_name?.replace(/^v/, "") ?? null;
    if (latestTag) {
      return {
        current,
        latest: latestTag,
        outdated: compareVersions(latestTag, current) > 0,
        releaseUrl: giteeResult.html_url ?? GITEE_PAGE,
        success: true,
        source: "gitee",
      };
    }
  }

  // 双源均失败 — 静默降级
  return baseResult;
}

/**
 * 从指定 API 获取最新 Release。
 * @returns 成功时返回 Release 数据，失败/超时返回 null
 */
async function fetchRelease(
  apiUrl: string,
  source: string,
  timeoutMs: number,
): Promise<{ tag_name?: string; html_url?: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(apiUrl, {
      headers: {
        "Accept": source === "github"
          ? "application/vnd.github+json"
          : "application/json",
        "User-Agent": "Super-Agent-Version-Check",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      if (response.status !== 403 && response.status !== 404) {
        logger.debug({ source, status: response.status }, "Release API returned non-200");
      }
      return null;
    }

    return await response.json() as { tag_name?: string; html_url?: string };
  } catch (err: unknown) {
    const msg = (err as { message?: string }).message ?? String(err);
    logger.debug({ source, err: msg }, "Release fetch failed (non-fatal)");
    return null;
  }
}

/**
 * 比较两个 semver 版本号。
 * @returns >0 表示 a > b，<0 表示 a < b，0 表示相等
 */
function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** 解析 "1.2.3" 为 [1, 2, 3]，解析失败返回 [0, 0, 0] */
function parseSemver(v: string): [number, number, number] {
  const parts = v.replace(/^v/, "").split(".").map(Number);
  return [
    isNaN(parts[0]!) ? 0 : parts[0]!,
    isNaN(parts[1]!) ? 0 : parts[1]!,
    isNaN(parts[2]!) ? 0 : parts[2]!,
  ];
}
