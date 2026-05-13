/**
 * pdf-parse 模块类型声明。
 *
 * pdf-parse 是一个纯 JS 包，未提供内置类型定义。
 * 此处为其核心导出提供最小类型声明，确保 TypeScript 编译通过。
 */
declare module "pdf-parse" {
  interface PDFParseResult {
    /** 提取的纯文本内容 */
    text: string;
    /** 总页数 */
    numpages: number;
    /** PDF 元数据 */
    metadata: Record<string, unknown>;
    /** PDF 版本 */
    version: string;
  }

  function pdfParse(
    dataBuffer: Buffer | Uint8Array,
    options?: {
      /** 起始页（1-based） */
      pagerender?: (pageData: unknown) => string;
      /** 最大解析页数 */
      max?: number;
    }
  ): Promise<PDFParseResult>;

  export default pdfParse;
}
