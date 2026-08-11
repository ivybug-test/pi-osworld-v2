import { HarnessSpec, type HarnessSpec as HarnessSpecT } from "./spec.js";

// ---------------------------------------------------------------------------
// legacy 兼容：把 pi-osworld v1 的 agents/topology YAML 转换为 v2 HarnessSpec
// 转换后语义与现状一致（见 DESIGN-v2.md 10.2）
// ---------------------------------------------------------------------------

type RawRecord = Record<string, unknown>;

function asRecord(v: unknown): RawRecord {
  return typeof v === "object" && v !== null ? (v as RawRecord) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function isLegacySpec(raw: RawRecord): boolean {
  return Boolean(raw.agents) && !raw.roles && !raw.loop;
}

export function convertLegacySpec(raw: RawRecord): RawRecord {
  const agents = asRecord(raw.agents);
  const topology = asString(raw.topology, "m3-single");
  const termination = asRecord(raw.termination);
  const finishGate = asRecord(termination.finish_gate);
  const legacyBudget = asRecord(termination.budget);

  const roles: RawRecord = {};
  for (const [id, agentRaw] of Object.entries(agents)) {
    const agent = asRecord(agentRaw);
    const role: RawRecord = {
      model: asString(agent.model, ""),
      prompt: agent.prompt ?? { system: "" },
      observation: agent.observation ?? { allow: [] },
      tools: asArray(agent.tools),
    };
    if (agent.model_options !== undefined) {
      role.model_options = agent.model_options;
    }
    if (agent.context !== undefined) role.context = agent.context;
    if (agent.memory !== undefined) role.memory = agent.memory;
    if (topology === "stateact-minimal" && id === "main") {
      role.message_style = "state_text";
      role.interior_loop = true;
      role.terminal_tools = ["delegate.gui", "finish", "fail", "ask_user"];
      role.plan_tool = "plan.update";
      role.refresh_state = true;
    }
    if (topology === "stateact-minimal" && id === "finish_gate") {
      role.message_style = "gate";
      role.interior_loop = true;
      role.terminal_tools = ["finish_gate.verdict"];
      role.read_only = "enforce";
    }
    if (topology === "stateact-minimal" && id === "gui") {
      role.interior_loop = true;
      role.terminal_tools = ["delegation.complete"];
    }
    if (topology === "m3-single" && id === "main") {
      role.message_style = "raw_task";
    }
    const budget =
      agent.budget !== undefined ? asRecord(agent.budget) : undefined;
    // 旧 top-level termination.budget.max_main_turns 收敛到 main 的 max_steps
    if (
      id === "main" &&
      legacyBudget.max_main_turns !== undefined
    ) {
      const target = budget ?? {};
      if (target.max_steps === undefined) {
        target.max_steps = legacyBudget.max_main_turns;
      }
      role.budget = target;
    } else if (budget) {
      role.budget = budget;
    }
    roles[id] = role;
  }

  // 旧 subagents.gui.fresh_context → roles.gui.context.fresh_per_round
  const subagents = asRecord(raw.subagents);
  for (const [id, subRaw] of Object.entries(subagents)) {
    const sub = asRecord(subRaw);
    const role = asRecord(roles[id]);
    if (role && sub.fresh_context === true) {
      const ctx = asRecord(role.context);
      role.context = { ...ctx, fresh_per_round: true };
    }
  }

  let loop: RawRecord;
  if (topology === "stateact-minimal") {
    loop = {
      driver: "gate_verdict",
      gate: "finish",
      feedback_to: "main",
      max_rounds: numberOr(finishGate.max_rounds, 3),
      total_rounds:
        termination.max_steps !== undefined
          ? termination.max_steps
          : 100,
      ...(finishGate.min_steps_before_finish !== undefined
        ? { min_steps_before_finish: finishGate.min_steps_before_finish }
        : {}),
    };
  } else {
    loop = { driver: "self_report", done_tool: "computer.done" };
  }

  const out: RawRecord = {
    experiment: asString(raw.experiment, "legacy-experiment"),
    benchmark: raw.benchmark ?? { name: "osworld-v2", release: "unknown" },
    task_set: asString(raw.task_set, "task-sets/smoke.yaml"),
    models: raw.models ?? {},
    roles,
    loop,
    termination: {
      ...(termination.max_steps !== undefined
        ? { max_steps: termination.max_steps }
        : {}),
      ...(termination.checkpoint_eval_mode !== undefined
        ? { checkpoint_eval_mode: termination.checkpoint_eval_mode }
        : {}),
      ...(termination.checkpoint_steps !== undefined
        ? { checkpoint_steps: termination.checkpoint_steps }
        : {}),
    },
    state: {
      schema: ["requirements", "artifacts", "facts"],
      store: "file",
      update_policy:
        topology === "stateact-minimal" ? "self_report" : "self_report",
    },
  };
  for (const key of [
    "description",
    "observation_capture",
    "context",
    "trace",
    "llm_retry",
    "repetitions",
    "seed",
    "runtime",
  ] as const) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }

  if (topology === "stateact-minimal") {
    out.gates = {
      finish: {
        role: "finish_gate",
        verdict_tool: "finish_gate.verdict",
        fresh_context: true,
      },
    };
    const delegations: RawRecord[] = [];
    const mainAgent = asRecord(asRecord(raw.agents).main);
    const mainTools = asArray(mainAgent.tools ?? []);
    const delegateRef = mainTools.find(
      (t): t is string => typeof t === "string" && t.startsWith("delegate."),
    );
    for (const [id, subRaw] of Object.entries(subagents)) {
      const sub = asRecord(subRaw);
      delegations.push({
        id,
        from_role: "main",
        tool: delegateRef ?? "delegate.gui",
        to_role: asString(sub.role, id),
        ...(sub.terminal_tool !== undefined
          ? { terminal_tool: sub.terminal_tool }
          : {}),
        ...(sub.fresh_context !== undefined
          ? { fresh_context: sub.fresh_context }
          : {}),
        ...(sub.max_turns !== undefined ? { max_turns: sub.max_turns } : {}),
      });
    }
    if (delegations.length > 0) out.delegations = delegations;
  }
  return out;
}

export function parseLegacySpec(raw: RawRecord): HarnessSpecT {
  return HarnessSpec.parse(convertLegacySpec(raw));
}
