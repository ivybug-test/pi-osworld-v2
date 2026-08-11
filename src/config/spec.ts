import { z } from "zod";

// ---------------------------------------------------------------------------
// HarnessSpec：可组合的 harness 实验 schema（v2 草案，见 DESIGN-v2.md 10.1）
// ---------------------------------------------------------------------------

export const BackendId = z.enum(["pi", "codex", "claude", "openclaw", "mock"]);
export type BackendId = z.infer<typeof BackendId>;

export const BudgetSpec = z.object({
  max_seconds: z.number().positive().optional(),
  max_steps: z.number().int().positive().optional(),
  max_cost_usd: z.number().positive().optional(),
});
export type BudgetSpec = z.infer<typeof BudgetSpec>;

export const ObservationChannel = z.enum([
  "screenshot",
  "accessibility_tree",
  "state",
  "user_response",
  "terminal",
  "tool_text",
]);
export type ObservationChannel = z.infer<typeof ObservationChannel>;

export const ObservationPolicy = z.object({
  allow: z.array(ObservationChannel),
  deny: z.array(ObservationChannel).optional(),
});
export type ObservationPolicy = z.infer<typeof ObservationPolicy>;

export const CompactionSpec = z.object({
  enabled: z.boolean().optional(),
  reserve_tokens: z.number().int().optional(),
  keep_recent_tokens: z.number().int().optional(),
  strategy: z
    .enum([
      "pi-summary",
      "turn-retention",
      "m3-image-truncation",
      "truncate",
      "none",
    ])
    .optional(),
  turn_retention: z
    .object({
      screenshot_turns: z.number().int().optional(),
      text_turns: z.number().int().optional(),
      summarize_text: z.boolean().optional(),
    })
    .optional(),
  image_truncation: z
    .object({
      screenshot_turns: z.number().int().optional(),
      chunk_size: z.number().int().optional(),
      placeholder: z.string().optional(),
    })
    .optional(),
});
export type CompactionSpec = z.infer<typeof CompactionSpec>;

export const ContextSpec = z.union([
  z.string(), // 命名 profile
  z.object({
    engine: z.literal("pi-session").optional(),
    context_window: z.number().int().optional(),
    compaction: CompactionSpec.optional(),
    fresh_per_round: z.boolean().optional(),
  }),
]);
export type ContextSpec = z.infer<typeof ContextSpec>;

export const ReceivesSource = z.enum([
  "task",
  "task_state",
  "contract",
  "evidence_refs",
  "executor_report",
  "audit_history",
  "env_state",
]);
export type ReceivesSource = z.infer<typeof ReceivesSource>;

export const ModelSamplingSpec = z.object({
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().nullable().optional(),
  thinking_mode: z.enum(["adaptive", "disabled"]).optional(),
  thinking_budget: z.number().int().positive().optional(),
});
export type ModelSamplingSpec = z.infer<typeof ModelSamplingSpec>;

export const RoleSpec = z.object({
  backend: BackendId.default("pi"),
  model: z.string(),
  model_options: ModelSamplingSpec.optional(),
  prompt: z.object({
    system: z.string(),
    append: z.array(z.string()).optional(),
    templates: z
      .array(
        z.object({ path: z.string(), args: z.array(z.string()).optional() }),
      )
      .optional(),
    context_files: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
  }),
  observation: ObservationPolicy,
  context: ContextSpec.optional(),
  memory: z.literal("none").optional(),
  tools: z.array(z.string()),
  receives: z.array(ReceivesSource).optional(),
  read_only: z.enum(["enforce", "none"]).default("none"),
  budget: BudgetSpec.optional(),
  /** 消息拼法：engine=v2 通用 receives 组装；raw_task=原文任务；state_text=stateact 式状态文本；gate=只读 gate 观察。 */
  message_style: z
    .enum(["engine", "raw_task", "state_text", "gate"])
    .default("engine"),
  /** 内部工具循环：true 时后端在单个 episode 内多次请求直到终结工具/无工具调用；false = 单次完成（m3 风格）。 */
  interior_loop: z.boolean().optional(),
  /** 终结内部循环、交由 driver/后端处理的解析后工具名（如 finish / finish_gate.verdict）。 */
  terminal_tools: z.array(z.string()).optional(),
  /** plan 外部化工具（解析后名，如 plan.update）：触发 plan 列表外部化与每轮注入。 */
  plan_tool: z.string().optional(),
  /** 工具循环内每轮把最新 state 文本重新注入最后一条 user 消息（stateact main 的 transform）。 */
  refresh_state: z.boolean().optional(),
});
export type RoleSpec = z.infer<typeof RoleSpec>;

export const StateSpec = z.object({
  schema: z
    .array(z.enum(["requirements", "artifacts", "facts"]))
    .default(["requirements", "artifacts", "facts"]),
  store: z.enum(["file", "memory"]).default("file"),
  update_policy: z
    .enum(["audit_verified", "self_report"])
    .default("self_report"),
});
export type StateSpec = z.infer<typeof StateSpec>;

export const GateSpec = z.object({
  role: z.string(),
  verdict_tool: z.string(),
  fresh_context: z.boolean().default(true),
});
export type GateSpec = z.infer<typeof GateSpec>;

export const LoopSpec = z.discriminatedUnion("driver", [
  z.object({
    driver: z.literal("self_report"),
    role: z.string().optional(), // 缺省取 spec.roles 的第一个角色
    done_tool: z.string(),
    max_rounds: z.number().int().positive().default(30),
  }),
  z.object({
    driver: z.literal("gate_verdict"),
    gate: z.string(),
    feedback_to: z.string(),
    max_rounds: z.number().int().positive().default(3), // 拒绝/修复轮上限
    total_rounds: z.number().int().positive().optional(), // 总轮硬上限（默认 100）
    min_steps_before_finish: z.number().int().nonnegative().optional(), // finish 前最少非终结步数（stateact）
    // 拒绝轮耗尽时的放行语义：blocked=FAIL（旧 stateact 行为，默认）；done=强制放行
    on_gate_exhausted: z.enum(["done", "blocked"]).default("blocked"),
  }),
  z.object({
    driver: z.literal("manager_decision"),
    decision_tool: z.string(),
    contract: z.object({
      produced_by: z.string(),
      fields: z.array(
        z.enum([
          "goal",
          "acceptance_criteria",
          "boundary_constraints",
          "evidence_refs",
          "target",
        ]),
      ),
    }),
    routing: z.object({ gui: z.string(), cli: z.string() }),
    max_rounds: z.number().int().positive().default(25),
  }),
  z.object({ driver: z.literal("policy"), policy: z.string() }),
]);
export type LoopSpec = z.infer<typeof LoopSpec>;

export const TerminationSpec = z.object({
  on: z
    .array(z.enum(["done", "blocked", "ask", "max_rounds", "timeout"]))
    .optional(),
  max_steps: z.number().int().positive().optional(),
  checkpoint_eval_mode: z.enum(["off", "inline"]).optional(),
  checkpoint_steps: z.array(z.number().int().positive()).optional(),
});
export type TerminationSpec = z.infer<typeof TerminationSpec>;

export const RuntimeSpec = z.object({
  num_envs: z.number().int().positive().optional(),
  env_start_delay: z.number().nonnegative().optional(),
});
export type RuntimeSpec = z.infer<typeof RuntimeSpec>;

export const DebugSpec = z.object({
  pause_after: z.array(z.string()).optional(),
  inspect: z.array(z.string()).optional(),
  hooks: z.record(z.string()).optional(),
});
export type DebugSpec = z.infer<typeof DebugSpec>;

export const BackendSpec = z.object({
  command: z.string().optional(),
  model: z.string().optional(),
});
export type BackendSpec = z.infer<typeof BackendSpec>;

export const HarnessSpec = z.object({
  experiment: z.string(),
  description: z.string().optional(),
  extends: z.string().optional(),
  benchmark: z.object({ name: z.string(), release: z.string() }),
  task_set: z.string(),
  observation_capture: z
    .object({
      require_a11y_tree: z.boolean().optional(),
      require_terminal: z.boolean().optional(),
    })
    .optional(),
  context: ContextSpec.optional(),
  trace: z
    .object({
      llm_requests: z.boolean().optional(),
      include_images: z.boolean().optional(),
    })
    .optional(),
  llm_retry: z
    .object({
      max_retries: z.number().int().nonnegative().optional(),
      max_retry_delay_ms: z.number().int().positive().optional(),
    })
    .optional(),
  delegations: z
    .array(
      z.object({
        id: z.string(),
        /** 谁可以发起委派（角色 id）。 */
        from_role: z.string(),
        /** 触发委派的工具名（解析后，如 delegate.gui）。 */
        tool: z.string(),
        /** 被委派的角色（to_role 的后端执行子任务）。 */
        to_role: z.string(),
        /** 终结委派、携带报告的工具名（如 delegation.complete）。 */
        terminal_tool: z.string().optional(),
        fresh_context: z.boolean().optional(),
        max_turns: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  models: z.record(z.string()).refine((m) => Object.keys(m).length > 0, {
    message: "models must define at least one model",
  }),
  backends: z.record(BackendSpec).optional(),
  roles: z.record(RoleSpec).refine((r) => Object.keys(r).length > 0, {
    message: "roles must define at least one role",
  }),
  state: StateSpec.optional(),
  gates: z.record(GateSpec).optional(),
  loop: LoopSpec,
  termination: TerminationSpec.optional(),
  runtime: RuntimeSpec.optional(),
  debug: DebugSpec.optional(),
  repetitions: z.number().int().positive().optional(),
  seed: z.number().optional(),
});
export type HarnessSpec = z.infer<typeof HarnessSpec>;
export type LoopSpecValue = LoopSpec;
