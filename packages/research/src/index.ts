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
