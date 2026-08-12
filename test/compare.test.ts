import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatCompare,
  loadRunCompare,
  resolveRunDirs,
} from "../src/cli/compare.js";

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "piosworld-v2-compare-"));
}

function write(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

describe("compare", () => {
  it("loads finished stateact run metrics from run dir", () => {
    const dir = tmpDir();
    try {
      write(
        dir,
        "runner.log",
        "experiment=stateact-minimal topology=gate_verdict tasks=['004']\n",
      );
      write(
        dir,
        "summary/results.json",
        JSON.stringify([
          { application: "gate_verdict", task_id: "004", status: "success", score: 0.3667 },
        ]),
      );
      write(dir, "gate_verdict/004/traj.jsonl", "a\nb\nc\n");
      write(
        dir,
        "events.jsonl",
        [
          JSON.stringify({ timestamp: 1, event: "delegate.start", agent: "gui" }),
          JSON.stringify({ timestamp: 2, event: "finish_gate.result", accepted: false, rounds: 1 }),
          JSON.stringify({ timestamp: 3, event: "finish_gate.result", accepted: true, rounds: 2 }),
        ].join("\n") + "\n",
      );

      const run = loadRunCompare(dir);
      expect(run.experiment).toBe("stateact-minimal");
      expect(run.topology).toBe("gate_verdict");
      expect(run.finished).toBe(true);
      expect(run.tasks).toEqual([
        { taskId: "004", score: 0.3667, status: "success" },
      ]);
      expect(run.steps).toBe(3);
      expect(run.delegates).toBe(1);
      expect(run.gateResults).toEqual([
        { accepted: false, rounds: 1 },
        { accepted: true, rounds: 2 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers manifest.json over runner.log for run identity", () => {
    const dir = tmpDir();
    try {
      write(
        dir,
        "manifest.json",
        JSON.stringify({
          run_id: "20260811T075723-stateact-minimal-gate_verdict",
          experiment: "stateact-minimal",
          topology: "gate_verdict",
          task_set: "task-sets/smoke.yaml",
          max_steps: 500,
          start_time: "2026-08-11T07:57:23",
          config: "/home/binqiu/pi-osworld-v2/presets/stateact.yaml",
          tasks: ["004"],
        }),
      );
      write(dir, "runner.log", "run_dir=/some/other/path max_steps=500\n");
      write(
        dir,
        "summary/results.json",
        JSON.stringify([{ task_id: "004", status: "success", score: 0.5 }]),
      );
      const run = loadRunCompare(dir);
      expect(run.runId).toBe("20260811T075723-stateact-minimal-gate_verdict");
      expect(run.experiment).toBe("stateact-minimal");
      expect(run.topology).toBe("gate_verdict");
      expect(run.taskSet).toBe("task-sets/smoke.yaml");
      expect(run.maxSteps).toBe(500);
      expect(run.startedAt).toBe("2026-08-11T07:57:23");
      expect(run.tasks).toEqual([{ taskId: "004", score: 0.5, status: "success" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to run dir name when runner.log has no identity", () => {
    const dir = tmpDir();
    try {
      const nested = path.join(dir, "20260811T075723-m3-single-self_report");
      write(nested, "runner.log", "run_dir=/x/20260811T075723-m3-single-self_report\n");
      const run = loadRunCompare(nested);
      expect(run.experiment).toBe("m3-single");
      expect(run.topology).toBe("self_report");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks a run without results.json as running", () => {
    const dir = tmpDir();
    try {
      write(dir, "runner.log", "experiment=m3-single topology=self_report tasks=['004']\n");
      const run = loadRunCompare(dir);
      expect(run.finished).toBe(false);
      expect(run.tasks).toEqual([]);
      expect(run.error).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expands a parent run directory into child runs", () => {
    const parent = tmpDir();
    try {
      write(parent, "a/manifest.json", JSON.stringify({ run_id: "a" }));
      write(parent, "b/manifest.json", JSON.stringify({ run_id: "b" }));
      write(parent, "not-a-run/README.txt", "x");
      const runs = resolveRunDirs([parent]);
      expect(runs.map((d) => path.basename(d)).sort()).toEqual(["a", "b"]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("formats a comparison table with header", () => {
    const a = tmpDir();
    const b = tmpDir();
    try {
      write(a, "runner.log", "experiment=stateact-minimal topology=gate_verdict\n");
      write(a, "summary/results.json", JSON.stringify([{ task_id: "004", score: 0.5, status: "success" }]));
      write(b, "runner.log", "experiment=m3-single topology=self_report\n");
      const table = formatCompare([loadRunCompare(a), loadRunCompare(b)]);
      expect(table).toContain("run");
      expect(table).toContain("stateact-minimal");
      expect(table).toContain("m3-single");
      expect(table).toContain("running");
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
