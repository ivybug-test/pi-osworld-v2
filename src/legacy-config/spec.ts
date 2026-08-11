export type TopologyId = "m3-single" | "stateact-minimal";

export interface BenchmarkConfig {
  name: string;
  release: string;
}

export interface PromptTemplateRef {
  path: string;
  args?: string[];
}

export interface PromptSpec {
  system?: string;
  append?: string[];
  templates?: PromptTemplateRef[];
  context_files?: string[];
  skills?: string[];
}

export interface ModelSamplingConfig {
  /** Provider temperature; ignored when extended thinking is enabled by Pi. */
  temperature?: number;
  /** Max output tokens for one completion. */
  max_tokens?: number;
  /** Top-p. Kept for config parity; Pi's Anthropic adapter currently ignores it. */
  top_p?: number | null;
  /** Map to Pi's thinkingEnabled / thinkingBudgetTokens for Anthropic. */
  thinking_mode?: "adaptive" | "disabled";
  /** Budget for non-adaptive thinking; ignored for adaptive models. */
  thinking_budget?: number;
}

export interface ObservationPolicy {
  allow: string[];
  deny?: string[];
}

export interface BudgetSpec {
  max_steps?: number;
  max_cost_usd?: number;
}

export interface AgentRoleConfig {
  model: string;
  /** Sampling knobs passed to the provider on every completion. */
  model_options?: ModelSamplingConfig;
  prompt: PromptSpec;
  observation: ObservationPolicy;
  /**
   * Context profile name, or an inline context config that overrides the
   * experiment-level `context` block (compaction strategy etc).
   */
  context: string | ContextConfig;
  memory: string;
  tools: string[];
  budget?: BudgetSpec;
}

export interface SubagentSpec {
  /** Agent role id in `agents` that backs this subagent. */
  role: string;
  /** Reset context before every delegation. Defaults to true. */
  fresh_context?: boolean;
  /** Interior turn cap for the subagent loop (reserved for loop support). */
  max_turns?: number;
  /** Tool name that ends the delegation and carries the report. */
  terminal_tool?: string;
}

export interface FinishGateConfig {
  /** Maximum rejection/repair rounds before the gate gives up. Defaults to 3. */
  max_rounds?: number;
  /** Minimum non-finish outer steps before finish is honored. Defaults to 3. */
  min_steps_before_finish?: number;
}

export interface TerminationBudgetConfig {
  /** Cap on main-agent model turns across the whole episode. */
  max_main_turns?: number;
  /** Cap on total LLM cost across all roles for the episode. */
  max_cost_usd?: number;
}

export interface TerminationConfig {
  max_steps: number;
  max_cost_usd?: number;
  /** OSWorld inline checkpoint evaluation mode. */
  checkpoint_eval_mode?: "off" | "inline";
  /** Logical step numbers for inline checkpoint evals, e.g. [150, 300]. */
  checkpoint_steps?: number[];
  /** Run the independent finish gate when the main agent calls finish. */
  require_finish_gate?: boolean;
  finish_gate?: FinishGateConfig;
  budget?: TerminationBudgetConfig;
}

export interface ObservationCaptureConfig {
  require_a11y_tree?: boolean;
  require_terminal?: boolean;
}

export interface TraceConfig {
  /** Dump full LLM request/response payloads to llm_traces.jsonl. Defaults to true. */
  llm_requests?: boolean;
  /** Include base64 image bytes in LLM traces. Off by default because they dominate file size. */
  include_images?: boolean;
}

export interface LlmRetryConfig {
  /** Provider retry attempts on transient 408/409/429/5xx/network errors. Defaults to 0. */
  max_retries?: number;
  /** Cap on server-requested retry delays in milliseconds. */
  max_retry_delay_ms?: number;
}

export interface CompactionConfig {
  enabled?: boolean;
  reserve_tokens?: number;
  keep_recent_tokens?: number;
  /** Which compaction strategy to use once the threshold is crossed. */
  strategy?:
    | "pi-summary"
    | "turn-retention"
    | "m3-image-truncation"
    | "truncate"
    | "none";
  /** Retention knobs for the turn-retention strategy. */
  turn_retention?: {
    screenshot_turns?: number;
    text_turns?: number;
    summarize_text?: boolean;
  };
  /** M3-style image truncation: keep recent screenshots, replace older images. */
  image_truncation?: {
    screenshot_turns?: number;
    chunk_size?: number;
    placeholder?: string;
  };
}

export interface ContextConfig {
  /** Context engine; pi-session uses Pi's session/compaction machinery. */
  engine?: "pi-session";
  context_window?: number;
  compaction?: CompactionConfig;
}

export interface RuntimeConfig {
  /** Number of parallel VM environments. Defaults to 1. */
  num_envs?: number;
  /** Stagger worker startup in seconds. */
  env_start_delay?: number;
}

export interface ExperimentConfig {
  experiment: string;
  description?: string;
  benchmark: BenchmarkConfig;
  task_set: string;
  observation_capture?: ObservationCaptureConfig;
  context?: ContextConfig;
  trace?: TraceConfig;
  llm_retry?: LlmRetryConfig;
  repetitions?: number;
  seed?: number;
  runtime?: RuntimeConfig;
  models: Record<string, string>;
  topology: TopologyId;
  agents: Record<string, AgentRoleConfig>;
  subagents?: Record<string, SubagentSpec>;
  termination: TerminationConfig;
  judges?: string[];
}
