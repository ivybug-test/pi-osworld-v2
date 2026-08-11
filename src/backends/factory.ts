import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { BackendId, HarnessSpec } from "../config/spec.js";
import type { BackendAdapter } from "./base.js";
import type { SubtaskContract } from "../engine/types.js";
import { PiBackend } from "./pi.js";
import {
  MockBackend,
  type MockStep,
} from "./mock.js";

// ---------------------------------------------------------------------------
// 后端装配：--backend 覆盖全部角色；否则按 spec.roles.<id>.backend（默认 pi）。
// run 与 serve 共用。
// ---------------------------------------------------------------------------

export interface BackendFactoryOptions {
  spec: HarnessSpec;
  root: string;
  resultDir: string;
  /** 覆盖全部角色的后端 id。 */
  backendOverride?: BackendId;
  toolServerUrl?: string;
  mockScriptPath?: string;
  emit?: (event: string, attrs: Record<string, unknown>) => void;
}

export function buildBackends(options: BackendFactoryOptions): Record<string, BackendAdapter> {
  const { spec, backendOverride } = options;
  const backends: Record<string, BackendAdapter> = {};
  const needsPi = Object.values(spec.roles).some(
    (role) => (backendOverride ?? role.backend) === "pi",
  );
  let piBackend: PiBackend | undefined;
  if (needsPi) {
    piBackend = new PiBackend({
      spec,
      root: options.root,
      resultDir: options.resultDir,
      toolServerUrl: options.toolServerUrl,
      emit: options.emit,
    });
  }
  const behaviors = loadMockBehaviors(options.mockScriptPath, spec);
  for (const roleId of Object.keys(spec.roles)) {
    const backendId = backendOverride ?? spec.roles[roleId].backend;
    if (backendId === "pi") {
      backends[roleId] = piBackend as PiBackend;
    } else {
      backends[roleId] = new MockBackend({ behaviors });
    }
  }
  return backends;
}

export function uniqueBackends(backends: Record<string, BackendAdapter>): BackendAdapter[] {
  return [...new Set(Object.values(backends))];
}

function loadMockBehaviors(
  scriptPath: string | undefined,
  spec: HarnessSpec,
): Record<string, MockStep[] | MockStep> {
  if (scriptPath) {
    const text = readFileSync(scriptPath, "utf8");
    const yaml = parseYaml(text) as Record<string, unknown>;
    return yaml as Record<string, MockStep[] | MockStep>;
  }
  return defaultMockBehaviors(spec);
}

/** 按 spec.loop.driver 生成默认脚本化行为（演示/冒烟用）。 */
function defaultMockBehaviors(
  spec: HarnessSpec,
): Record<string, MockStep[] | MockStep> {
  const loop = spec.loop;
  if (loop.driver === "manager_decision") {
    const contract = {
      id: "mock-contract",
      goal: "(mock goal)",
      acceptanceCriteria: ["(mock acceptance)"],
      boundaryConstraints: [] as string[],
      evidenceRefs: [] as SubtaskContract["evidenceRefs"],
      target: "cli" as const,
    };
    return {
      [loop.contract.produced_by]: [
        {
          type: "decision",
          decision: { kind: "execute", contract },
        },
        { type: "decision", decision: { kind: "done", reason: "(mock complete)" } },
      ],
      [loop.routing.cli]: { type: "report", report: "(mock executor report)" },
      [loop.routing.gui]: { type: "report", report: "(mock gui report)" },
      [auditorRole(spec)]: {
        type: "audit",
        report: "complete / clean",
        auditReport: {
          roundId: "",
          completion: "complete",
          integrity: "clean",
          contractAudit: "aligned",
          verifiedFacts: [],
          gaps: [],
          evidence: ["(mock evidence)"],
        },
      },
    };
  }
  if (loop.driver === "gate_verdict") {
    const gateRole = spec.gates?.[loop.gate]?.role ?? "finish_gate";
    return {
      [loop.feedback_to]: { type: "decision", decision: { kind: "done" } },
      [gateRole]: { type: "verdict", accepted: true },
    };
  }
  const role = loop.driver === "self_report" ? (loop.role ?? firstRoleKey(spec)) : firstRoleKey(spec);
  return {
    [role]: { type: "decision", decision: { kind: "execute" } },
  };
}

function auditorRole(spec: HarnessSpec): string {
  const candidates = Object.entries(spec.roles)
    .filter(([, r]) => r.read_only === "enforce")
    .map(([id]) => id);
  return candidates[0] ?? Object.keys(spec.roles)[0];
}

function firstRoleKey(spec: HarnessSpec): string {
  const keys = Object.keys(spec.roles);
  if (keys.length === 0) throw new Error("spec.roles is empty");
  return keys[0];
}
