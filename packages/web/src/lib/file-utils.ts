"use client";

/**
 * 文件处理工具函数（从 chat/page.tsx 提取）。
 * P3-17: 减少页面组件中的工具函数，独立复用。
 */

/** 可直接读取文本内容发送给 LLM 的文件扩展名 */
export const TEXT_EXTENSIONS = new Set([
  ".txt", ".csv", ".json", ".md", ".py", ".js", ".ts", ".tsx", ".jsx",
  ".html", ".css", ".xml", ".yaml", ".yml", ".log", ".sh", ".bat",
  ".sql", ".env", ".ini", ".conf", ".toml", ".cfg", ".properties",
]);

/** 服务端可解析的二进制文件类型（PDF/DOCX/XLSX） */
export const PARSEABLE_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".xls", ".pptx"]);

/** 判断是否为文本文件 */
export function isTextFile(file: File): boolean {
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || file.type.startsWith("text/");
}

/** 判断是否为服务端可解析的二进制文件 */
export function isParseableFile(file: File): boolean {
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  return PARSEABLE_EXTENSIONS.has(ext);
}

/** 以文本方式读取文件内容 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** 以 Base64 方式读取文件内容（用于图片/二进制文件） */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // 去掉 data URL 前缀 (e.g. "data:application/pdf;base64,")
      const base64 = result.split(",")[1] || result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
