import type { BackendId } from "../config/spec.js";
import type {
  AuditReport,
  EpisodeRequest,
  EpisodeResult,
  ManagerDecision,
} from "../engine/types.js";
import type { BackendAdapter } from "./base.js";

// ---------------------------------------------------------------------------
// Mock 后端：脚本化行为，供调试/单测/CI，不调模型。
// 行为按轮次消费（roundIndex-1 索引 steps，越界重复最后一个）。
// ---------------------------------------------------------------------------

export type MockStep =
  | { type: "decision"; decision: ManagerDecision }
  | { type: "report"; report: string; decision?: ManagerDecision }
  | { type: "audit"; report: string; auditReport: AuditReport }
  | { type: "verdict"; accepted: boolean; feedback?: string };

export interface MockBackendOptions {
  behaviors: Record<string, MockStep[] | MockStep>;
  /** 未配置的角色返回空报告（status done）。 */
  defaultResult?: EpisodeResult;
}

export class MockBackend implements BackendAdapter {
  readonly id: BackendId = "mock";
  private readonly behaviors: Record<string, MockStep[]>;
  private readonly defaultResult: EpisodeResult;

  constructor(options: MockBackendOptions) {
    this.behaviors = Object.fromEntries(
      Object.entries(options.behaviors).map(([role, b]) => [
        role,
        Array.isArray(b) ? b : [b],
      ]),
    );
    this.defaultResult = options.defaultResult ?? {
      status: "done",
      report: "(mock: no behavior configured)",
    };
  }

  async runEpisode(req: EpisodeRequest): Promise<EpisodeResult> {
    const steps = this.behaviors[req.role];
    if (!steps || steps.length === 0) return structuredClone(this.defaultResult);
    const idx = Math.min(Math.max(req.roundIndex - 1, 0), steps.length - 1);
    const step = steps[idx];
    switch (step.type) {
      case "decision":
        return { status: "done", decision: step.decision };
      case "report":
        return {
          status: "done",
          report: step.report,
          ...(step.decision ? { decision: step.decision } : {}),
        };
      case "audit":
        return {
          status: "done",
          report: step.report,
          auditReport: step.auditReport,
        };
      case "verdict":
        return {
          status: "done",
          verdict: { accepted: step.accepted, feedback: step.feedback },
        };
    }
  }
}

// ---------------------------------------------------------------------------
// 常用构造 helper（测试与 CLI 演示用）
// ---------------------------------------------------------------------------

export const mockAudit = (
  completion: AuditReport["completion"],
  integrity: AuditReport["integrity"] = "clean",
  gaps: string[] = [],
  evidence: string[] = [],
): MockStep => ({
  type: "audit",
  report: `${completion} / ${integrity}`,
  auditReport: {
    roundId: "",
    completion,
    integrity,
    contractAudit: integrity === "clean" ? "aligned" : "invalid",
    verifiedFacts: [],
    gaps,
    evidence,
  },
});

export const mockExecute = (goal: string, target: "gui" | "cli" = "cli"): MockStep => ({
  type: "decision",
  decision: {
    kind: "execute",
    contract: {
      id: `c-${target}`,
      goal,
      acceptanceCriteria: [`fulfill ${goal}`],
      boundaryConstraints: [],
      evidenceRefs: [],
      target,
    },
  },
});

export const mockDone = (reason?: string): MockStep => ({
  type: "decision",
  decision: { kind: "done", reason },
});
