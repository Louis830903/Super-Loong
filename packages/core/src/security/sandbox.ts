/**
 * Security Engine — sandbox isolation, token proxy, and credential management.
 *
 * @why v3 Task 9 上帝文件拆分（原 981 行 5 类 1 文件 → 6 文件）
 *
 * 本文件保留作为 barrel 出口，把内部模块的全部公开符号 re-export，
 * 使 `import { ... } from "./security/sandbox.js"` 这样的外部消费者
 * （包括 core/src/index.ts 第 393-411 行的整批 re-export）无需修改。
 *
 * 防御纵深三层架构：
 *
 * 1. **Sandbox Isolation**（按风险分级）:
 *    - NONE: 无沙箱（受信代码、只读操作）
 *    - PROCESS: Node.js child_process + node:vm 双层隔离
 *    - CONTAINER: Docker 容器（可选后端）
 *    - 每个工具可声明所需沙箱级别
 *
 * 2. **Token Proxy**（"模型永远看不到明文凭据"）:
 *    - 凭据加密存储在 vault（AES-256-CBC）
 *    - Agent 拿到的是 `{{secret:OPENAI_KEY}}` 占位符
 *    - 工具执行时由 TokenProxy 即时解引用
 *    - 审计日志追踪每次凭据访问
 *
 * 3. **Permission System**:
 *    - 工具级权限（agent 能用哪些工具）
 *    - 资源级权限（文件路径、网络主机）
 *    - 危险操作的审批流
 *
 * 内部模块拆分：
 * - sandbox-types.ts     ← 共用 type/interface
 * - process-sandbox.ts   ← ProcessSandbox 类
 * - credential-vault.ts  ← CredentialVault 类
 * - token-proxy.ts       ← TokenProxy 类
 * - security-manager.ts  ← SecurityManager 类（统一入口）
 */

// ═══════════════════════════════════════════════════════════════
// Public API — re-export 所有公开符号，保持外部兼容
// ═══════════════════════════════════════════════════════════════

export type {
  SandboxLevel,
  PermissionAction,
  ToolPermission,
  SecurityPolicy,
  CredentialEntry,
  AuditLogEntry,
  SecurityStats,
  SandboxBackend,
  ProcessSandboxOptions,
  SandboxResult,
} from "./sandbox-types.js";

export { ProcessSandbox } from "./process-sandbox.js";
export { CredentialVault } from "./credential-vault.js";
export { TokenProxy } from "./token-proxy.js";
export { SecurityManager } from "./security-manager.js";
