/**
 * 知识库解析器统一类型定义（知识库 Spec §5.2 / T2）。
 *
 * 设计原则：
 *   1. 所有 parser 接受 Buffer 输入（Web 上传可能尚未落盘）
 *   2. 统一输出 ParseResult —— 方便下游 chunker 按 pageBreaks 优先切分章节
 *   3. metadata 开放扩展，但保留通用字段（pageCount/sheetNames/frontmatter/warnings）
 *   4. 图片/扫描件类不在本批次实现，由 parser 抛 PARSE_NEEDS_OCR，T7 Docling sidecar 接管
 */

/**
 * 解析器统一输入。
 *
 * - buffer：文件原始二进制内容（必填）
 * - filename：文件名（用于扩展名分发 + 错误信息）
 * - mime：MIME 类型（可选，优先级高于 filename 扩展名）
 */
export interface ParserInput {
  buffer: Buffer;
  filename?: string;
  mime?: string;
}

/**
 * 解析器统一输出。
 *
 * - text：提取出的纯文本（UTF-8，已去 BOM）
 * - pageBreaks：text 内的字符 offset 列表，指示"换页/换 sheet/换 slide"的边界
 *   便于 T3 chunker 优先按章节切分，而不是硬切字符
 *   例：[0, 1234, 4567] 表示 0-1233 是第一页，1234-4566 是第二页，...
 *   约定：offset=0 可省略，下游自动补；若格式不支持页概念（如纯文本），不返回此字段
 * - metadata：元数据
 *   - pageCount：页数/sheet 数/slide 数（若适用）
 *   - sheetNames：XLSX 工作表名列表
 *   - frontmatter：MD 文档的 YAML frontmatter（gray-matter 解析结果）
 *   - warnings：非致命警告（如 DOCX 的样式丢失提示）
 *   - 其他格式特有字段
 */
export interface ParseResult {
  text: string;
  pageBreaks?: number[];
  metadata: ParseMetadata;
}

export interface ParseMetadata {
  pageCount?: number;
  sheetNames?: string[];
  frontmatter?: Record<string, unknown>;
  warnings?: string[];
  [key: string]: unknown;
}

/**
 * 已知的错误码（parser 抛出时使用 Error(code)）。
 *
 * - PARSE_UNSUPPORTED：格式不支持（本批次之外的格式，如 epub）
 * - PARSE_OPTIONAL_DEP_MISSING：可选依赖未安装（如 mammoth/jszip）
 * - PARSE_NEEDS_OCR：需要 OCR（图片/扫描件 PDF），由 T7 Docling 接管
 * - PARSE_EMPTY：解析成功但未抽出任何文本（空文件 / 纯图 PDF / 受保护的 DOCX 等）
 * - PARSE_FAILED：其他解析失败
 */
export type ParserErrorCode =
  | "PARSE_UNSUPPORTED"
  | "PARSE_OPTIONAL_DEP_MISSING"
  | "PARSE_NEEDS_OCR"
  | "PARSE_EMPTY"
  | "PARSE_FAILED";

/**
 * 从 filename/mime 推断文件格式标识。
 * 返回值与 parser 分发器使用的 key 对应（见 index.ts）。
 */
export type ParserFormat = "text" | "markdown" | "html" | "pdf" | "docx" | "xlsx" | "pptx";
