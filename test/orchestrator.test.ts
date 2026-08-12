import { describe, expect, it } from "vitest";
import { HarnessSpec, type HarnessSpec as HarnessSpecT } from "../src/config/spec.js";
import { MockBackend, mockAudit, mockDone, mockExecute } from "../src/backends/mock.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import { Runtime } from "../src/engine/runtime.js";
import { MemoryTaskStateStore } from "../src/engine/taskState.js";
import { RecordingDebugger } from "../src/engine/debugger.js";
import type { MockStep } from "../src/backends/mock.js";

function makeSpec(partial: Partial<HarnessSpecT>): HarnessSpecT {
  return HarnessSpec.parse({
    experiment: "test",
    benchmark: { name: "osworld-v2", release: "r" },
    task_set: "ts.yaml",
    models: { main: "m", manager: "m", executor: "m", auditor: "m" },
    roles: {
      manager: {
        backend: "mock",
        read_only: "none",
        model: "manager",
        prompt: { system: "manager.md" },
        observation: { allow: ["state"] },
        tools: [],
        receives: ["task", "task_state", "audit_history"],
      },
      main: {
        backend: "mock",
        read_only: "none",
        model: "main",
        prompt: { system: "main.md" },
        observation: { allow: ["state"] },
        tools: ["state.bash"],
        receives: ["task"],
      },
      executor: {
        backend: "mock",
        read_only: "none",
        model: "executor",
        prompt: { system: "executor.md" },
        observation: { allow: ["state"] },
        context: { fresh_per_round: true },
        tools: ["state.bash"],
        receives: ["task", "contract"],
      },
      auditor: {
        backend: "mock",
        model: "auditor",
        prompt: { system: "auditor.md" },
        observation: { allow: ["state"] },
        tools: ["state.inspect_ro"],
        receives: ["task", "contract", "executor_report"],
        read_only: "enforce",
      },
    },
    loop: {
      driver: "manager_decision",
      decision_tool: "manager.decide",
      contract: {
        produced_by: "manager",
        fields: ["goal", "acceptance_criteria", "target"],
      },
      routing: { gui: "executor", cli: "executor" },
      max_rounds: 25,
    },
    state: { schema: ["requirements"], store: "memory", update_policy: "audit_verified" },
    ...partial,
  });
}

async function run(spec: HarnessSpecT, behaviors: Record<string, MockStep[] | MockStep>) {
  const backend = new MockBackend({ behaviors });
  const backends: Record<string, MockBackend> = {};
  for (const r of Object.keys(spec.roles)) backends[r] = backend;
  const store = new MemoryTaskStateStore();
  const dbg = new RecordingDebugger();
  const events: Array<[string, Record<string, unknown>]> = [];
  const runtime = new Runtime({
    spec,
    root: "/tmp",
    backends,
    stateStore: store,
    debugger: dbg,
    emit: (e, a) => events.push([e, a]),
  });
  const orch = new Orchestrator(spec, { runtime, debugger: dbg });
  const summary = await orch.runEpisode({
    episodeId: "ep-1",
    task: "do the thing",
  });
  return { summary, dbg, events, store };
}

describe("Orchestrator drivers", () => {
  it("self_report: 单角色自报完成 → done", async () => {
    const spec = makeSpec({
      roles: {
        main: {
          backend: "mock",
          read_only: "none",
          model: "main",
          prompt: { system: "m.md" },
          observation: { allow: ["state"] },
          tools: ["state.bash"],
          receives: ["task"],
        },
      },
      loop: { driver: "self_report", role: "main", done_tool: "computer.done", max_rounds: 30 },
      state: { schema: ["requirements"], store: "memory", update_policy: "self_report" },
    });
    const { summary } = await run(spec, { main: mockDone("finished") });
    expect(summary.outcome.kind).toBe("done");
    expect(summary.rounds).toBe(1);
  });

  it("gate_verdict: 拒绝一次后接受 → done，反馈注入第二轮", async () => {
    const spec = makeSpec({
      roles: {
        main: {
          backend: "mock",
          read_only: "none",
          model: "main",
          prompt: { system: "m.md" },
          observation: { allow: ["state"] },
          tools: ["state.bash"],
          receives: ["task"],
        },
        finish_gate: {
          backend: "mock",
          model: "finish_gate",
          prompt: { system: "g.md" },
          observation: { allow: ["state"] },
          tools: ["state.inspect_ro"],
          receives: ["task", "contract", "executor_report"],
          read_only: "enforce",
        },
      },
      gates: { finish: { role: "finish_gate", verdict_tool: "finish_gate.verdict", fresh_context: true } },
      loop: { driver: "gate_verdict", gate: "finish", feedback_to: "main", max_rounds: 3, total_rounds: 10 },
      state: { schema: ["requirements"], store: "memory", update_policy: "self_report" },
    });
    const { summary, dbg } = await run(spec, {
      main: [mockDone("finished")],
      finish_gate: [
        { type: "verdict", accepted: false, feedback: "artifact missing field X" },
        { type: "verdict", accepted: true },
      ],
    });
    expect(summary.outcome.kind).toBe("done");
    expect(summary.rounds).toBe(2);
    // 第二轮 main 收到 feedback（在 role.start 事件里可验证 user 内容）
    const secondMain = dbg.events.find(
      (e) => e.type === "role.start" && e.role === "main" && e.round === 2,
    );
    expect(secondMain).toBeDefined();
    if (secondMain?.type === "role.start") {
      expect(secondMain.req.user).toContain("Verifier feedback");
      expect(secondMain.req.user).toContain("artifact missing field X");
    }
  });

  it("gate_verdict: 拒绝达上限 → on_gate_exhausted=done 放行", async () => {
    const spec = makeSpec({
      roles: {
        main: {
          backend: "mock",
          read_only: "none",
          model: "main",
          prompt: { system: "m.md" },
          observation: { allow: ["state"] },
          tools: ["state.bash"],
          receives: ["task"],
        },
        finish_gate: {
          backend: "mock",
          model: "finish_gate",
          prompt: { system: "g.md" },
          observation: { allow: ["state"] },
          tools: ["state.inspect_ro"],
          receives: ["task", "contract", "executor_report"],
          read_only: "enforce",
        },
      },
      gates: { finish: { role: "finish_gate", verdict_tool: "finish_gate.verdict", fresh_context: true } },
      loop: { driver: "gate_verdict", gate: "finish", feedback_to: "main", max_rounds: 2, total_rounds: 10, on_gate_exhausted: "done" },
      state: { schema: ["requirements"], store: "memory", update_policy: "self_report" },
    });
    const { summary } = await run(spec, {
      main: mockDone("finished"),
      finish_gate: { type: "verdict", accepted: false, feedback: "no" },
    });
    expect(summary.outcome.kind).toBe("done");
    expect(summary.rounds).toBe(2); // 两次拒绝后放行
  });

  it("gate_verdict: 拒绝达上限默认 blocked（对齐旧 stateact FAIL）", async () => {
    const spec = makeSpec({
      roles: {
        main: {
          backend: "mock",
          read_only: "none",
          model: "main",
          prompt: { system: "m.md" },
          observation: { allow: ["state"] },
          tools: ["state.bash"],
          receives: ["task"],
        },
        finish_gate: {
          backend: "mock",
          model: "finish_gate",
          prompt: { system: "g.md" },
          observation: { allow: ["state"] },
          tools: ["state.inspect_ro"],
          receives: ["task", "contract", "executor_report"],
          read_only: "enforce",
        },
      },
      gates: { finish: { role: "finish_gate", verdict_tool: "finish_gate.verdict", fresh_context: true } },
      loop: { driver: "gate_verdict", gate: "finish", feedback_to: "main", max_rounds: 2, total_rounds: 10 },
      state: { schema: ["requirements"], store: "memory", update_policy: "self_report" },
    });
    const { summary } = await run(spec, {
      main: mockDone("finished"),
      finish_gate: { type: "verdict", accepted: false, feedback: "no" },
    });
    expect(summary.outcome).toEqual({ kind: "blocked", reason: "finish gate exhausted" });
  });

  it("gate_verdict: serve roundLimit=1 跨 predict 累计拒绝并恢复 feedback", async () => {
    const spec = makeSpec({
      roles: {
        main: {
          backend: "mock",
          read_only: "none",
          model: "main",
          prompt: { system: "m.md" },
          observation: { allow: ["state"] },
          tools: ["state.bash"],
          receives: ["task"],
        },
        finish_gate: {
          backend: "mock",
          model: "finish_gate",
          prompt: { system: "g.md" },
          observation: { allow: ["state"] },
          tools: ["state.inspect_ro"],
          receives: ["task", "contract", "executor_report"],
          read_only: "enforce",
        },
      },
      gates: { finish: { role: "finish_gate", verdict_tool: "finish_gate.verdict", fresh_context: true } },
      loop: {
        driver: "gate_verdict",
        gate: "finish",
        feedback_to: "main",
        max_rounds: 2,
        total_rounds: 10,
        on_gate_exhausted: "blocked",
      },
      state: { schema: ["requirements"], store: "memory", update_policy: "self_report" },
    });
    const backend = new MockBackend({
      behaviors: {
        main: mockDone("finished"),
        finish_gate: { type: "verdict", accepted: false, feedback: "artifact missing field X" },
      },
    });
    const store = new MemoryTaskStateStore();
    const dbg = new RecordingDebugger();
    const runtime = new Runtime({
      spec,
      root: "/tmp",
      backends: { main: backend, finish_gate: backend },
      stateStore: store,
      debugger: dbg,
    });
    const orch = new Orchestrator(spec, { runtime, debugger: dbg });

    const s1 = await orch.runEpisode({ episodeId: "ep-1", task: "do the thing", roundLimit: 1 });
    expect(s1.outcome.kind).toBe("execute");
    const s2 = await orch.runEpisode({ episodeId: "ep-1", task: "do the thing", roundLimit: 1 });
    expect(s2.outcome).toEqual({ kind: "blocked", reason: "finish gate exhausted" });
    expect(s2.state.gate?.rejections).toBe(2);

    // 第二轮 main 应收到上一 predict 持久化的 gate feedback
    const secondMain = dbg.events.find(
      (e) => e.type === "role.start" && e.role === "main" && e.round === 2,
    );
    expect(secondMain).toBeDefined();
    if (secondMain?.type === "role.start") {
      expect(secondMain.req.user).toContain("artifact missing field X");
    }
  });

  it("manager_decision: execute → executor → auditor clean → 第二轮 manager done", async () => {
    const spec = makeSpec({});
    const { summary, store } = await run(spec, {
      manager: [mockExecute("do the thing", "cli"), mockDone("all satisfied")],
      executor: { type: "report", report: "executed" },
      auditor: mockAudit("complete", "clean"),
    });
    expect(summary.outcome.kind).toBe("done");
    expect(summary.rounds).toBe(2);
    const state = await store.read("ep-1");
    expect(state?.requirements[0].status).toBe("completed");
    expect(state?.requirements[0].evidence.length).toBeGreaterThan(0);
    expect(summary.state.rounds.length).toBe(2);
    expect(summary.state.rounds[0].contract?.goal).toBe("do the thing");
    expect(summary.state.rounds[0].auditReport?.integrity).toBe("clean");
  });

  it("manager_decision: auditor violation → requirement untrusted", async () => {
    const spec = makeSpec({});
    const { summary } = await run(spec, {
      manager: [mockExecute("do the thing", "cli"), mockDone("all satisfied")],
      executor: { type: "report", report: "executed" },
      auditor: mockAudit("complete", "violation", [], []),
    });
    expect(summary.outcome.kind).toBe("done");
    expect(summary.state.requirements[0].status).toBe("untrusted");
  });

  it("manager_decision: blocked → 终止", async () => {
    const spec = makeSpec({});
    const { summary } = await run(spec, {
      manager: { type: "decision", decision: { kind: "blocked", reason: "no way" } },
    });
    expect(summary.outcome).toEqual({ kind: "blocked", reason: "no way" });
    expect(summary.rounds).toBe(1);
  });

  it("gate_verdict + audit_every: 周期审计触发、反馈注入 main、报告挂轮次记录", async () => {
    const spec = makeSpec({
      models: { main: "m", finish_gate: "m", auditor: "m" },
      roles: {
        main: {
          backend: "mock",
          read_only: "none",
          model: "main",
          prompt: { system: "m.md" },
          observation: { allow: ["state"] },
          tools: ["state.bash"],
          receives: ["task"],
        },
        finish_gate: {
          backend: "mock",
          model: "finish_gate",
          prompt: { system: "g.md" },
          observation: { allow: ["state"] },
          tools: ["state.inspect_ro"],
          receives: ["task", "contract", "executor_report"],
          read_only: "enforce",
        },
        auditor: {
          backend: "mock",
          model: "auditor",
          prompt: { system: "a.md" },
          observation: { allow: ["state"] },
          tools: ["state.inspect_ro"],
          receives: ["task", "task_state", "audit_history", "progress_snapshot", "env_state"],
          read_only: "enforce",
        },
      },
      gates: { finish: { role: "finish_gate", verdict_tool: "finish_gate.verdict", fresh_context: true } },
      loop: { driver: "gate_verdict", gate: "finish", feedback_to: "main", max_rounds: 3, total_rounds: 6, audit_every: 2, audit_role: "auditor" },
      state: { schema: ["requirements"], store: "memory", update_policy: "self_report" },
    });
    const { summary, dbg, store } = await run(spec, {
      main: [mockExecute("work"), mockExecute("work"), mockDone("finished")],
      finish_gate: { type: "verdict", accepted: true },
      auditor: mockAudit("incomplete", "clean", ["no artifact yet"]),
    });
    expect(summary.outcome.kind).toBe("done");
    expect(summary.rounds).toBe(3);

    // 只在 audit_every 间隔轮触发审计（round 2），round 1 不触发
    const auditRuns = dbg.events.filter(
      (e) => e.type === "role.start" && e.role === "auditor",
    );
    expect(auditRuns).toHaveLength(1);
    if (auditRuns[0]?.type === "role.start") {
      expect(auditRuns[0].round).toBe(2);
      expect(auditRuns[0].req.user).toContain("## Progress snapshot");
      expect(auditRuns[0].req.user).toContain("rounds executed: 1");
    }

    // 审计反馈注入 main 本轮消息；round 1 无审计反馈
    const secondMain = dbg.events.find(
      (e) => e.type === "role.start" && e.role === "main" && e.round === 2,
    );
    expect(secondMain).toBeDefined();
    if (secondMain?.type === "role.start") {
      expect(secondMain.req.user).toContain("## Progress audit");
      expect(secondMain.req.user).toContain("no artifact yet");
    }
    const firstMain = dbg.events.find(
      (e) => e.type === "role.start" && e.role === "main" && e.round === 1,
    );
    expect(firstMain?.type === "role.start").toBe(true);
    if (firstMain?.type === "role.start") {
      expect(firstMain.req.user).not.toContain("## Progress audit");
    }

    // 审计报告挂在 round 2 轮次记录，并持久化到 state.audit
    const state = await store.read("ep-1");
    expect(state?.rounds[1].auditReport?.completion).toBe("incomplete");
    expect(state?.audit?.lastRound).toBe(2);
  });

  it("gate_verdict + audit_every: serve roundLimit=1 跨 predict 不重复注入", async () => {
    const spec = makeSpec({
      models: { main: "m", finish_gate: "m", auditor: "m" },
      roles: {
        main: {
          backend: "mock",
          read_only: "none",
          model: "main",
          prompt: { system: "m.md" },
          observation: { allow: ["state"] },
          tools: ["state.bash"],
          receives: ["task"],
        },
        finish_gate: {
          backend: "mock",
          model: "finish_gate",
          prompt: { system: "g.md" },
          observation: { allow: ["state"] },
          tools: ["state.inspect_ro"],
          receives: ["task", "contract", "executor_report"],
          read_only: "enforce",
        },
        auditor: {
          backend: "mock",
          model: "auditor",
          prompt: { system: "a.md" },
          observation: { allow: ["state"] },
          tools: ["state.inspect_ro"],
          receives: ["task", "task_state", "audit_history", "progress_snapshot", "env_state"],
          read_only: "enforce",
        },
      },
      gates: { finish: { role: "finish_gate", verdict_tool: "finish_gate.verdict", fresh_context: true } },
      loop: { driver: "gate_verdict", gate: "finish", feedback_to: "main", max_rounds: 3, total_rounds: 6, audit_every: 2, audit_role: "auditor" },
      state: { schema: ["requirements"], store: "memory", update_policy: "self_report" },
    });
    const backend = new MockBackend({
      behaviors: {
        main: [mockExecute("work"), mockExecute("work"), mockDone("finished")],
        finish_gate: { type: "verdict", accepted: true },
        auditor: mockAudit("incomplete", "clean", ["no artifact yet"]),
      },
    });
    const store = new MemoryTaskStateStore();
    const dbg = new RecordingDebugger();
    const runtime = new Runtime({
      spec,
      root: "/tmp",
      backends: { main: backend, finish_gate: backend, auditor: backend },
      stateStore: store,
      debugger: dbg,
    });
    const orch = new Orchestrator(spec, { runtime, debugger: dbg });

    const s1 = await orch.runEpisode({ episodeId: "ep-1", task: "do the thing", roundLimit: 1 });
    expect(s1.outcome.kind).toBe("execute");
    expect(s1.state.rounds.length).toBe(1);

    const s2 = await orch.runEpisode({ episodeId: "ep-1", task: "do the thing", roundLimit: 1 });
    expect(s2.outcome.kind).toBe("execute");
    expect(s2.state.rounds.length).toBe(2);
    expect(s2.state.audit?.lastRound).toBe(2);
    expect(s2.state.rounds[1].auditReport?.completion).toBe("incomplete");

    const s3 = await orch.runEpisode({ episodeId: "ep-1", task: "do the thing", roundLimit: 1 });
    expect(s3.outcome).toEqual({ kind: "done" });
    expect(s3.state.rounds.length).toBe(3);
    // 审计反馈只注入 round 2；round 3 的 main 不再看到（已消费清除）
    const round3Main = dbg.events.find(
      (e) => e.type === "role.start" && e.role === "main" && e.round === 3,
    );
    expect(round3Main).toBeDefined();
    if (round3Main?.type === "role.start") {
      expect(round3Main.req.user).not.toContain("## Progress audit");
    }
    expect(s3.state.audit?.feedback).toBeUndefined();
  });
});
