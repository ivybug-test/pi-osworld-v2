import type { BackendId } from "../config/spec.js";
import type {
  AuditReport,
  EpisodeRequest,
  EpisodeResult,
  ManagerDecision,
} from "../engine/types.js";
import type { BackendAdapter } from "./base.js";
import { FeedbackInjector } from "../engine/feedback.js";

// ---------------------------------------------------------------------------
// Mock 后端：脚本化行为，供调试/单测/CI，不调模型。
// 行为按轮次消费（roundIndex-1 索引 steps，越界重复最后一个）。
// ---------------------------------------------------------------------------

export type MockStep =
  | { type: "decision"; decision: ManagerDecision }
  | { type: "report"; report: string; decision?: ManagerDecision }
  | { type: "audit"; report: string; auditReport: AuditReport }
  | { type: "verdict"; accepted: boolean; feedback?: string };

/** 角色单次 episode 内模拟的模型调用（turn）数；默认 1。 */
export interface MockTurns {
  turns?: number;
}

export type MockStepWithTurns = MockStep & MockTurns;

export interface MockBackendOptions {
  behaviors: Record<string, MockStepWithTurns[] | MockStepWithTurns>;
  /** 未配置的角色返回空报告（status done）。 */
  defaultResult?: EpisodeResult;
}

export class MockBackend implements BackendAdapter {
  readonly id: BackendId = "mock";
  private readonly behaviors: Record<string, MockStepWithTurns[]>;
  private readonly defaultResult: EpisodeResult;
  /** 每个角色累计模拟 turn（跨 runEpisode 调用保持，模拟 serve 内 agent 持久计数）。 */
  private readonly simTurns: Record<string, number> = {};
  /** 每个 episode 通过同轮反馈注入缓冲实际交付的文本（测试断言用）。 */
  readonly injectedFeedback: Record<string, string[]> = {};

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

    // 模拟 pi backend 的同轮反馈注入：round 开始 seed 持久化缓冲，每次模型调用
    // （onTurn）前取走缓冲合入上下文；onTurn 内的 offer（周期审计）下次调用可见。
    const injector = new FeedbackInjector();
    if (req.auditFeedback) injector.offer(req.auditFeedback);
    if (req.onTurn) {
      const count = step.turns ?? 1;
      for (let i = 0; i < count; i += 1) {
        const pending = injector.takePending();
        if (pending) {
          (this.injectedFeedback[req.episodeId] ??= []).push(pending);
        }
        this.simTurns[req.role] = (this.simTurns[req.role] ?? 0) + 1;
        const summaryText =
          "report" in step && typeof step.report === "string"
            ? step.report
            : "mock action";
        const stop = await req.onTurn(
          this.simTurns[req.role],
          0,
          injector,
          { text: summaryText, tools: [] },
        );
        if (stop === false) break;
      }
    }
    const feedbackDelivered = !injector.hasPending;
    switch (step.type) {
      case "decision":
        return { status: "done", decision: step.decision, feedbackDelivered };
      case "report":
        return {
          status: "done",
          report: step.report,
          ...(step.decision ? { decision: step.decision } : {}),
          feedbackDelivered,
        };
      case "audit":
        return {
          status: "done",
          report: step.report,
          auditReport: step.auditReport,
          feedbackDelivered,
        };
      case "verdict":
        return {
          status: "done",
          verdict: { accepted: step.accepted, feedback: step.feedback },
          feedbackDelivered,
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
  nextGoals: string[] = [],
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
    ...(nextGoals.length ? { nextGoals } : {}),
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
