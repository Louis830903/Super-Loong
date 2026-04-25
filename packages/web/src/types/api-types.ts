/**
 * 前端 API 类型门面文件 —— CTR-P1-01 单一真源收敛后保留的向后兼容层。
 *
 * 架构变更：
 *   - 真源已迁至 @super-agent/web-types/src/api-types.ts（前后端共享纯类型包）
 *   - 此文件仅做 re-export，所有历史 import "@/types/api-types" 路径零改动兼容
 *   - 新代码推荐直接 import from "@super-agent/web-types"，统一数据源
 *
 * 未来 Step 2（独立 Spec）：core 侧增加 serialize*() 领域→wire 转换函数 + 契约测试，
 *   彻底消除"core domain type vs web wire type"的字段漂移风险。
 */
export * from "@super-agent/web-types";
