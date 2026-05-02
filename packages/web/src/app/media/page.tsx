"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch, downloadAuthorized } from "@/lib/utils";
import {
  Image as ImageIcon, Upload, Download, Trash2, RefreshCw,
  Search, FileText, Film, Music, File, Loader2, X,
} from "lucide-react";

interface MediaItem {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  path?: string;
}

const mimeIcon = (mime: string) => {
  if (mime.startsWith("image/")) return ImageIcon;
  if (mime.startsWith("video/")) return Film;
  if (mime.startsWith("audio/")) return Music;
  if (mime.includes("pdf") || mime.includes("text")) return FileText;
  return File;
};

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export default function MediaPage() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [uploadUrl, setUploadUrl] = useState("");

  const fetchMedia = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ items: MediaItem[] }>("/api/media");
      setItems(data.items ?? []);
    } catch {
      setItems([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchMedia(); }, [fetchMedia]);

  const handleUploadUrl = async () => {
    if (!uploadUrl.trim()) return;
    setUploading(true);
    setUploadError("");
    try {
      await apiFetch("/api/media/upload", {
        method: "POST",
        body: JSON.stringify({ url: uploadUrl }),
      });
      setUploadUrl("");
      setShowUpload(false);
      fetchMedia();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "URL 导入失败，请检查地址是否可访问");
    }
    setUploading(false);
  };

  const handleUploadFile = async (file: File) => {
    setUploading(true);
    setUploadError("");
    const reader = new FileReader();
    reader.onload = async () => {
      const data = (reader.result as string).split(",")[1];
      try {
        await apiFetch("/api/media/upload", {
          method: "POST",
          body: JSON.stringify({
            data,
            filename: file.name,
            mimeType: file.type,
          }),
        });
        setShowUpload(false);
        fetchMedia();
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "文件上传失败");
      }
      setUploading(false);
    };
    reader.readAsDataURL(file);
  };

  const handleDownload = async (id: string, filename: string) => {
    // [WEB-P1-01] 走 fetch+blob 下载，保证携带 Authorization 头
    try {
      await downloadAuthorized(`/api/media/${id}/download`, filename);
    } catch {
      /* showToast 已在 downloadAuthorized 内部触发 */
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除该文件？")) return;
    await apiFetch(`/api/media/${id}`, { method: "DELETE" });
    fetchMedia();
  };

  const filtered = search.trim()
    ? items.filter((m) => m.filename.toLowerCase().includes(search.toLowerCase()))
    : items;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">媒体管理</h1>
          <p className="mt-1 text-zinc-400">上传、浏览和下载媒体文件</p>
        </div>
        <div className="flex gap-2">
          <button onClick={fetchMedia} className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
            <RefreshCw className="h-4 w-4" /> 刷新
          </button>
          <button onClick={() => setShowUpload(true)} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            <Upload className="h-4 w-4" /> 上传文件
          </button>
        </div>
      </div>

      {/* 统计 */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-sm text-zinc-400">文件总数</p>
          <p className="text-2xl font-bold text-white">{items.length}</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-sm text-zinc-400">总大小</p>
          <p className="text-2xl font-bold text-white">{formatSize(items.reduce((sum, m) => sum + (m.size || 0), 0))}</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-sm text-zinc-400">文件类型</p>
          <p className="text-2xl font-bold text-white">{new Set(items.map((m) => m.mimeType.split("/")[0])).size}</p>
        </div>
      </div>

      {/* 搜索 */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索文件名..."
          className="w-full rounded-xl border border-zinc-800 bg-zinc-900 py-3 pl-10 pr-4 text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
        />
      </div>

      {/* 文件列表 */}
      {loading ? (
        <div className="py-12 text-center text-zinc-500">加载中...</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 p-12 text-center">
          <ImageIcon className="mx-auto h-12 w-12 text-zinc-600" />
          <p className="mt-4 text-zinc-400">{search ? "未找到匹配文件" : "暂无媒体文件"}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((item) => {
            const Icon = mimeIcon(item.mimeType);
            return (
              <div key={item.id} className="group flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="flex items-center gap-4 min-w-0">
                  <Icon className="h-8 w-8 shrink-0 text-blue-400" />
                  <div className="min-w-0">
                    <h4 className="font-medium text-white truncate">{item.filename}</h4>
                    <div className="flex items-center gap-3 text-xs text-zinc-500">
                      <span>{item.mimeType}</span>
                      <span>{formatSize(item.size)}</span>
                      <span>{new Date(item.createdAt).toLocaleString("zh-CN")}</span>
                    </div>
                  </div>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100">
                  <button onClick={() => handleDownload(item.id, item.filename)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-blue-400" title="下载">
                    <Download className="h-4 w-4" />
                  </button>
                  <button onClick={() => handleDelete(item.id)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-red-400" title="删除">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 上传模态 */}
      {showUpload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowUpload(false)}>
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-white">上传文件</h3>
              <button onClick={() => { setShowUpload(false); setUploadError(""); }} className="text-zinc-400 hover:text-white"><X className="h-5 w-5" /></button>
            </div>
            {uploadError && (
              <div className="mb-4 rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-400">
                {uploadError}
              </div>
            )}
            <div className="space-y-4">
              {/* 本地文件上传 */}
              <div>
                <label className="block text-sm text-zinc-400 mb-2">选择本地文件</label>
                <input
                  type="file"
                  onChange={(e) => { if (e.target.files?.[0]) handleUploadFile(e.target.files[0]); }}
                  className="w-full text-sm text-zinc-400 file:mr-4 file:rounded-lg file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-blue-700"
                />
              </div>
              <div className="relative flex items-center gap-3">
                <div className="flex-1 border-t border-zinc-800"></div>
                <span className="text-xs text-zinc-500">或</span>
                <div className="flex-1 border-t border-zinc-800"></div>
              </div>
              {/* URL 上传 */}
              <div>
                <label className="block text-sm text-zinc-400 mb-2">从 URL 导入</label>
                <div className="flex gap-2">
                  <input
                    value={uploadUrl}
                    onChange={(e) => setUploadUrl(e.target.value)}
                    placeholder="https://example.com/image.png"
                    className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                  />
                  <button
                    onClick={handleUploadUrl}
                    disabled={uploading || !uploadUrl.trim()}
                    className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    导入
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
