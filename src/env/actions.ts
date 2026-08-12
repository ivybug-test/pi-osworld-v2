export type ToolCallKind =
  | "click"
  | "right_click"
  | "middle_click"
  | "double_click"
  | "triple_click"
  | "mouse_move"
  | "drag"
  | "mouse_down"
  | "mouse_up"
  | "hold_key"
  | "type"
  | "key"
  | "scroll"
  | "wait"
  | "screenshot";

export interface ToolCall {
  kind: ToolCallKind;
  params: Record<string, unknown>;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface PyAutoGuiOptions {
  screen?: ScreenSize;
}

export function toPyAutoGui(
  call: ToolCall,
  options: PyAutoGuiOptions = {},
): string {
  const screen = resolveScreen(options);
  const modifiers = String(call.params.modifiers ?? "");
  const modifierKeys = modifiers
    ? modifiers.split("+").map((k) => k.trim().toLowerCase()).filter(Boolean)
    : [];
  const down = modifierKeys.map((k) => `pyautogui.keyDown(${JSON.stringify(k)})`).join("\n");
  const up = modifierKeys
    .map((k) => `pyautogui.keyUp(${JSON.stringify(k)})`)
    .reverse()
    .join("\n");
  const xy = (x: unknown, y: unknown) =>
    `${scaleCoordinate(x, screen.width)}, ${scaleCoordinate(y, screen.height)}`;

  switch (call.kind) {
    case "click": {
      const body = `pyautogui.click(${xy(call.params.x, call.params.y)})`;
      return [down, body, up].filter(Boolean).join("\n");
    }
    case "right_click": {
      const body = `pyautogui.rightClick(${xy(call.params.x, call.params.y)})`;
      return [down, body, up].filter(Boolean).join("\n");
    }
    case "middle_click": {
      const body = `pyautogui.middleClick(${xy(call.params.x, call.params.y)})`;
      return [down, body, up].filter(Boolean).join("\n");
    }
    case "double_click": {
      const body = `pyautogui.doubleClick(${xy(call.params.x, call.params.y)})`;
      return [down, body, up].filter(Boolean).join("\n");
    }
    case "triple_click": {
      const body = `pyautogui.tripleClick(${xy(call.params.x, call.params.y)})`;
      return [down, body, up].filter(Boolean).join("\n");
    }
    case "mouse_move": {
      const duration = Number(call.params.duration ?? 0.5);
      return `pyautogui.moveTo(${xy(call.params.x, call.params.y)}, duration=${duration})`;
    }
    case "drag": {
      const duration = Number(call.params.duration ?? 0.5);
      const hasStart =
        call.params.start_x !== undefined && call.params.start_y !== undefined;
      const lines = [];
      if (hasStart) {
        lines.push(
          `pyautogui.moveTo(${xy(call.params.start_x, call.params.start_y)}, duration=${duration})`,
        );
      }
      lines.push(
        `pyautogui.dragTo(${xy(call.params.x, call.params.y)}, duration=${duration})`,
      );
      return lines.join("\n");
    }
    case "mouse_down": {
      const hasCoords =
        call.params.x !== undefined && call.params.y !== undefined;
      return hasCoords
        ? `pyautogui.mouseDown(${xy(call.params.x, call.params.y)})`
        : "pyautogui.mouseDown()";
    }
    case "mouse_up": {
      const hasCoords =
        call.params.x !== undefined && call.params.y !== undefined;
      return hasCoords
        ? `pyautogui.mouseUp(${xy(call.params.x, call.params.y)})`
        : "pyautogui.mouseUp()";
    }
    case "hold_key": {
      const keys = String(call.params.key ?? "")
        .split("+")
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);
      const duration = Number(call.params.duration ?? 1);
      const lines = keys.map((k) => `pyautogui.keyDown(${JSON.stringify(k)})`);
      lines.push(`time.sleep(${duration})`);
      lines.push(
        ...keys
          .map((k) => `pyautogui.keyUp(${JSON.stringify(k)})`)
          .reverse(),
      );
      return lines.join("\n");
    }
    case "type": {
      return `pyautogui.write(${JSON.stringify(String(call.params.text ?? ""))})`;
    }
    case "key": {
      const keys = String(call.params.key ?? "")
        .split("+")
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);
      return keys.length > 0
        ? `pyautogui.hotkey(${keys.map((k) => JSON.stringify(k)).join(", ")})`
        : "pyautogui.sleep(0.1)";
    }
    case "scroll": {
      const direction = String(call.params.direction ?? "down");
      const amount = Number(call.params.amount ?? call.params.clicks ?? 1);
      const signed =
        direction === "down" || direction === "left" ? -amount : amount;
      const hasX = call.params.x !== undefined;
      if (direction === "left" || direction === "right") {
        return hasX
          ? `pyautogui.hscroll(${signed}, ${xy(call.params.x, call.params.y ?? 0)})`
          : `pyautogui.hscroll(${signed})`;
      }
      return hasX
        ? `pyautogui.scroll(${signed}, ${xy(call.params.x, call.params.y ?? 0)})`
        : `pyautogui.scroll(${signed})`;
    }
    case "wait":
      return `time.sleep(${Number(call.params.duration ?? 0.5)})`;
    case "screenshot":
      return "pyautogui.sleep(0.1)";
  }
}

function resolveScreen(options: PyAutoGuiOptions): ScreenSize {
  return options.screen ?? {
    width: envInt("PI_OSWORLD_SCREEN_WIDTH", 1920),
    height: envInt("PI_OSWORLD_SCREEN_HEIGHT", 1080),
  };
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function scaleCoordinate(value: unknown, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(max, Math.round((numeric / 1000) * max)));
}
