/**
 * Media routes — 媒体上传、查询和下载端点
 *
 * GET  /api/media             — 列出所有媒体文件
 * POST /api/media/upload      — 上传媒体文件 (base64 方式)，返回 mediaId + 元信息
 * GET  /api/media/:id          — 查询已保存的媒体信息
 * GET  /api/media/:id/download — 下载媒体文件
 * DELETE /api/media/:id        — 删除媒体文件
 */

import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import {
  saveMediaBuffer,
  saveMediaFromUrl,
  getMediaById,
  initMediaStore,
  detectMime,
  kindFromMime,
  assertSizeAllowed,
  assertMimeAllowed,
  MEDIA_MAX_BYTES,
  resolveHome,
} from "@super-agent/core";

export async function mediaRoutes(app: FastifyInstance) {
  // 确保媒体存储目录存在
  await initMediaStore();

  // ─── 解析媒体存储根目录 ───
  const mediaRoot = path.join(resolveHome(), "media");

  /**
   * GET /api/media
   * 列出所有媒体文件（扫描 inbound + outbound 目录）
   */
  app.get("/api/media", async (request, reply) => {
    // 可选过滤参数：?kind=video 只返回视频文件，?kind=image 只返回图片
    const kind = (request.query as Record<string, string>).kind || "";
    const items: Array<{
      id: string;
      filename: string;
      mimeType: string;
      size: number;
      createdAt: string;
      path: string;
    }> = [];

    for (const subdir of ["inbound", "outbound"]) {
      const dir = path.join(mediaRoot, subdir);
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const filePath = path.join(dir, entry.name);
          try {
            const stat = await fs.stat(filePath);
            // UUID 是文件名去掉扩展名的部分
            const id = path.basename(entry.name, path.extname(entry.name));
            const contentType = await detectMime({ filePath });
            items.push({
              id,
              filename: entry.name,
              mimeType: contentType,
              size: stat.size,
              createdAt: stat.mtime.toISOString(),
              path: filePath,
            });
          } catch { /* 文件可能已被清理，忽略 */ }
        }
      } catch { /* 目录不存在，忽略 */ }
    }

    // 按创建时间倒序
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // 可选类型过滤：kind=video 只返回 video/*，kind=image 只返回 image/*，kind=audio 只返回 audio/*
    const filtered = kind
      ? items.filter((item) => item.mimeType.startsWith(`${kind}/`))
      : items;
    return reply.send({ items: filtered });
  });

  /**
   * POST /api/media/upload
   *
   * 支持两种上传方式:
   * 1. Base64: { filename, data (base64 string), mimeType? }
   * 2. URL:    { url, filename? }
   *
   * 返回: { id, path, contentType, size, kind, filename }
   */
  app.post<{
    Body: {
      filename?: string;
      data?: string;
      url?: string;
      mimeType?: string;
    };
  }>("/api/media/upload", {
    bodyLimit: 10 * 1024 * 1024, // 10MB (base64 膨胀)
  }, async (request, reply) => {
    const { filename, data, url, mimeType } = request.body ?? {};

    try {
      // 方式 1: URL 下载
      if (url) {
        const saved = await saveMediaFromUrl(url, "inbound");
        const kind = kindFromMime(saved.contentType);
        return reply.send({
          id: saved.id,
          path: saved.path,
          contentType: saved.contentType,
          size: saved.size,
          kind,
          filename: filename ?? path.basename(saved.path),
        });
      }

      // 方式 2: Base64 上传
      if (!data) {
        return reply.status(400).send({ error: "data (base64) 或 url 是必填的" });
      }

      // 去除可能的 data URI 前缀
      let raw = data;
      let dataMime: string | undefined;
      const dataUriMatch = raw.match(/^data:([^;]+);base64,/);
      if (dataUriMatch) {
        dataMime = dataUriMatch[1];
        raw = raw.slice(dataUriMatch[0].length);
      }

      const buffer = Buffer.from(raw, "base64");
      assertSizeAllowed(buffer.length, MEDIA_MAX_BYTES);

      const contentType = await detectMime({
        buffer,
        filePath: filename,
        declaredMime: mimeType ?? dataMime,
      });
      assertMimeAllowed(contentType);

      const saved = await saveMediaBuffer(buffer, contentType, "inbound", MEDIA_MAX_BYTES, filename);
      const kind = kindFromMime(contentType);

      return reply.send({
        id: saved.id,
        path: saved.path,
        contentType: saved.contentType,
        size: saved.size,
        kind,
        filename: filename ?? path.basename(saved.path),
      });
    } catch (err: any) {
      // API-P1-03：MediaSecurityError 为业务错误，消息受控可回显；其他（IO/依赖）仅日志，响应通用文案
      const isSecErr = err?.name === "MediaSecurityError";
      if (isSecErr) {
        app.log.warn({ err, code: err?.code }, "Media upload rejected by security check");
        return reply.status(400).send({
          error: "媒体上传失败，安全检测未通过",
          code: err.code,
        });
      }
      app.log.error({ err }, "Media upload failed");
      return reply.status(500).send({ error: "媒体上传失败" });
    }
  });

  /**
   * GET /api/media/:id
   * 查询已保存的媒体信息
   */
  app.get<{
    Params: { id: string };
  }>("/api/media/:id", async (request, reply) => {
    const { id } = request.params;
    const media = await getMediaById(id);

    if (!media) {
      return reply.status(404).send({ error: "媒体文件不存在或已过期" });
    }

    const kind = kindFromMime(media.contentType);
    return reply.send({
      id: media.id,
      path: media.path,
      contentType: media.contentType,
      size: media.size,
      kind,
      filename: path.basename(media.path),
    });
  });

  /**
   * GET /api/media/:id/download
   * 下载媒体文件
   */
  app.get<{
    Params: { id: string };
  }>("/api/media/:id/download", async (request, reply) => {
    const { id } = request.params;
    const media = await getMediaById(id);

    if (!media) {
      return reply.status(404).send({ error: "媒体文件不存在或已过期" });
    }

    try {
      const data = await fs.readFile(media.path);
      const filename = path.basename(media.path);

      return reply
        .header("Content-Type", media.contentType)
        .header("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`)
        .header("Content-Length", data.length)
        .send(data);
    } catch {
      return reply.status(404).send({ error: "媒体文件已被清理" });
    }
  });

  /**
   * DELETE /api/media/:id
   * 删除媒体文件
   */
  app.delete<{
    Params: { id: string };
  }>("/api/media/:id", async (request, reply) => {
    const { id } = request.params;
    const media = await getMediaById(id);

    if (!media) {
      return reply.status(404).send({ error: "媒体文件不存在" });
    }

    try {
      await fs.unlink(media.path);
      return reply.send({ deleted: true, id });
    } catch {
      return reply.status(500).send({ error: "删除失败" });
    }
  });
}
