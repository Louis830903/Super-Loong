/**
 * POST /api/update/install — 一键自动更新安装端点。
 *
 * 调用 core 的 installUpdate() 下载便携包、解压、校验、生成引导脚本并触发重启。
 * 安装完成后 API 进程退出，由引导脚本负责替换文件并重启服务。
 */

import type { FastifyInstance } from "fastify";
import { checkForUpdates, installUpdate, detectRunMode } from "@super-agent/core";
import { sendSuccess, Errors } from "./response-helper.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 确定应用安装根目录（便携包运行时即当前工作目录，monorepo 时为根目录） */
function detectAppDir(): string {
  // 便携包部署：cwd 就是 super-agent/ 目录
  // monorepo 开发：cwd 是项目根
  const cwd = process.cwd();
  // 如果 cwd 下存在 api/index.js，说明是便携包部署模式
  return cwd;
}

export function updateRoutes(app: FastifyInstance): void {
  app.post("/api/update/install", async (_request, reply) => {
    // 1. 获取最新版本信息
    const result = await checkForUpdates(undefined, 5000);

    if (!result.success) {
      return Errors.badRequest(reply, "无法检查更新，请稍后重试");
    }

    if (!result.outdated || !result.latest) {
      return sendSuccess(reply, { message: "Already up to date", current: result.current });
    }

    if (!result.downloadUrl) {
      return Errors.badRequest(reply, "Download URL not available", {
        message: "请前往 Release 页面手动下载",
        releaseUrl: result.releaseUrl,
      });
    }

    const appDir = detectAppDir();
    app.log.info(
      { current: result.current, latest: result.latest, source: result.source },
      "Starting auto-update installation"
    );

    // 2. 执行安装
    const installResult = await installUpdate(
      result.downloadUrl,
      result.latest,
      appDir,
    );

    if (!installResult.success) {
      app.log.error({ error: installResult.error }, "Update installation failed");
      return Errors.internal(reply, installResult.error ?? "Installation failed", { stage: installResult.stage });
    }

    // 3. 返回成功，API 随后退出
    sendSuccess(reply, {
      status: "installing",
      version: result.latest,
      message: "Update started, service will restart",
    });

    // 4. 退出 API 进程，释放端口
    // 延迟 100ms 确保 HTTP 响应已发送
    setTimeout(() => {
      app.log.info("API exiting for update restart");
      process.exit(0);
    }, 100);
  });
}
