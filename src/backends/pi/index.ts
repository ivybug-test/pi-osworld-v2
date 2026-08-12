// ---------------------------------------------------------------------------
// legacy 运行时桥（自包含）：v2 直接引用本仓库内镜像的旧 pi-osworld 实现。
// 不依赖外部 pi-osworld 包；v2 可独立 clone / install / run。
// ---------------------------------------------------------------------------

// 运行时类
export { RoleAgent, assistantToolCalls, toolResultMessage } from "./agent.js";
export { PiContextManager, contextOptionsFromConfig, mergeContextConfig } from "./context/manager.js";
export { RoleSubagent } from "./subagents/role-subagent.js";
export { FinishGate } from "./gate.js";
export { resolveTools } from "./tools/registry.js";
export { buildRoleView } from "./observation.js";
export { RunWriter } from "./telemetry.js";
export {
  createPiModelClient,
  resolveModelForAlias,
} from "./models/client.js";
export { resolveModelRef, resolveModelRefs } from "./models/registry.js";
export { actionsFromToolCalls } from "./tools/computer.js";
export { formatPlan, parsePlanItems } from "./tools/plan.js";

// 类型
export type { PiModelClient } from "./models/client.js";
export type { ToolExecutor, ToolExecutionResult } from "./tools/executor.js";
export type { PlanItem } from "./tools/plan.js";
export type { FlowContext, StepInput, StepOutput } from "./flow.js";
export type { SubagentInput, SubagentOutput, SubagentOptions } from "./subagents/types.js";
export type {
  ExperimentConfig,
  AgentRoleConfig,
  SubagentSpec as LegacySubagentSpec,
  ContextConfig,
  PromptSpec,
  ObservationPolicy as LegacyObservationPolicy,
  TerminationConfig,
  TraceConfig,
  LlmRetryConfig,
} from "../../config/runtime-spec.js";
