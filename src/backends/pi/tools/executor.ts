import type { ObservationEnvelope } from "../../../engine/types.js";

export interface ToolCallLike {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolExecutionResult {
  text: string;
  isError: boolean;
  /** Optional image payload returned by tools like state.view_image. */
  image?: { mimeType: string; data: string };
}

export interface ToolExecutor {
  execute(call: ToolCallLike): Promise<ToolExecutionResult>;
  /** Fetch a fresh observation snapshot from the VM (screenshot/a11y/terminal). */
  observe?(): Promise<ObservationEnvelope | undefined>;
}
