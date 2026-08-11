import { Type, type Tool } from "@earendil-works/pi-ai";
import { toPyAutoGui, type ToolCallKind } from "../actions/adapter.js";

export interface ComputerAction {
  response?: string;
  actions: string[];
}

export const computerAskUserTool: Tool = {
  name: "computer.ask_user",
  description: "Ask the user a clarifying question",
  parameters: Type.Object({
    question: Type.String(),
  }),
};

export const computerTools: Tool[] = [
  {
    name: "computer.click",
    description:
      "Click at normalized screen coordinates in [0, 1000] (0,0 top-left; 1000,1000 bottom-right)",
    parameters: Type.Object({
      x: Type.Number(),
      y: Type.Number(),
      modifiers: Type.Optional(
        Type.String({
          description: "Modifier keys to hold during the click, e.g. ctrl or ctrl+shift",
        }),
      ),
    }),
  },
  {
    name: "computer.right_click",
    description:
      "Right-click at normalized screen coordinates in [0, 1000]",
    parameters: Type.Object({
      x: Type.Number(),
      y: Type.Number(),
    }),
  },
  {
    name: "computer.middle_click",
    description:
      "Middle-click at normalized screen coordinates in [0, 1000]",
    parameters: Type.Object({
      x: Type.Number(),
      y: Type.Number(),
    }),
  },
  {
    name: "computer.double_click",
    description:
      "Double-click at normalized screen coordinates in [0, 1000]",
    parameters: Type.Object({
      x: Type.Number(),
      y: Type.Number(),
    }),
  },
  {
    name: "computer.triple_click",
    description:
      "Triple-click at normalized screen coordinates in [0, 1000]",
    parameters: Type.Object({
      x: Type.Number(),
      y: Type.Number(),
    }),
  },
  {
    name: "computer.mouse_move",
    description:
      "Move the mouse to normalized screen coordinates in [0, 1000]",
    parameters: Type.Object({
      x: Type.Number(),
      y: Type.Number(),
      duration: Type.Optional(Type.Number({ description: "Move duration in seconds" })),
    }),
  },
  {
    name: "computer.drag",
    description:
      "Drag from start to end using normalized screen coordinates in [0, 1000]",
    parameters: Type.Object({
      x: Type.Number(),
      y: Type.Number(),
      start_x: Type.Optional(Type.Number()),
      start_y: Type.Optional(Type.Number()),
      duration: Type.Optional(Type.Number({ description: "Drag duration in seconds" })),
    }),
  },
  {
    name: "computer.mouse_down",
    description: "Press and hold the left mouse button",
    parameters: Type.Object({
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
    }),
  },
  {
    name: "computer.mouse_up",
    description: "Release the left mouse button",
    parameters: Type.Object({
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
    }),
  },
  {
    name: "computer.hold_key",
    description: "Hold a key or key combo for a duration, then release",
    parameters: Type.Object({
      key: Type.String({ description: "Key or key combo, e.g. ctrl or ctrl+shift" }),
      duration: Type.Optional(Type.Number({ description: "Hold duration in seconds" })),
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
      key: Type.String({ description: "Key or key combo, e.g. enter or ctrl+s" }),
    }),
  },
  {
    name: "computer.scroll",
    description: "Scroll the active view",
    parameters: Type.Object({
      direction: Type.Optional(
        Type.String({ description: "up, down, left, or right; defaults to down" }),
      ),
      amount: Type.Optional(Type.Number({ description: "Scroll amount in clicks" })),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      clicks: Type.Optional(Type.Number({ description: "Legacy alias for amount" })),
    }),
  },
  {
    name: "computer.wait",
    description: "Wait for the UI to settle",
    parameters: Type.Object({
      duration: Type.Optional(Type.Number({ description: "Wait duration in seconds" })),
    }),
  },
  {
    name: "computer.screenshot",
    description: "Capture a fresh screenshot and return it to you",
    parameters: Type.Object({}),
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
