import type { ObservationEnvelope } from "../engine/types.js";

// ---------------------------------------------------------------------------
// Environment：统一环境抽象（DESIGN-v2.md 4.2）
// 真实实现 = OSWorld tool server（HttpEnvironment）；mock/CI 可注入 stub。
// ---------------------------------------------------------------------------

export interface ToolCallLike {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  text: string;
  isError: boolean;
  image?: { mimeType: string; data: string };
}

export type Capability = "gui" | "cli" | "observe-only";

export interface Environment {
  readonly capabilities: Set<Capability>;
  /** 拉取最新观察（截图/a11y/terminal）。 */
  observe(): Promise<ObservationEnvelope | undefined>;
  /**
   * 执行工具调用。readOnly=true 时在环境层拒绝写工具（双闸之一）；
   * readonlyPython=true 时把 state.python 映射到受限的 state.inspect_python。
   * 执行层拦截在 PiBackend，这里是环境层兜底，也供非 pi 后端使用。
   */
  execute(
    call: ToolCallLike,
    opts?: { readOnly?: boolean; readonlyPython?: boolean },
  ): Promise<ToolResult>;
}

export { type ObservationEnvelope };
