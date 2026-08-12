import { normalizeObservation } from "../backends/pi/observation.js";
import type { ToolExecutor } from "../backends/pi/tools/executor.js";
import type {
  Environment,
  ToolCallLike,
  ToolResult,
  ObservationEnvelope,
} from "./types.js";

// ---------------------------------------------------------------------------
// 写工具集合（环境层只读强制用；与 PiBackend/旧 finish-gate 的集合一致）
// ---------------------------------------------------------------------------

export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "state.write_file",
  "state.edit_file",
  "state.bash",
]);

export const STATE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "state.bash",
  "state.python",
  "state.write_file",
  "state.edit_file",
]);

export interface ToolServerResponse {
  ok: boolean;
  output?: string;
  error?: string;
  returncode?: number;
  image_b64?: string;
  image_mime?: string;
}

export function formatToolServerResponse(
  response: ToolServerResponse,
): ToolResult {
  const output = response.output?.trim() || "(no output)";
  const code = response.returncode ?? 0;
  if (response.ok) {
    return {
      text: `[exit ${code}]\n${output}`,
      isError: false,
      ...(response.image_b64
        ? {
            image: {
              mimeType: response.image_mime ?? "image/png",
              data: response.image_b64,
            },
          }
        : {}),
    };
  }
  const error = response.error?.trim() || "tool execution failed";
  return {
    text: `[exit ${code}]\n${error}\n${output}`,
    isError: true,
  };
}

/** Calls the Python adapter's VM tool server (OSWorld controller bridge). */
export class HttpToolExecutor implements ToolExecutor {
  constructor(private readonly baseUrl: string) {}

  async execute(call: ToolCallLike): Promise<ToolResult> {
    try {
      const response = await fetch(`${this.baseUrl}/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: call.name, arguments: call.arguments }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        return {
          text: `tool server error: HTTP ${response.status} ${response.statusText}`,
          isError: true,
        };
      }
      const body = (await response.json()) as ToolServerResponse;
      return formatToolServerResponse(body);
    } catch (error) {
      return {
        text: `tool server request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }
  }

  async observe(): Promise<ObservationEnvelope | undefined> {
    try {
      const response = await fetch(`${this.baseUrl}/observe`, {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as {
        ok: boolean;
        observation?: ObservationEnvelope;
      };
      return body.ok ? normalizeObservation(body.observation ?? {}) : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * OSWorld tool server 的 v2 环境适配层：HTTP 协议复用旧 HttpToolExecutor，
 * 在环境层叠加只读双闸（write 工具直接拒绝，不触碰 VM）。
 */
export class HttpEnvironment implements Environment {
  readonly capabilities = new Set(["gui", "cli", "observe-only"] as const);

  constructor(
    private readonly baseUrl: string,
    private readonly writeTools: ReadonlySet<string> = WRITE_TOOLS,
  ) {}

  async observe() {
    return new HttpToolExecutor(this.baseUrl).observe();
  }

  async execute(
    call: ToolCallLike,
    opts?: { readOnly?: boolean; readonlyPython?: boolean },
  ): Promise<ToolResult> {
    const effectiveCall =
      opts?.readonlyPython && call.name === "state.python"
        ? { ...call, name: "state.inspect_python" }
        : call;
    if (opts?.readOnly && this.writeTools.has(effectiveCall.name)) {
      return {
        text: `${effectiveCall.name} is disabled for the read-only role (environment layer)`,
        isError: true,
      };
    }
    return new HttpToolExecutor(this.baseUrl).execute(effectiveCall);
  }
}
