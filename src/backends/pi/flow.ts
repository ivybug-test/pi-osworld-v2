import type { ExperimentConfig } from "../../config/runtime-spec.js";
import type { ObservationEnvelope } from "./observation.js";
import type { ToolExecutor } from "./tools/executor.js";
import type { RunWriter } from "./telemetry.js";

export interface FlowContext {
  config: ExperimentConfig;
  root: string;
  resultDir: string;
  writer: RunWriter;
  toolExecutor?: ToolExecutor;
}

export interface StepInput {
  episodeId: string;
  instruction: string;
  step: number;
  observation: ObservationEnvelope;
}

export interface StepOutput {
  response: string;
  actions: string[];
}

export interface Flow {
  initialize(context: FlowContext): Promise<void>;
  reset(input: { episodeId: string; taskDate?: string }): Promise<void>;
  predict(input: StepInput): Promise<StepOutput>;
  close(): Promise<void>;
}
