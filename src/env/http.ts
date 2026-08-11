import { HttpToolExecutor } from "../legacy/imports.js";
import type { Environment, ToolCallLike, ToolResult } from "./types.js";

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
