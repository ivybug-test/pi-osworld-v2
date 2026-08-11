import { describe, expect, it } from "vitest";
import { RecordingDebugger } from "../src/engine/debugger.js";
import { summarizeRounds, formatReplay, loadEvents } from "../src/replay.js";
import type { ReplayEvent } from "../src/replay.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("RecordingDebugger", () => {
  it("收集 round/role 事件", async () => {
    const dbg = new RecordingDebugger();
    await dbg.onRoundStart({ episodeId: "e", index: 1, state: { goal: "g", requirements: [], artifacts: [], facts: [], rounds: [] } });
    await dbg.onRoleStart("manager", { role: "manager", system: "s", user: "u", tools: [], roundIndex: 1, freshPerRound: false });
    await dbg.onRoleEnd("manager", { status: "done" });
    await dbg.onRoundEnd({ episodeId: "e", index: 1, state: { goal: "g", requirements: [], artifacts: [], facts: [], rounds: [] } }, { kind: "execute" });
    expect(dbg.events.map((e) => e.type)).toEqual([
      "round.start",
      "role.start",
      "role.end",
      "round.end",
    ]);
  });
});

describe("replay", () => {
  const events: ReplayEvent[] = [
    { timestamp: 1, event: "round.start", round: 1, episodeId: "e" },
    { timestamp: 2, event: "role.start", round: 1, role: "manager", episodeId: "e" },
    { timestamp: 3, event: "role.end", round: 1, role: "manager", status: "done", episodeId: "e" },
    { timestamp: 4, event: "round.decision", round: 1, outcome: "execute", episodeId: "e" },
    { timestamp: 5, event: "round.start", round: 2, episodeId: "e" },
    { timestamp: 6, event: "round.decision", round: 2, outcome: "done", episodeId: "e" },
  ];

  it("summarizeRounds 聚合轮次结构", () => {
    const rounds = summarizeRounds(events);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({ round: 1, outcome: "execute" });
    expect(rounds[0].roles).toEqual([{ role: "manager", status: "done" }]);
    expect(rounds[1].outcome).toBe("done");
  });

  it("formatReplay 输出可读文本", () => {
    const text = formatReplay(summarizeRounds(events));
    expect(text).toContain("round 1");
    expect(text).toContain("manager:done");
    expect(text).toContain("round 2");
  });

  it("loadEvents 从 events.jsonl 读取", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "piosworld-replay-"));
    writeFileSync(
      path.join(dir, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n"),
      "utf8",
    );
    const loaded = loadEvents(dir);
    expect(loaded).toHaveLength(events.length);
    expect(loaded[0].event).toBe("round.start");
    rmSync(dir, { recursive: true, force: true });
  });
});
