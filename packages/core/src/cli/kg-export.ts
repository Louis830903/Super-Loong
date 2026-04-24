/**
 * T6.6 — CLI 子图导出命令
 *
 * 用法：
 *   npx tsx packages/core/src/cli/kg-export.ts <entityId> [--depth 2] [--format json|mermaid|graphml]
 *
 * 示例：
 *   npx tsx packages/core/src/cli/kg-export.ts 1 --depth 3 --format mermaid
 *   npx tsx packages/core/src/cli/kg-export.ts 42 --format graphml
 *
 * 输出可直接喂给 mermaid 渲染器，便于人工排查记忆质量。
 */

import { initDatabase } from "../persistence/sqlite.js";
import { KnowledgeGraph } from "../memory/knowledge-graph.js";
import type { ExportFormat } from "../memory/knowledge-graph.js";

// ═══════════════════════════════════════════════════════════════
// 参数解析
// ═══════════════════════════════════════════════════════════════

interface KgExportArgs {
  entityId: number;
  depth: number;
  format: ExportFormat;
}

function parseArgs(): KgExportArgs {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
用法：npx tsx packages/core/src/cli/kg-export.ts <entityId> [选项]

参数：
  entityId           实体 ID（整数）

选项：
  --depth <n>        子图遍历深度（默认 2）
  --format <fmt>     输出格式：json | mermaid | graphml（默认 json）
  --db <path>        数据库文件路径（默认使用 SA_DB_PATH 环境变量或内置路径）
  --help, -h         显示帮助信息
`);
    process.exit(0);
  }

  // 第一个非 flag 参数为 entityId
  const entityIdStr = args.find((a) => !a.startsWith("--"));
  if (!entityIdStr || isNaN(Number(entityIdStr))) {
    console.error("错误：请提供有效的 entityId（整数）");
    process.exit(1);
  }

  let depth = 2;
  let format: ExportFormat = "json";
  let dbPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--depth" && args[i + 1]) {
      depth = parseInt(args[i + 1], 10);
      if (isNaN(depth) || depth < 1) {
        console.error("错误：--depth 必须是正整数");
        process.exit(1);
      }
      i++;
    } else if (args[i] === "--format" && args[i + 1]) {
      const f = args[i + 1].toLowerCase();
      if (!["json", "mermaid", "graphml"].includes(f)) {
        console.error("错误：--format 必须是 json、mermaid 或 graphml");
        process.exit(1);
      }
      format = f as ExportFormat;
      i++;
    } else if (args[i] === "--db" && args[i + 1]) {
      dbPath = args[i + 1];
      i++;
    }
  }

  return { entityId: Number(entityIdStr), depth, format };
}

// ═══════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = parseArgs();

  // 初始化数据库
  const dbPath = process.argv.find((_, i) => process.argv[i - 1] === "--db");
  await initDatabase(dbPath);

  const kg = new KnowledgeGraph();

  // 检查三元组总数
  const totalTriples = kg.countTriples();
  console.error(`[kg-export] 数据库共 ${totalTriples} 条三元组`);

  // 导出子图
  const output = kg.exportSubgraph(args.entityId, args.depth, args.format);

  // 输出到 stdout（便于管道操作）
  console.log(output);

  console.error(
    `[kg-export] 完成：entityId=${args.entityId}, depth=${args.depth}, format=${args.format}`,
  );
}

main().catch((err) => {
  console.error("kg-export 执行失败:", err);
  process.exit(1);
});
