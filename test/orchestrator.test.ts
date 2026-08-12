import { describe, expect, it } from "vitest";
import { HarnessSpec, type HarnessSpec as HarnessSpecT } from "../src/config/spec.js";
import { MockBackend, mockAudit, mockDone, mockExecute } from "../src/backends/mock.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import { Runtime, serializeSource } from "../src/engine/runtime.js";
import { createTaskState, MemoryTaskStateStore } from "../src/engine/taskState.js";
import { RecordingDebugger } from "../src/engine/debugger.js";
import type { MockStep } from "../src/backends/mock.js";
import type { RoundContext } from "../src/engine/types.js";

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
  return { summary, dbg, events, store, backend };
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
          receives: ["task", "task_state", "audit_history", "progress_snapshot", "main_activity", "env_state"],
          read_only: "enforce",
        },
      },
      gates: { finish: { role: "finish_gate", verdict_tool: "finish_gate.verdict", fresh_context: true } },
      loop: { driver: "gate_verdict", gate: "finish", feedback_to: "main", max_rounds: 3, total_rounds: 6, audit_every: 2, audit_role: "auditor" },
      state: { schema: ["requirements"], store: "memory", update_policy: "self_report" },
    });
    const { summary, dbg, store, backend } = await run(spec, {
      main: [mockExecute("work"), mockExecute("work"), mockDone("finished")],
      finish_gate: { type: "verdict", accepted: true },
      auditor: mockAudit("incomplete", "clean", ["no artifact yet"], [], ["open thunderbird"]),
    });
    expect(summary.outcome.kind).toBe("done");
    expect(summary.rounds).toBe(3);

    // turn 基触发：main 每 2 次模型调用审一次 → round 2（turn 2）触发，round 1（turn 1）不触发
    const auditRuns = dbg.events.filter(
      (e) => e.type === "role.start" && e.role === "auditor",
    );
    expect(auditRuns).toHaveLength(1);
    if (auditRuns[0]?.type === "role.start") {
      expect(auditRuns[0].round).toBe(2);
      expect(auditRuns[0].req.user).toContain("## Progress snapshot");
      expect(auditRuns[0].req.user).toContain("rounds executed: 1");
      // main 活动日志已喂给 auditor（不再是"什么都没看到"）
      expect(auditRuns[0].req.user).toContain("## Main activity");
      expect(auditRuns[0].req.user).toContain("turn 2");
    }

    // 审计在本轮 main 进行中（turn 2）触发：反馈不再拼进下一轮 main 的 user 消息，
    // 而是经 FeedbackInjector 注入上下文。round 2 在审计触发的同一 turn 结束
    // （缓冲未消费），反馈 seed 到 round 3 的 episode 缓冲并在首次模型调用前交付。
    const secondMain = dbg.events.find(
      (e) => e.type === "role.start" && e.role === "main" && e.round === 2,
    );
    expect(secondMain).toBeDefined();
    if (secondMain?.type === "role.start") {
      expect(secondMain.req.user).not.toContain("## Progress audit");
    }
    const firstMain = dbg.events.find(
      (e) => e.type === "role.start" && e.role === "main" && e.round === 1,
    );
    expect(firstMain?.type === "role.start").toBe(true);
    if (firstMain?.type === "role.start") {
      expect(firstMain.req.user).not.toContain("## Progress audit");
    }
    const thirdMain = dbg.events.find(
      (e) => e.type === "role.start" && e.role === "main" && e.round === 3,
    );
    expect(thirdMain).toBeDefined();
    if (thirdMain?.type === "role.start") {
      expect(thirdMain.req.user).not.toContain("## Progress audit");
    }
    // 注入缓冲记录：round 3 首次模型调用前交付审计反馈（含 header）
    const delivered = backend.injectedFeedback["ep-1"] ?? [];
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("## Progress audit");
    expect(delivered[0]).toContain("no artifact yet");

    // 审计报告挂在 round 2 轮次记录，并持久化到 state.audit；
    // round 3 消费后清除持久化字段（避免 serve 下一 predict 重复注入）
    const state = await store.read("ep-1");
    expect(state?.rounds[1].auditReport?.completion).toBe("incomplete");
    expect(state?.audit?.lastRound).toBe(2);
    expect(state?.audit?.lastAuditTurns).toBe(2);
    expect(state?.audit?.feedback).toBeUndefined();
    // next_goals 结构化持久化，供下一次审计逐条核对
    expect(state?.audit?.report?.nextGoals).toEqual(["open thunderbird"]);
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
    // round 2 内（turn 2）触发审计：round 2 的 episode 在审计触发的同一 turn 结束，
    // 缓冲未消费 → 持久化保留；round 3 predict 开始时 seed 进新缓冲，首次模型调用前
    // 交付一次，消费后清除持久化字段 → 全程只注入一次（不重复）。
    const round2Main = dbg.events.find(
      (e) => e.type === "role.start" && e.role === "main" && e.round === 2,
    );
    expect(round2Main).toBeDefined();
    if (round2Main?.type === "role.start") {
      expect(round2Main.req.user).not.toContain("## Progress audit");
    }
    const round3Main = dbg.events.find(
      (e) => e.type === "role.start" && e.role === "main" && e.round === 3,
    );
    expect(round3Main).toBeDefined();
    if (round3Main?.type === "role.start") {
      expect(round3Main.req.user).not.toContain("## Progress audit");
    }
    const delivered = backend.injectedFeedback["ep-1"] ?? [];
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("## Progress audit");
    expect(delivered[0]).toContain("no artifact yet");
    expect(s3.state.audit?.feedback).toBeUndefined();
  });

  it("gate_verdict + audit_every: 同一 round 内按 main turn 多次触发审计", async () => {
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
          receives: ["task", "task_state", "audit_history", "progress_snapshot", "main_activity", "env_state"],
          read_only: "enforce",
        },
      },
      gates: { finish: { role: "finish_gate", verdict_tool: "finish_gate.verdict", fresh_context: true } },
      loop: { driver: "gate_verdict", gate: "finish", feedback_to: "main", max_rounds: 3, total_rounds: 6, audit_every: 2, audit_role: "auditor" },
      state: { schema: ["requirements"], store: "memory", update_policy: "self_report" },
    });
    const { summary, dbg, store, backend } = await run(spec, {
      main: [
        { type: "decision", decision: { kind: "done", reason: "finished" }, turns: 4 },
      ],
      finish_gate: { type: "verdict", accepted: true },
      auditor: mockAudit("incomplete", "clean", ["no artifact yet"], [], ["write calendar.ics"]),
    });
    expect(summary.outcome.kind).toBe("done");
    expect(summary.rounds).toBe(1);

    // 4 次 main 调用内 audit_every=2 → turn 2、turn 4 各触发一次（同 round 内）
    const auditRuns = dbg.events.filter(
      (e) => e.type === "role.start" && e.role === "auditor",
    );
    expect(auditRuns).toHaveLength(2);
    // 第二次审计（turn 4）应看到第一次审计（turn 2）留下的 next_goals，形成核对闭环
    const secondAudit = auditRuns[1];
    expect(secondAudit?.type === "role.start").toBe(true);
    if (secondAudit?.type === "role.start") {
      expect(secondAudit.req.user).toContain("Goals from last audit (check each):");
      expect(secondAudit.req.user).toContain("- write calendar.ics");
    }
    const state = await store.read("ep-1");
    expect(state?.audit?.lastAuditTurns).toBe(4);
    expect(state?.audit?.lastRound).toBe(1);
    expect(state?.rounds[0].auditReport?.completion).toBe("incomplete");
    expect(state?.audit?.report?.nextGoals).toEqual(["write calendar.ics"]);
    // 同轮注入：turn 2 的反馈在 turn 3 模型调用前交付；turn 4 的反馈在 episode
    // 结束时仍待注入（缓冲未消费）→ 保留持久化，下一轮 seed 时再交付
    const delivered = backend.injectedFeedback["ep-1"] ?? [];
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("## Progress audit");
    expect(state?.audit?.feedback).toContain("## Progress audit");
  });
});

describe("audit evidence & main activity sources", () => {
  const state = createTaskState("do the thing", ["requirements"]);
  state.audit = {
    lastRound: 1,
    lastAuditTurns: 5,
    report: {
      roundId: "round-1",
      completion: "incomplete",
      integrity: "clean",
      contractAudit: "aligned",
      verifiedFacts: [],
      gaps: ["no artifact yet"],
      evidence: [],
      nextGoals: ["open thunderbird", "parse xlsx"],
      feedback: "open thunderbird",
    },
    feedback: "## Progress audit\nopen thunderbird",
  };
  const ctx: RoundContext = { episodeId: "ep-1", index: 1, state };

  it("main_activity 序列化最近 turn（工具名+文本）", () => {
    const out = serializeSource("main_activity", ctx, {}, [
      { turn: 1, text: "locate state", tools: ["state.bash"] },
      { turn: 2, text: "parsed xlsx, found 7 defenses", tools: ["state.python"] },
    ]);
    expect(out).toContain("## Main activity");
    expect(out).toContain("- turn 1: locate state [tools: state.bash]");
    expect(out).toContain("- turn 2: parsed xlsx, found 7 defenses [tools: state.python]");
  });

  it("main_activity 空时显示 (none yet)", () => {
    expect(serializeSource("main_activity", ctx, {})).toContain("(none yet)");
  });

  it("audit_history 包含上轮 goals/feedback 正文（auditor 据此核对达成度）", () => {
    const out = serializeSource("audit_history", ctx, {});
    expect(out).toContain("Goals from last audit (check each):");
    expect(out).toContain("- open thunderbird");
    expect(out).toContain("- parse xlsx");
    expect(out).toContain("feedback: open thunderbird");
  });

  it("audit_evidence 把 verified facts/gaps/goals 提供给 finish gate", () => {
    const out = serializeSource("audit_evidence", ctx, {});
    expect(out).toContain("## Audit evidence");
    expect(out).toContain("latest audit (round 1): incomplete/clean");
    expect(out).toContain("gaps:");
    expect(out).toContain("- no artifact yet");
    expect(out).toContain("goals for main:");
    expect(out).toContain("- open thunderbird");
  });
});
