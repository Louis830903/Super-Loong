/**
 * Media routes — 媒体上传、查询和下载端点
 *
 * POST /api/media/upload   — 上传媒体文件 (base64 方式)，返回 mediaId + 元信息
 * GET  /api/media/:id      — 查询已保存的媒体信息
 * GET  /api/media/:id/download — 下载媒体文件
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
} from "@super-agent/core";

export async function mediaRoutes(app: FastifyInstance) {
  // 确保媒体存储目录存在
  await initMediaStore();

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
      const status = err.name === "MediaSecurityError" ? 400 : 500;
      return reply.status(status).send({
        error: err.message ?? "媒体上传失败",
        code: err.code,
      });
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
}
