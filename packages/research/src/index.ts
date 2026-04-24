/**
 * @super-agent/research — 批量研究能力包
 *
 * 独立的研究工具包，不依赖核心运行时。
 * 提供 batch 推理、trajectory 导出、评估框架。
 */

// Batch Runner
export {
  BatchRunner,
  type BatchTask,
  type TaskResult,
  type BatchConfig,
  type BatchStats,
  type TaskExecutor,
} from "./batch-runner.js";

// Checkpoint
export {
  CheckpointManager,
  type CheckpointData,
} from "./checkpoint.js";

// Trajectory
export {
  TrajectoryGenerator,
  type Trajectory,
  type ShareGPTMessage,
  type TrajectoryExportConfig,
} from "./trajectory.js";

// Evaluator
export {
  Evaluator,
  ExactMatchJudge,
  ContainsJudge,
  LLMJudge,
  type Judge,
  type JudgeScore,
  type EvalConfig,
  type EvalResult,
  type EvalReport,
} from "./evaluator.js";

// Environments
export {
  LocalEnvironment,
  DockerEnvironment,
  type ExecutionEnvironment,
} from "./environments.js";

// ───── T4: 评估基准适配器 ─────

// Dataset Loader 基础类型
export {
  type BenchmarkDataset,
  type BenchmarkTask,
  type BenchmarkExpected,
  type DatasetLoadOptions,
  type DatasetLoader,
  readFromCache,
  writeToCache,
  sampleTasks,
} from "./datasets/loader.js";

// BFCL Loader
export { BFCLLoader } from "./datasets/bfcl-loader.js";

// GAIA Loader
export { GAIALoader, type DifficultyBreakdown } from "./datasets/gaia-loader.js";

// ToolBench Loader
export { ToolBenchLoader } from "./datasets/toolbench-loader.js";

// ToolCallJudge
export {
  ToolCallJudge,
  type ActualToolCall,
  type ExpectedToolCall,
} from "./judges/tool-call-judge.js";
