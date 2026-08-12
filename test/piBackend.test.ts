import { describe, expect, it } from "vitest";
import {
  buildDelegatedTask,
  buildGateText,
  buildStateText,
  isWriteTool,
} from "../src/backends/pi/backend.js";

// ---------------------------------------------------------------------------
// A4：消息拼法（与旧 flow 逐字段对齐，纯函数，无外部 fixture）
// ---------------------------------------------------------------------------

describe("message parity (A4)", () => {
  it("buildStateText matches old stateact main format", () => {
    const text = buildStateText(
      { task: "Do the thing", roundIndex: 3, observation: { terminal: "vm$" } },
      [{ done: false, text: "step 1" }],
    );
    expect(text).toContain("instruction: Do the thing");
    expect(text).toContain("plan:");
    expect(text).toContain("terminal:\nvm$");
    expect(text).toContain("step: 3");
  });

  it("buildGateText matches old finish-gate format", () => {
    const text = buildGateText(
      { task: "Verify the report" },
      { observation: { terminal: "vm$" } },
    );
    expect(text).toContain("task instruction (verbatim): Verify the report");
    expect(text).toContain("Verify against the persisted artifact only.");
    expect(text).toContain("terminal:\nvm$");
  });

  it("buildDelegatedTask matches old flow format", () => {
    const text = buildDelegatedTask("Overall task", {
      objective: "Open the file",
      success_criteria: ["File opens", "No error"],
    });
    expect(text).toBe(
      "overall instruction: Overall task\n" +
        "delegated subtask: Open the file\n" +
        "success criteria:\n- File opens\n- No error",
    );
  });

  it("isWriteTool blocks the full read-only write set (v2 strictness)", () => {
    expect(isWriteTool("state.bash")).toBe(true);
    expect(isWriteTool("state.write_file")).toBe(true);
    expect(isWriteTool("state.edit_file")).toBe(true);
    expect(isWriteTool("state.python")).toBe(true);
    expect(isWriteTool("state.read_file")).toBe(false);
  });
});
