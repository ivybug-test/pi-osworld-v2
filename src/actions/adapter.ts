export type ToolCallKind = "click" | "type" | "key" | "scroll";

export interface ToolCall {
  kind: ToolCallKind;
  params: Record<string, unknown>;
}

export function toPyAutoGui(call: ToolCall): string {
  switch (call.kind) {
    case "click": {
      const x = Number(call.params.x);
      const y = Number(call.params.y);
      return `pyautogui.click(${x}, ${y})`;
    }
    case "type": {
      return `pyautogui.write(${JSON.stringify(String(call.params.text ?? ""))})`;
    }
    case "key": {
      return `pyautogui.press(${JSON.stringify(String(call.params.key ?? ""))})`;
    }
    case "scroll": {
      return `pyautogui.scroll(${Number(call.params.clicks ?? 0)})`;
    }
  }
}
