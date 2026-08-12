import type { HarnessSpec } from "../../config/spec.js";
import type { ContextSpec } from "../../config/spec.js";
import { HttpToolExecutor } from "../../env/http.js";
import {
  RunWriter,
  type ContextConfig,
  type ExperimentConfig,
  type FlowContext,
} from "./index.js";

// ---------------------------------------------------------------------------
// legacy 运行时桥：v2 spec → 旧 ExperimentConfig / FlowContext
// PiBackend 用旧 RoleAgent / RoleSubagent / PiContextManager 时需要的运行时骨架。
// 不加载旧 config 文件，也不构造旧 flow——编排仍由 v2 引擎负责。
// ---------------------------------------------------------------------------

export interface LegacyRuntimeOptions {
  spec: HarnessSpec;
  /** config root：prompt 相对路径的基准。 */
  root: string;
  /** run 目录：RunWriter 把 events/telemetry/llm_traces 落在这里。 */
  resultDir: string;
  /** OSWorld tool server（旧 HttpToolExecutor 直连）。 */
  toolServerUrl?: string;
}

export function legacyTopology(spec: HarnessSpec): "m3-single" | "stateact-minimal" {
  switch (spec.loop.driver) {
    case "gate_verdict":
      return "stateact-minimal";
    default:
      return "m3-single";
  }
}

/** 旧 ContextConfig 没有 fresh_per_round（v2 引擎概念），映射时剥掉。 */
export function toLegacyContext(ctx?: ContextSpec): ContextConfig {
  if (typeof ctx === "string" || ctx === undefined) {
    // v2 的命名 profile 字符串在旧引擎里没有对应物；缺省用 pi-session 空配置。
    return { engine: "pi-session" };
  }
  const { fresh_per_round: _dropped, ...rest } = ctx;
  return { engine: "pi-session", ...rest };
}

export function buildLegacyConfig(spec: HarnessSpec): ExperimentConfig {
  const agents: ExperimentConfig["agents"] = {};
  for (const [id, role] of Object.entries(spec.roles)) {
    agents[id] = {
      model: role.model,
      prompt: {
        ...(role.prompt.system !== undefined
          ? { system: role.prompt.system }
          : {}),
        ...(role.prompt.append !== undefined
          ? { append: role.prompt.append }
          : {}),
        ...(role.prompt.templates !== undefined
          ? { templates: role.prompt.templates }
          : {}),
        ...(role.prompt.context_files !== undefined
          ? { context_files: role.prompt.context_files }
          : {}),
        ...(role.prompt.skills !== undefined
          ? { skills: role.prompt.skills }
          : {}),
      },
      observation: {
        allow: [...role.observation.allow],
        ...(role.observation.deny ? { deny: [...role.observation.deny] } : {}),
      },
      context: toLegacyContext(role.context ?? spec.context),
      memory: role.memory ?? "none",
      tools: [...role.tools],
      ...(role.budget
        ? {
            budget: {
              ...(role.budget.max_steps !== undefined
                ? { max_steps: role.budget.max_steps }
                : {}),
              ...(role.budget.max_cost_usd !== undefined
                ? { max_cost_usd: role.budget.max_cost_usd }
                : {}),
            },
          }
        : {}),
    };
  }

  const subagents: ExperimentConfig["subagents"] = {};
  for (const d of spec.delegations ?? []) {
    subagents[d.id] = {
      role: d.to_role,
      ...(d.fresh_context !== undefined ? { fresh_context: d.fresh_context } : {}),
      ...(d.max_turns !== undefined ? { max_turns: d.max_turns } : {}),
      ...(d.terminal_tool !== undefined ? { terminal_tool: d.terminal_tool } : {}),
    };
  }

  return {
    experiment: spec.experiment,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    benchmark: spec.benchmark,
    task_set: spec.task_set,
    ...(spec.observation_capture !== undefined
      ? { observation_capture: spec.observation_capture }
      : {}),
    ...(spec.context !== undefined
      ? { context: toLegacyContext(spec.context) }
      : {}),
    ...(spec.trace !== undefined ? { trace: spec.trace } : {}),
    ...(spec.llm_retry !== undefined ? { llm_retry: spec.llm_retry } : {}),
    ...(spec.repetitions !== undefined ? { repetitions: spec.repetitions } : {}),
    ...(spec.seed !== undefined ? { seed: spec.seed } : {}),
    models: { ...spec.models },
    topology: legacyTopology(spec),
    agents,
    ...(Object.keys(subagents).length > 0 ? { subagents } : {}),
    termination: {
      max_steps: spec.termination?.max_steps ?? 100,
    },
  };
}

/** 构造旧 FlowContext（RoleAgent 的运行时依赖）。每次 PiBackend 创建一次。 */
export function buildLegacyFlowContext(options: LegacyRuntimeOptions): FlowContext {
  const config = buildLegacyConfig(options.spec);
  const writer = new RunWriter(options.resultDir, { verbose: false });
  return {
    config,
    root: options.root,
    resultDir: options.resultDir,
    writer,
    toolExecutor: options.toolServerUrl
      ? new HttpToolExecutor(options.toolServerUrl)
      : undefined,
  };
}
