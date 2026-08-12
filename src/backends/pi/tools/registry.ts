import type { Tool } from "@earendil-works/pi-ai";
import { computerAskUserTool, computerTools } from "./computer.js";
import {
  askUserTool,
  auditSubmitTool,
  completeDelegationTool,
  delegateGuiTool,
  failTool,
  finishGateVerdictTool,
  finishTool,
} from "./delegation.js";
import { planUpdateTool } from "./plan.js";
import { stateTools } from "./state.js";

const TOOL_GROUPS: Record<string, Tool[]> = {
  // computer.pyautogui expands to the full OSWorld pyautogui tool set.
  "computer.pyautogui": computerTools,
  // state.inspect / state.code expand to the VM code-execution tool set.
  "state.inspect": stateTools,
  "state.code": stateTools,
  // Read-only verifier set: no bash/write/edit. state.python is kept because
  // the permission layer maps it to a guarded state.inspect_python at runtime.
  "state.inspect_ro": stateTools.filter(
    (tool) =>
      tool.name === "state.read_file" ||
      tool.name === "state.list_dir" ||
      tool.name === "state.view_image" ||
      tool.name === "state.render_document" ||
      tool.name === "state.terminal" ||
      tool.name === "state.python",
  ),
  "state.view_image": [
    stateTools.find((tool) => tool.name === "state.view_image")!,
  ],
  "state.bash": [stateTools[0]],
  "state.python": [stateTools[1]],
  "state.terminal": [stateTools.find((tool) => tool.name === "state.terminal")!],
  "delegation.complete": [completeDelegationTool],
  "plan.update": [planUpdateTool],
};

const TOOL_DEFS: Record<string, Tool> = {
  "delegate.gui": delegateGuiTool,
  "finish.request": finishTool,
  "fail.request": failTool,
  "computer.ask_user": computerAskUserTool,
  "ask_user.request": askUserTool,
  "finish_gate.verdict": finishGateVerdictTool,
  "audit.submit": auditSubmitTool,
  "plan.update": planUpdateTool,
};

/** Resolve YAML tool refs (agents.<role>.tools) to the Tool[] sent to the model. */
export function resolveTools(refs: string[]): Tool[] {
  const tools: Tool[] = [];
  for (const ref of refs) {
    const group = TOOL_GROUPS[ref];
    if (group) {
      tools.push(...group);
      continue;
    }
    const tool = TOOL_DEFS[ref];
    if (tool) {
      tools.push(tool);
      continue;
    }
    console.warn(`[pi-osworld] unknown tool ref: ${ref}`);
  }
  return tools;
}
