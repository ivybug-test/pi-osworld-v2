import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { PiModelClient } from "pi-osworld/dist/models/client.js";
import { loadHarnessSpec } from "../src/config/load.js";
import { PiBackend, buildDelegatedTask, buildGateText, buildStateText, isWriteTool } from "../src/backends/pi.js";
import { buildLegacyConfig } from "../src/legacy/context.js";
import type { EpisodeRequest } from "../src/engine/types.js";

// ---------------------------------------------------------------------------
// fake PiModelClient：脚本化 assistant 回复，记录收到的 user 消息
// ---------------------------------------------------------------------------

interface FakeStep {
  text?: string;
  calls?: Array<{ id?: string; name: string; arguments?: Record<string, unknown> }>;
}

function fakeClient(steps: FakeStep[]): { client: PiModelClient; seenUser: string[]; turns: () => number } {
  let i = 0;
  const seenUser: string[] = [];
  return {
    client: {
      async complete(_alias, context) {
        const lastUser = [...context.messages]
          .reverse()
          .find((m) => m.role === "user");
        if (lastUser) {
          const text = typeof lastUser.content === "string"
            ? lastUser.content
            : (lastUser.content ?? [])
                .filter((p: { type: string }) => p.type === "text")
                .map((p: { text?: string }) => p.text ?? "")
                .join("\n");
          seenUser.push(text);
        }
        const step = steps[Math.min(i, steps.length - 1)];
        i += 1;
        return {
          role: "assistant",
          content: [
            ...(step.text ? [{ type: "text", text: step.text }] : []),
            ...(step.calls ?? []).map((c) => ({
              type: "toolCall",
              id: c.id ?? `call-${i}`,
              name: c.name,
              arguments: c.arguments ?? {},
            })),
          ],
          api: "anthropic",
          provider: "anthropic",
          model: "fake",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        } as unknown as AssistantMessage;
      },
    },
    seenUser,
    turns: () => i,
  };
}

const LEGACY_STATEACT = "/home/binqiu/osworld-experiments/experiments/stateact-minimal.yaml";
const LEGACY_M3 = "/home/binqiu/osworld-experiments/experiments/m3-single.yaml";

function tmpRunDir(): string {
  return mkdtempSync(path.join(tmpdir(), "piosworld-v2-test-"));
}

function req(partial: Partial<EpisodeRequest>): EpisodeRequest {
  return {
    episodeId: "ep-1",
    role: "main",
    system: "",
    user: "",
    tools: [],
    roundIndex: 1,
    freshPerRound: false,
    task: "Open LibreOffice Calc and set cell A1 to 42",
    observation: { terminal: "user@vm:~$", userResponse: undefined },
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// A3：legacy 运行时桥
// ---------------------------------------------------------------------------

describe("legacy runtime bridge (A3)", () => {
  it("maps stateact legacy spec to old ExperimentConfig", () => {
    const loaded = loadHarnessSpec(LEGACY_STATEACT);
    const legacy = buildLegacyConfig(loaded.spec);
    expect(legacy.topology).toBe("stateact-minimal");
    expect(legacy.models.main).toBe("anthropic/MiniMax-M3");
    expect(legacy.agents.main.tools).toContain("delegate.gui");
    expect(legacy.agents.main.prompt.system).toBe("prompts/roles/main-state-only.md");
    expect(legacy.agents.finish_gate.observation.allow).toContain("state");
    expect(legacy.subagents?.gui.role).toBe("gui");
    expect(legacy.subagents?.gui.terminal_tool).toBe("delegation.complete");
    expect(legacy.llm_retry?.max_retries).toBe(2);
    expect(legacy.termination.max_steps).toBe(500);
  });

  it("fills v2 spec knobs via legacyCompat (A2 spec surface)", () => {
    const loaded = loadHarnessSpec(LEGACY_STATEACT);
    const spec = loaded.spec;
    const main = spec.roles.main;
    expect(main.interior_loop).toBe(true);
    expect(main.terminal_tools).toEqual(["delegate.gui", "finish", "fail", "ask_user"]);
    expect(main.plan_tool).toBe("plan.update");
    expect(main.refresh_state).toBe(true);
    expect(main.message_style).toBe("state_text");
    const gate = spec.roles.finish_gate;
    expect(gate.message_style).toBe("gate");
    expect(gate.terminal_tools).toEqual(["finish_gate.verdict"]);
    expect(gate.read_only).toBe("enforce");
    const gui = spec.roles.gui;
    expect(gui.interior_loop).toBe(true);
    expect(gui.terminal_tools).toEqual(["delegation.complete"]);
    expect(spec.delegations?.[0]).toMatchObject({
      id: "gui",
      from_role: "main",
      tool: "delegate.gui",
      to_role: "gui",
      terminal_tool: "delegation.complete",
    });
    if (spec.loop.driver === "gate_verdict") {
      expect(spec.loop.min_steps_before_finish).toBe(3);
    }
    expect(spec.llm_retry?.max_retries).toBe(2);
  });

  it("maps m3 legacy spec to old ExperimentConfig (raw_task main)", () => {
    const loaded = loadHarnessSpec(LEGACY_M3);
    const spec = loaded.spec;
    expect(spec.loop.driver).toBe("self_report");
    expect(spec.roles.main.message_style).toBe("raw_task");
    const legacy = buildLegacyConfig(spec);
    expect(legacy.topology).toBe("m3-single");
    expect(legacy.agents.main.tools).toContain("computer.pyautogui");
  });
});

// ---------------------------------------------------------------------------
// A4：消息拼法
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

// ---------------------------------------------------------------------------
// A2：PiBackend 行为
// ---------------------------------------------------------------------------

describe("PiBackend (A2)", () => {
  it("main: finish too early is rejected, later accepted (min_steps_before_finish)", async () => {
    const runDir = tmpRunDir();
    try {
      const loaded = loadHarnessSpec(LEGACY_STATEACT);
      const { client, seenUser } = fakeClient([
        { calls: [{ name: "state.bash", arguments: { command: "ls" } }] },
        { calls: [{ name: "finish" }] },
      ]);
      const backend = new PiBackend({
        spec: loaded.spec,
        root: loaded.root,
        resultDir: runDir,
        clientOverrides: { main: client },
      });
      const result = await backend.runEpisode(req({ role: "main", roundIndex: 1 }));
      expect(result.decision?.kind).toBe("execute");
      expect(result.report).toContain("finish rejected too early");
      expect(seenUser[0]).toContain("instruction:");

      // 第二轮：更多非终结步后再 finish
      const { client: c2 } = fakeClient([
        { calls: [{ name: "state.bash", arguments: { command: "ls" } }] },
        { calls: [{ name: "state.bash", arguments: { command: "pwd" } }] },
        { calls: [{ name: "state.bash", arguments: { command: "cat x" } }] },
        { calls: [{ name: "finish" }] },
      ]);
      backend.close();
      const backend2 = new PiBackend({
        spec: loaded.spec,
        root: loaded.root,
        resultDir: runDir,
        clientOverrides: { main: c2 },
      });
      const result2 = await backend2.runEpisode(req({ role: "main", roundIndex: 2 }));
      expect(result2.decision).toEqual({ kind: "done" });
      await backend2.close();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("main: verifier feedback 注入 state_text 消息", async () => {
    const runDir = tmpRunDir();
    try {
      const loaded = loadHarnessSpec(LEGACY_STATEACT);
      const { client, seenUser } = fakeClient([
        { calls: [{ name: "state.bash", arguments: { command: "ls" } }] },
        { calls: [{ name: "finish" }] },
      ]);
      const backend = new PiBackend({
        spec: loaded.spec,
        root: loaded.root,
        resultDir: runDir,
        clientOverrides: { main: client },
      });
      await backend.runEpisode(
        req({
          role: "main",
          roundIndex: 4,
          feedback: "missing section 2; fix and continue",
        }),
      );
      expect(seenUser[0]).toContain("## Verifier feedback");
      expect(seenUser[0]).toContain("missing section 2; fix and continue");
      await backend.close();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("gate: read-only enforced, verdict extracted", async () => {
    const runDir = tmpRunDir();
    try {
      const loaded = loadHarnessSpec(LEGACY_STATEACT);
      const { client } = fakeClient([
        { calls: [{ name: "state.read_file", arguments: { path: "/tmp/out.txt" } }] },
        { calls: [{ name: "finish_gate.verdict", arguments: { accepted: false, feedback: "missing section 2" } }] },
      ]);
      const backend = new PiBackend({
        spec: loaded.spec,
        root: loaded.root,
        resultDir: runDir,
        clientOverrides: { finish_gate: client },
      });
      const result = await backend.runEpisode(
        req({ role: "finish_gate", roundIndex: 5, freshPerRound: true }),
      );
      expect(result.verdict).toEqual({ accepted: false, feedback: "missing section 2" });
      await backend.close();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("delegate.gui runs the gui subagent and reports back", async () => {
    const runDir = tmpRunDir();
    try {
      const loaded = loadHarnessSpec(LEGACY_STATEACT);
      const events: string[] = [];
      const { client: mainClient } = fakeClient([
        { calls: [{ name: "delegate.gui", arguments: { objective: "Inspect the dialog", success_criteria: ["dialog visible"] } }] },
      ]);
      const { client: guiClient, seenUser: guiSeen } = fakeClient([
        { calls: [{ name: "delegation.complete", arguments: { report: "dialog visible with OK button" } }] },
      ]);
      const backend = new PiBackend({
        spec: loaded.spec,
        root: loaded.root,
        resultDir: runDir,
        clientOverrides: { main: mainClient, gui: guiClient },
        emit: (event) => events.push(event),
      });
      const result = await backend.runEpisode(req({ role: "main", roundIndex: 1 }));
      expect(result.decision?.kind).toBe("execute");
      expect(result.report).toContain("dialog visible with OK button");
      expect(events).toContain("delegate.start");
      expect(events).toContain("delegate.end");
      // gui 拿到的是委派子任务文本（不是完整 instruction）
      expect(guiSeen[0]).toContain("delegated subtask: Inspect the dialog");
      expect(guiSeen[0]).toContain("overall instruction:");
      await backend.close();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("m3 main: raw_task message + single step returns actions metadata", async () => {
    const runDir = tmpRunDir();
    try {
      const loaded = loadHarnessSpec(LEGACY_M3);
      const { client, seenUser } = fakeClient([
        { calls: [{ name: "computer.click", arguments: { x: 10, y: 20 } }] },
      ]);
      const backend = new PiBackend({
        spec: loaded.spec,
        root: loaded.root,
        resultDir: runDir,
        clientOverrides: { main: client },
      });
      const result = await backend.runEpisode(
        req({ role: "main", roundIndex: 1, task: "Open the calculator" }),
      );
      expect(seenUser[0]).toBe("Open the calculator");
      expect(Array.isArray(result.metadata?.actions)).toBe(true);
      await backend.close();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
