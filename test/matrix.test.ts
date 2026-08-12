import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  expandMatrix,
  formatMatrixPlan,
  loadMatrix,
  matrixCellLabel,
} from "../src/cli/matrix.js";

describe("matrix", () => {
  it("expands configs x task_sets x runs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "piosworld-v2-matrix-"));
    try {
      const file = path.join(dir, "matrix.yaml");
      writeFileSync(
        file,
        [
          "configs:",
          "  - presets/m3-single.yaml",
          "  - presets/stateact.yaml",
          "task_sets:",
          "  - task-sets/smoke.yaml",
          "runs: 2",
          "",
        ].join("\n"),
        "utf8",
      );
      const cells = expandMatrix(loadMatrix(file));
      expect(cells).toHaveLength(4);
      expect(cells[0]).toEqual({
        config: "presets/m3-single.yaml",
        taskSet: "task-sets/smoke.yaml",
        run: 1,
      });
      expect(cells[3]).toEqual({
        config: "presets/stateact.yaml",
        taskSet: "task-sets/smoke.yaml",
        run: 2,
      });
      expect(matrixCellLabel(cells[3])).toBe("stateact-smoke-run2");
      expect(formatMatrixPlan(cells)).toContain("run 1: presets/m3-single.yaml");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps config's own task_set when matrix has none", () => {
    const cells = expandMatrix({
      configs: ["presets/stateact.yaml"],
      runs: 1,
    });
    expect(cells).toEqual([{ config: "presets/stateact.yaml", run: 1 }]);
    expect(cells[0].taskSet).toBeUndefined();
  });
});
