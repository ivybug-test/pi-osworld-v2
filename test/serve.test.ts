import { describe, expect, it } from "vitest";
import type { HarnessSpec } from "../src/config/spec.js";
import { MemoryTaskStateStore } from "../src/engine/taskState.js";
import { Runtime } from "../src/engine/runtime.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import { MockBackend } from "../src/backends/mock.js";
import { summaryToStepOutput } from "../src/serve.js";
import type { EpisodeSummary } from "../src/engine/types.js";

function makeSpec(loop: unknown): HarnessSpec {
  return {
    experiment: "t",
    benchmark: { name: "osworld-v2", release: "x" },
    task_set: "task-sets/smoke.yaml",
    models: { main: "anthropic/x" },
    roles: {
      main: {
        backend: "mock",
        model: "main",
        prompt: { system: "m.md" },
        observation: { allow: ["state"] },
        tools: [],
        receives: ["task"],
        read_only: "none",
      },
    },
    loop: loop as HarnessSpec["loop"],
    state: { schema: ["requirements"], store: "memory", update_policy: "self_report" },
  };
}

describe("serve: summaryToStepOutput", () => {
  const base: EpisodeSummary = {
    episodeId: "e",
    state: {
      goal: "g",
      requirements: [],
      artifacts: [],
      facts: [],
      rounds: [],
    },
    outcome: { kind: "execute" },
    rounds: 0,
  };

  it("execute → WAIT（无 actions）", () => {
    const out = summaryToStepOutput(base);
    expect(out.actions).toEqual(["WAIT"]);
  });

  it("execute + metadata.actions → 原样返回（m3 驱动 env.step）", () => {
    const out = summaryToStepOutput({
      ...base,
      state: {
        ...base.state,
        rounds: [
          {
            index: 1,
            decision: { kind: "execute" },
            metadata: { actions: ["click(10, 20)", "type('hi')"] },
          },
        ],
      },
    });
    expect(out.actions).toEqual(["click(10, 20)", "type('hi')"]);
  });

  it("done → DONE；blocked → FAIL；ask → 问题 + 无动作", () => {
    expect(summaryToStepOutput({ ...base, outcome: { kind: "done" } }).actions).toEqual(["DONE"]);
    expect(
      summaryToStepOutput({ ...base, outcome: { kind: "blocked", reason: "no" } }).actions,
    ).toEqual(["FAIL"]);
    const ask = summaryToStepOutput({ ...base, outcome: { kind: "ask", question: "which?" } });
    expect(ask.actions).toEqual([]);
    expect(ask.response).toBe("which?");
  });
});

describe("serve: roundLimit + resume（step 驱动）", () => {
  it("每次 roundLimit=1 跑一轮，状态跨 predict 延续", async () => {
    const spec = makeSpec({
      driver: "self_report",
      role: "main",
      done_tool: "computer.done",
      max_rounds: 30,
    });
    const stateStore = new MemoryTaskStateStore();
    const backend = new MockBackend({
      behaviors: {
        main: [
          { type: "decision", decision: { kind: "execute" } },
          { type: "decision", decision: { kind: "execute" } },
          { type: "decision", decision: { kind: "done" } },
        ],
      },
    });
    const runtime = new Runtime({
      spec,
      root: ".",
      backends: { main: backend },
      stateStore,
    });
    const orchestrator = new Orchestrator(spec, { runtime });

    const s1 = await orchestrator.runEpisode({ episodeId: "ep", task: "t", roundLimit: 1 });
    expect(s1.outcome.kind).toBe("execute");
    expect(s1.rounds).toBe(1);

    const s2 = await orchestrator.runEpisode({ episodeId: "ep", task: "t", roundLimit: 1 });
    expect(s2.outcome.kind).toBe("execute");
    expect(s2.rounds).toBe(2);

    const s3 = await orchestrator.runEpisode({ episodeId: "ep", task: "t", roundLimit: 1 });
    expect(s3.outcome.kind).toBe("done");
    expect(s3.rounds).toBe(3);
  });

  it("reset 清空状态后可重跑同一 episode", async () => {
    const spec = makeSpec({
      driver: "self_report",
      role: "main",
      done_tool: "computer.done",
      max_rounds: 30,
    });
    const stateStore = new MemoryTaskStateStore();
    const backend = new MockBackend({ behaviors: { main: { type: "decision", decision: { kind: "done" } } } });
    const runtime = new Runtime({ spec, root: ".", backends: { main: backend }, stateStore });
    const orchestrator = new Orchestrator(spec, { runtime });

    const s1 = await orchestrator.runEpisode({ episodeId: "ep", task: "t", roundLimit: 1 });
    expect(s1.rounds).toBe(1);
    await stateStore.clear("ep");
    const s2 = await orchestrator.runEpisode({ episodeId: "ep", task: "t", roundLimit: 1 });
    expect(s2.rounds).toBe(1);
  });
});
