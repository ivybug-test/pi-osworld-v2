import type { HarnessSpec } from "../config/spec.js";
import type { Debugger } from "./debugger.js";
import { createTaskState } from "./taskState.js";
import {
  type AuditReport,
  type DecisionOutcome,
  type EvidenceRef,
  type EpisodeResult,
  type EpisodeSummary,
  type ManagerDecision,
  type ObservationEnvelope,
  type RoundContext,
  type RoundRecord,
  type RuntimeServices,
  type SubtaskContract,
  type TaskState,
} from "./types.js";

// ---------------------------------------------------------------------------
// 通用 round-loop 解释器（DESIGN-v2.md 10.3）
// 行为全部由 spec.loop 参数化；代码里没有 manager/executor/auditor 专属类。
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  runtime: RuntimeServices;
  debugger?: Debugger;
}

export class Orchestrator {
  /** gate_verdict 驱动的跨轮验证反馈（main 下一轮可见）。 */
  private feedback: string | undefined;
  /** gate_verdict 驱动的拒绝次数（达到 loop.max_rounds 后放行 DONE）。 */
  private gateRejections = 0;

  constructor(
    private readonly spec: HarnessSpec,
    private readonly options: OrchestratorOptions,
  ) {}

  setFeedback(feedback: string | undefined): void {
    this.feedback = feedback;
  }

  async runEpisode(input: {
    episodeId: string;
    task: string;
    observation?: ObservationEnvelope;
    /** serve 模式：只跑指定轮数后返回（配合 resume 做 step 驱动）。 */
    roundLimit?: number;
  }): Promise<EpisodeSummary> {
    const { runtime, debugger: dbg } = this.options;
    const obs = input.observation ?? {};
    const existing = await runtime.readState(input.episodeId);
    // serve 模式每个 predict 只跑一轮，feedback/拒绝计数持久化在 task_state，
    // 这样 gate_verdict 的 max_rounds 和下一轮 feedback 能跨 predict 延续。
    this.gateRejections = existing?.gate?.rejections ?? 0;
    this.feedback = existing?.gate?.feedback;
    const state =
      existing ??
      createTaskState(
        input.task,
        this.spec.state?.schema ?? ["requirements", "artifacts", "facts"],
      );
    if (!existing) {
      // 首轮前先落盘初始状态，保证 File store 的 appendRound 能找到记录
      await runtime.writeState(input.episodeId, state);
    }

    // resume：已有 round 记录则从下一轮继续
    const startRound = state.rounds.length + 1;
    // roundLimit 是"本次调用最多再跑 N 轮"（resume 后按 startRound 平移）
    const maxRounds =
      input.roundLimit === undefined
        ? this.maxRounds()
        : Math.min(startRound + input.roundLimit - 1, this.maxRounds());

    for (let round = startRound; round <= maxRounds; round++) {
      const ctx: RoundContext = {
        episodeId: input.episodeId,
        index: round,
        state,
      };
      runtime.emit("round.start", { episodeId: input.episodeId, round });
      await dbg?.onRoundStart(ctx);

      const outcome = await this.driveRound(ctx, obs);

      runtime.emit("round.decision", {
        episodeId: input.episodeId,
        round,
        outcome: outcome.kind,
      });
      await dbg?.onRoundEnd(ctx, outcome);

      if (outcome.kind === "execute") continue;
      const final = (await runtime.readState(input.episodeId)) ?? state;
      return {
        episodeId: input.episodeId,
        state: final,
        outcome,
        rounds: final.rounds.length,
      };
    }

    const final = (await runtime.readState(input.episodeId)) ?? state;
    // roundLimit 下自然跑完本轮 → 返回 execute，由 serve 驱动下一 predict 继续
    const ranRounds = startRound <= maxRounds && final.rounds.length >= startRound;
    const outcome =
      input.roundLimit !== undefined && ranRounds
        ? { kind: "execute" as const }
        : { kind: "max_rounds" as const };
    return {
      episodeId: input.episodeId,
      state: final,
      outcome,
      rounds: final.rounds.length,
    };
  }

  private maxRounds(): number {
    const loop = this.spec.loop;
    if (loop.driver === "gate_verdict") {
      return loop.total_rounds ?? 100;
    }
    return "max_rounds" in loop && loop.max_rounds ? loop.max_rounds : 30;
  }

  private async driveRound(
    ctx: RoundContext,
    obs: ObservationEnvelope,
  ): Promise<DecisionOutcome> {
    switch (this.spec.loop.driver) {
      case "self_report":
        return this.selfReportRound(ctx, obs);
      case "gate_verdict":
        return this.gateVerdictRound(ctx, obs);
      case "manager_decision":
        return this.managerDecisionRound(ctx, obs);
      default:
        throw new Error(`unimplemented driver: ${this.spec.loop.driver}`);
    }
  }

  // -------------------------------------------------------------------------
  // driver: self_report —— 单角色自报完成（m3-single）
  // -------------------------------------------------------------------------

  private async selfReportRound(
    ctx: RoundContext,
    obs: ObservationEnvelope,
  ): Promise<DecisionOutcome> {
    const { runtime } = this.options;
    const loop = this.spec.loop;
    if (loop.driver !== "self_report") throw new Error("unreachable");
    const role = loop.role ?? firstRoleKey(this.spec);
    const result = await runtime.runRoleEpisode(role, ctx, obs);
    const decision = result.decision ?? defaultDecision(result);
    const round: RoundRecord = {
      index: ctx.index,
      decision,
      ...(result.metadata ? { metadata: result.metadata } : {}),
    };
    ctx.decision = decision;
    ctx.executorReport = result.report;
    const updated = await runtime.appendRound(ctx.episodeId, round);
    ctx.state = updated;
    if (decision.kind === "done") return { kind: "done" };
    return { kind: "execute" };
  }

  // -------------------------------------------------------------------------
  // driver: gate_verdict —— main 自报完成，独立 gate 只读验证（stateact）
  // -------------------------------------------------------------------------

  private async gateVerdictRound(
    ctx: RoundContext,
    obs: ObservationEnvelope,
  ): Promise<DecisionOutcome> {
    const { runtime } = this.options;
    const loop = this.spec.loop;
    if (loop.driver !== "gate_verdict") throw new Error("unreachable");
    const gateSpec = this.spec.gates?.[loop.gate];
    if (!gateSpec) throw new Error(`gate ${loop.gate} is not defined in gates`);

    const result = await runtime.runRoleEpisode(
      loop.feedback_to,
      ctx,
      obs,
      this.feedback,
    );
    const decision = result.decision ?? defaultDecision(result);
    ctx.executorReport = result.report;

    if (decision.kind === "done") {
      const gateCtx: RoundContext = { ...ctx, executorReport: result.report };
      const gateResult = await runtime.runRoleEpisode(
        gateSpec.role,
        gateCtx,
        obs,
      );
      const verdict = gateResult.verdict ?? {
        accepted: false,
        feedback: gateResult.report,
      };
      ctx.decision = verdict.accepted
        ? { kind: "done" }
        : { kind: "execute" };
      ctx.auditReport = gateResult.auditReport;
      const round: RoundRecord = {
        index: ctx.index,
        executorReport: result.report,
        auditReport: gateResult.auditReport,
        decision: ctx.decision,
        ...(result.metadata ? { metadata: result.metadata } : {}),
      };
      const updated = await runtime.appendRound(ctx.episodeId, round);
      ctx.state = updated;
      if (verdict.accepted) {
        this.feedback = undefined;
        await runtime.writeState(ctx.episodeId, {
          ...updated,
          gate: { rejections: this.gateRejections },
        });
        return { kind: "done" };
      }
      // 拒绝 → 记录反馈，下一轮 repair 时注入 main 的消息
      this.gateRejections += 1;
      if (this.gateRejections >= loop.max_rounds) {
        this.feedback = undefined;
        await runtime.writeState(ctx.episodeId, {
          ...updated,
          gate: { rejections: this.gateRejections },
        });
        return loop.on_gate_exhausted === "done"
          ? { kind: "done" }
          : { kind: "blocked", reason: "finish gate exhausted" };
      }
      this.feedback = verdict.feedback ?? "verifier rejected the finish claim";
      await runtime.writeState(ctx.episodeId, {
        ...updated,
        gate: { rejections: this.gateRejections, feedback: this.feedback },
      });
      return { kind: "execute" };
    }

    const round: RoundRecord = {
      index: ctx.index,
      executorReport: result.report,
      decision,
      ...(result.metadata ? { metadata: result.metadata } : {}),
    };
    const updated = await runtime.appendRound(ctx.episodeId, round);
    ctx.state = updated;
    return { kind: "execute" };
  }

  // -------------------------------------------------------------------------
  // driver: manager_decision —— 论文 MEA 的语义（全部由 spec 参数化）
  // -------------------------------------------------------------------------

  private async managerDecisionRound(
    ctx: RoundContext,
    obs: ObservationEnvelope,
  ): Promise<DecisionOutcome> {
    const { runtime } = this.options;
    const loop = this.spec.loop;
    if (loop.driver !== "manager_decision") throw new Error("unreachable");

    // 1) manager 决策（无环境工具；receives 由 spec 控制）
    const mgrResult = await runtime.runRoleEpisode(
      loop.contract.produced_by,
      ctx,
      obs,
    );
    const decision = mgrResult.decision;
    if (!decision) {
      throw new Error(
        `manager role ${loop.contract.produced_by} returned no decision`,
      );
    }
    ctx.decision = decision;
    runtime.emit("manager.decision", {
      episodeId: ctx.episodeId,
      round: ctx.index,
      kind: decision.kind,
    });

    if (decision.kind === "done") {
      await runtime.appendRound(ctx.episodeId, {
        index: ctx.index,
        decision,
      });
      return { kind: "done" };
    }
    if (decision.kind === "blocked") {
      await runtime.appendRound(ctx.episodeId, {
        index: ctx.index,
        decision,
      });
      return { kind: "blocked", reason: decision.reason };
    }
    if (decision.kind === "ask") {
      await runtime.appendRound(ctx.episodeId, {
        index: ctx.index,
        decision,
      });
      return {
        kind: "ask",
        question: decision.question,
        answers: decision.answers,
      };
    }

    // 2) execute：按契约 target 路由 executor
    const contract = decision.contract;
    if (!contract) {
      throw new Error("manager decision kind=execute requires contract");
    }
    validateContract(contract, loop.contract.fields);
    ctx.contract = contract;
    const executorRole =
      contract.target === "gui" ? loop.routing.gui : loop.routing.cli;
    runtime.emit("round.contract", {
      episodeId: ctx.episodeId,
      round: ctx.index,
      target: contract.target,
      goal: contract.goal,
    });

    const execResult = await runtime.runRoleEpisode(executorRole, ctx, obs);
    ctx.executorReport = execResult.report;

    // 3) auditor 只读验证
    const auditResult = await runtime.runRoleEpisode(
      this.auditorRoleId(),
      ctx,
      obs,
    );
    const audit = auditResult.auditReport;
    if (!audit) {
      throw new Error(`auditor role returned no audit report`);
    }
    ctx.auditReport = audit;
    runtime.emit("round.audit", {
      episodeId: ctx.episodeId,
      round: ctx.index,
      completion: audit.completion,
      integrity: audit.integrity,
      contractAudit: audit.contractAudit,
      gaps: audit.gaps.length,
    });

    // 4) 按 update_policy 更新任务状态（audit_verified：先落盘更新，再记轮次）
    const policy = this.spec.state?.update_policy ?? "self_report";
    const updated =
      policy === "audit_verified"
        ? applyAuditToState(ctx.state, audit, contract, ctx.index)
        : ctx.state;
    if (policy === "audit_verified") {
      await runtime.writeState(ctx.episodeId, updated);
    }
    const round: RoundRecord = {
      index: ctx.index,
      contract,
      executorReport: execResult.report,
      auditReport: audit,
      decision,
    };
    const stored = await runtime.appendRound(ctx.episodeId, round);
    ctx.state = stored;
    if (policy === "audit_verified") {
      runtime.emit("round.state_update", {
        episodeId: ctx.episodeId,
        round: ctx.index,
        completed: countStatus(stored.requirements, "completed"),
        untrusted: countStatus(stored.requirements, "untrusted"),
      });
    }

    // 5) 决策下一轮
    if (audit.completion === "complete" && audit.integrity === "clean") {
      return { kind: "execute" }; // 由下一轮 manager 判断是否 done
    }
    return { kind: "execute" };
  }

  private auditorRoleId(): string {
    const loop = this.spec.loop;
    if (loop.driver !== "manager_decision") throw new Error("unreachable");
    const candidates = Object.entries(this.spec.roles)
      .filter(([, r]) => r.read_only === "enforce")
      .map(([id]) => id);
    if (candidates.length === 0) {
      throw new Error(
        "manager_decision driver requires at least one role with read_only: enforce (auditor)",
      );
    }
    return candidates[0];
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function firstRoleKey(spec: HarnessSpec): string {
  const keys = Object.keys(spec.roles);
  if (keys.length === 0) throw new Error("spec.roles is empty");
  return keys[0];
}

/** 后端未提供结构化决策时，按 episode 状态推断。 */
export function defaultDecision(result: EpisodeResult): ManagerDecision {
  if (result.status === "error" || result.status === "timeout") {
    return { kind: "blocked", reason: `episode ${result.status}` };
  }
  return { kind: "execute" };
}

function validateContract(
  contract: SubtaskContract,
  fields: string[],
): void {
  if (!contract.goal) throw new Error("contract.goal is required");
  if (fields.includes("acceptance_criteria") && contract.acceptanceCriteria.length === 0) {
    throw new Error("contract.acceptanceCriteria must not be empty");
  }
  if (contract.target !== "gui" && contract.target !== "cli") {
    throw new Error(`contract.target must be gui|cli, got ${contract.target}`);
  }
}

/** audit_verified 策略：只有 clean 审计证据支持的记录才能标记 completed。 */
export function applyAuditToState(
  state: TaskState,
  audit: AuditReport,
  contract: SubtaskContract,
  roundIndex: number,
): TaskState {
  const next = structuredClone(state);
  const evidence: EvidenceRef[] = audit.verifiedFacts.length
    ? audit.verifiedFacts
    : [{ reportId: `round-${roundIndex}`, summary: audit.evidence[0] ?? audit.completion }];

  if (audit.integrity !== "clean") {
    for (const req of next.requirements) {
      if (req.status === "pending") req.status = "untrusted";
    }
    return next;
  }
  for (const req of next.requirements) {
    if (req.status !== "pending") continue;
    if (audit.completion === "complete") {
      req.status = "completed";
      req.evidence = evidence;
    } else if (audit.completion === "blocked") {
      req.status = "blocked";
      req.evidence = evidence;
    }
    // incomplete → 保持 pending
  }
  for (const fact of audit.verifiedFacts) {
    if (!next.facts.some((f) => f.text === fact.summary)) {
      next.facts.push({
        id: `fact-${next.facts.length + 1}`,
        text: fact.summary,
        evidence: [fact],
      });
    }
  }
  return next;
}

function countStatus(reqs: TaskState["requirements"], status: string): number {
  return reqs.filter((r) => r.status === status).length;
}
