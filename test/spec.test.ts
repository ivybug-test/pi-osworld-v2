import { describe, expect, it } from "vitest";
import { HarnessSpec } from "../src/config/spec.js";
import { loadHarnessSpec, deepMerge } from "../src/config/load.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpdir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "piosworld-spec-"));
}

const baseMea = {
  experiment: "mea-test",
  benchmark: { name: "osworld-v2", release: "osworld-v2-2026.06.24" },
  task_set: "task-sets/smoke.yaml",
  models: { manager: "m", executor: "m", gui_executor: "m", auditor: "m" },
  roles: {
    manager: {
      model: "manager",
      prompt: { system: "manager.md" },
      observation: { allow: ["state"] },
      tools: [],
      receives: ["task", "task_state", "audit_history"],
    },
    executor: {
      model: "executor",
      prompt: { system: "executor.md" },
      observation: { allow: ["state"] },
      context: { fresh_per_round: true },
      tools: ["state.bash"],
      receives: ["task", "contract"],
    },
    gui_executor: {
      model: "gui_executor",
      prompt: { system: "gui.md" },
      observation: { allow: ["screenshot"] },
      tools: ["computer.pyautogui"],
      receives: ["task", "contract"],
    },
    auditor: {
      model: "auditor",
      prompt: { system: "auditor.md" },
      observation: { allow: ["state"] },
      tools: ["state.inspect_ro"],
      receives: ["task", "contract", "executor_report"],
      read_only: "enforce",
    },
  },
  state: {
    schema: ["requirements", "artifacts", "facts"],
    store: "memory",
    update_policy: "audit_verified",
  },
  loop: {
    driver: "manager_decision",
    decision_tool: "manager.decide",
    contract: {
      produced_by: "manager",
      fields: ["goal", "acceptance_criteria", "boundary_constraints", "evidence_refs", "target"],
    },
    routing: { gui: "gui_executor", cli: "executor" },
    max_rounds: 25,
  },
};

describe("HarnessSpec schema", () => {
  it("parses a valid MEA spec", () => {
    const spec = HarnessSpec.parse(baseMea);
    expect(spec.loop.driver).toBe("manager_decision");
    expect(spec.roles.auditor.read_only).toBe("enforce");
    expect(spec.roles.manager.backend).toBe("pi"); // default
    expect(spec.state?.update_policy).toBe("audit_verified");
  });

  it("rejects a spec without roles", () => {
    expect(() =>
      HarnessSpec.parse({ ...baseMea, roles: {} }),
    ).toThrow();
  });

  it("rejects an unknown driver", () => {
    expect(() =>
      HarnessSpec.parse({ ...baseMea, loop: { ...baseMea.loop, driver: "nope" } }),
    ).toThrow();
  });
});

describe("config load + extends", () => {
  it("merges extends chain (child overrides parent)", () => {
    const dir = tmpdir();
    const preset = path.join(dir, "preset.yaml");
    writeFileSync(
      preset,
      `experiment: base
benchmark: { name: osworld-v2, release: r1 }
task_set: ts.yaml
models: { a: m1 }
roles:
  a: { model: a, prompt: { system: p.md }, observation: { allow: [state] }, tools: [] }
loop: { driver: self_report, done_tool: x }
`,
      "utf8",
    );
    const child = path.join(dir, "child.yaml");
    writeFileSync(
      child,
      `experiment: child
extends: preset.yaml
benchmark: { name: osworld-v2, release: r2 }
`,
      "utf8",
    );
    const loaded = loadHarnessSpec(child);
    expect(loaded.spec.experiment).toBe("child");
    expect(loaded.spec.benchmark.release).toBe("r2"); // child wins
    expect(loaded.spec.roles.a.model).toBe("a"); // inherited
    expect(loaded.configHash).toHaveLength(16);
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects extends cycle", () => {
    const dir = tmpdir();
    const a = path.join(dir, "a.yaml");
    writeFileSync(
      a,
      `experiment: a
extends: b.yaml
benchmark: { name: x, release: r }
task_set: t
models: { m: x }
roles: { r: { model: m, prompt: { system: p }, observation: { allow: [state] }, tools: [] } }
loop: { driver: self_report, done_tool: d }
`,
      "utf8",
    );
    const b = path.join(dir, "b.yaml");
    writeFileSync(b, `experiment: b\nextends: a.yaml\n`, "utf8");
    expect(() => loadHarnessSpec(a)).toThrow(/循环引用/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("deepMerge", () => {
  it("merges nested objects, replaces arrays", () => {
    expect(deepMerge({ a: { x: 1, y: 2 }, b: [1] }, { a: { y: 3 }, b: [2, 3] })).toEqual({
      a: { x: 1, y: 3 },
      b: [2, 3],
    });
  });
});
