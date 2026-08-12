import { describe, expect, it } from "vitest";
import { loadHarnessSpec } from "../src/config/load.js";
import { isLegacySpec, convertLegacySpec } from "../src/config/compat.js";
import type { HarnessSpec as HarnessSpecT } from "../src/config/spec.js";

describe("legacyCompat: 旧 agents/topology YAML → v2 HarnessSpec", () => {
  it("识别旧格式", () => {
    expect(isLegacySpec({ agents: {}, topology: "m3-single" })).toBe(true);
    expect(isLegacySpec({ roles: {}, loop: {} })).toBe(false);
  });

  it("m3-single 转换：self_report 驱动 + 单角色", () => {
    const raw = {
      experiment: "m3-single",
      benchmark: { name: "osworld-v2", release: "r" },
      task_set: "task-sets/smoke.yaml",
      models: { main: "anthropic/MiniMax-M3" },
      topology: "m3-single",
      agents: {
        main: {
          model: "main",
          prompt: { system: "prompts/roles/m3-main.md" },
          observation: { allow: ["screenshot"] },
          context: "screenshot-recent",
          memory: "none",
          tools: ["computer.pyautogui"],
        },
      },
      termination: { max_steps: 100 },
    };
    const spec = convertLegacySpec(raw) as HarnessSpecT;
    expect(spec.loop).toEqual({
      driver: "self_report",
      done_tool: "computer.done",
    });
    expect(spec.roles.main.tools).toEqual(["computer.pyautogui"]);
    expect(spec.termination).toEqual({ max_steps: 100 });
  });

  it("stateact-minimal 转换：gate_verdict 驱动 + gates.finish + total_rounds", () => {
    const raw = {
      experiment: "stateact-minimal",
      benchmark: { name: "osworld-v2", release: "r" },
      task_set: "task-sets/smoke.yaml",
      models: { main: "m", gui: "m", finish_gate: "m" },
      topology: "stateact-minimal",
      agents: {
        main: { model: "main", prompt: { system: "p" }, observation: { allow: ["state"] }, tools: ["state.inspect", "finish.request"] },
        gui: { model: "gui", prompt: { system: "p" }, observation: { allow: ["screenshot"] }, tools: ["computer.pyautogui"] },
        finish_gate: { model: "finish_gate", prompt: { system: "p" }, observation: { allow: ["state"] }, tools: ["state.inspect_ro"] },
      },
      subagents: { gui: { role: "gui", fresh_context: true, terminal_tool: "delegation.complete" } },
      termination: {
        max_steps: 200,
        require_finish_gate: true,
        finish_gate: { max_rounds: 3, min_steps_before_finish: 3 },
        budget: { max_main_turns: 200 },
      },
    };
    const spec = convertLegacySpec(raw) as HarnessSpecT;
    expect(spec.loop).toEqual({
      driver: "gate_verdict",
      gate: "finish",
      feedback_to: "main",
      max_rounds: 3,
      total_rounds: 200,
      min_steps_before_finish: 3,
    });
    expect(spec.delegations).toEqual([
      {
        id: "gui",
        from_role: "main",
        tool: "delegate.gui",
        to_role: "gui",
        terminal_tool: "delegation.complete",
        fresh_context: true,
      },
    ]);
    expect(spec.roles.main).toMatchObject({
      interior_loop: true,
      terminal_tools: ["delegate.gui", "finish", "fail", "ask_user"],
      plan_tool: "plan.update",
      refresh_state: true,
      message_style: "state_text",
    });
    expect(spec.roles.finish_gate).toMatchObject({
      terminal_tools: ["finish_gate.verdict"],
      read_only: "enforce",
    });
    expect(spec.gates).toEqual({
      finish: { role: "finish_gate", verdict_tool: "finish_gate.verdict", fresh_context: true },
    });
    expect(spec.roles.gui.context).toEqual({ fresh_per_round: true });
    expect(spec.roles.main.budget).toEqual({ max_steps: 200 });
  });

});
