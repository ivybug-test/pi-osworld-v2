import type { ObservationEnvelope } from "../observation/router.js";

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
): ToolExecutionResult {
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

  async execute(call: ToolCallLike): Promise<ToolExecutionResult> {
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
      return body.ok ? body.observation : undefined;
    } catch {
      return undefined;
    }
  }
}
