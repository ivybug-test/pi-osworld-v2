import type { SubagentSpec } from "../../../config/runtime-spec.js";
import type { FlowContext } from "../flow.js";
import type { PiModelClient } from "../models/client.js";
import type { ObservationEnvelope } from "../observation.js";

export interface SubagentInput {
  episodeId: string;
  instruction: string;
  /** Focused subtask handed to the subagent by the main agent. */
  task: string;
  step: number;
  observation: ObservationEnvelope;
}

export interface SubagentOutput {
  /** Concise structured report returned to the caller. */
  report: string;
  actions: string[];
  response?: string;
}

export interface Subagent {
  readonly id: string;
  initialize(): Promise<void>;
  invoke(input: SubagentInput): Promise<SubagentOutput>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface SubagentOptions {
  id: string;
  spec: SubagentSpec;
  context: FlowContext;
  /** Test seam: override the real model client. */
  client?: PiModelClient;
  /** Called after every interior model turn; return false to stop the loop. */
  onTurn?: () => boolean | void;
}
