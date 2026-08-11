import { Type, type Tool } from "@earendil-works/pi-ai";
import { toPyAutoGui, type ToolCallKind } from "../actions/adapter.js";

export interface ComputerAction {
  response?: string;
  actions: string[];
}

export const computerTools: Tool[] = [
  {
    name: "computer.click",
    description: "Click at normalized screen coordinates",
    parameters: Type.Object({
      x: Type.Number(),
      y: Type.Number(),
    }),
  },
  {
    name: "computer.type",
    description: "Type text into the focused field",
    parameters: Type.Object({
      text: Type.String(),
    }),
  },
  {
    name: "computer.key",
    description: "Press a keyboard key",
    parameters: Type.Object({
      key: Type.String(),
    }),
  },
  {
    name: "computer.scroll",
    description: "Scroll the active view",
    parameters: Type.Object({
      clicks: Type.Number(),
    }),
  },
  {
    name: "computer.wait",
    description: "Wait for the UI to settle",
    parameters: Type.Object({}),
  },
  {
    name: "computer.ask_user",
    description: "Ask the user a clarifying question",
    parameters: Type.Object({
      question: Type.String(),
    }),
  },
  {
    name: "computer.done",
    description: "Declare the task complete",
    parameters: Type.Object({}),
  },
  {
    name: "computer.fail",
    description: "Declare the task impossible or failed",
    parameters: Type.Object({}),
  },
];

export function actionsFromToolCalls(
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
): ComputerAction {
  const actions: string[] = [];
  let response: string | undefined;

  for (const call of calls) {
    switch (call.name) {
      case "computer.done":
        actions.push("DONE");
        break;
      case "computer.fail":
        actions.push("FAIL");
        break;
      case "computer.wait":
        actions.push("WAIT");
        break;
      case "computer.ask_user":
        response = String(call.arguments.question ?? "");
        break;
      default: {
        const kind = call.name.replace("computer.", "") as ToolCallKind;
        actions.push(toPyAutoGui({ kind, params: call.arguments }));
      }
    }
  }

  return { response, actions };
}
