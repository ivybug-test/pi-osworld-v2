import { readFileSync } from "node:fs";
import path from "node:path";
import type { HarnessSpec, ReceivesSource, RoleSpec } from "../config/spec.js";
import type { BackendAdapter } from "../backends/base.js";
import type { Debugger } from "./debugger.js";
import type { TaskStateStore } from "./taskState.js";
import {
  type ActivityEntry,
  type EpisodeRequest,
  type EpisodeResult,
  type ObservationEnvelope,
  type RoundContext,
  type RoundRecord,
  type RuntimeServices,
  type TaskState,
} from "./types.js";
import { formatContract, formatAuditReport } from "./taskState.js";

// ---------------------------------------------------------------------------
// 角色 receives → user 消息组装（DESIGN-v2.md 10.4）
// ---------------------------------------------------------------------------

export function defaultReceives(role: RoleSpec): ReceivesSource[] {
  if (role.read_only === "enforce") return ["task", "contract", "executor_report"];
  if (role.tools.some((t) => t.startsWith("computer."))) return ["task", "contract"];
  return ["task", "contract"];
}

export function serializeSource(
  source: ReceivesSource,
  ctx: RoundContext,
  obs: ObservationEnvelope,
  activity?: ActivityEntry[],
): string {
  const state = ctx.state;
  switch (source) {
    case "task":
      return `## Task\n${state.goal}`;
    case "task_state":
      return `## Task state\n${formatTaskState(state)}`;
    case "contract":
      return ctx.contract
        ? `## Contract\n${formatContract(ctx.contract)}`
        : "## Contract\n(none)";
    case "evidence_refs": {
      const refs = ctx.contract?.evidenceRefs ?? [];
      return `## Evidence refs\n${
        refs.length
          ? refs.map((r) => `- [${r.reportId}] ${r.summary}`).join("\n")
          : "- (none)"
      }`;
    }
    case "executor_report":
      return `## Executor report\n${ctx.executorReport ?? "(none)"}`;
    case "audit_history": {
      const lines = state.rounds.length
        ? state.rounds.map(
            (r) =>
              `- round ${r.index}: ${r.auditReport?.completion ?? "?"}/${
                r.auditReport?.integrity ?? "?"
              }${r.auditReport ? ` (${r.auditReport.gaps.length} gaps)` : ""}`,
          )
        : ["- (none)"];
      // 上轮审计的目标/反馈正文：auditor 需要据此逐条核对达成度
      const latest = state.audit?.report;
      if (latest) {
        lines.push("");
        lines.push(
          `Latest audit (round ${state.audit?.lastRound ?? "?"}): ${latest.completion}/${latest.integrity}`,
        );
        if (latest.nextGoals?.length) {
          lines.push("Goals from last audit (check each):");
          lines.push(...latest.nextGoals.map((g) => `- ${g}`));
        }
        if (latest.feedback) lines.push(`feedback: ${latest.feedback.slice(0, 300)}`);
      }
      return `## Audit history\n${lines.join("\n")}`;
    }
    case "env_state":
      return `## Environment state\n${
        obs.terminal ? `terminal:\n${obs.terminal}` : "(no terminal output)"
      }`;
    case "progress_snapshot": {
      const executed = state.rounds;
      const last = executed[executed.length - 1];
      const recentDecisions = executed
        .slice(-10)
        .map((r) => r.decision.kind)
        .join(", ");
      return [
        "## Progress snapshot",
        `rounds executed: ${executed.length}`,
        `latest round: ${last ? `${last.index} (decision ${last.decision.kind})` : "(none)"}`,
        `recent decisions: ${recentDecisions || "(none)"}`,
      ].join("\n");
    }
    case "main_activity": {
      const entries = activity?.slice(-10) ?? [];
      if (entries.length === 0) return "## Main activity\n- (none yet)";
      return [
        "## Main activity",
        ...entries.map(
          (e) =>
            `- turn ${e.turn}: ${e.text}${
              e.tools.length ? ` [tools: ${e.tools.join(", ")}]` : ""
            }`,
        ),
      ].join("\n");
    }
    case "audit_evidence": {
      const latest = state.audit?.report;
      if (!latest) return "## Audit evidence\n- (none)";
      const lines = [
        "## Audit evidence",
        `latest audit (round ${state.audit?.lastRound ?? "?"}): ${latest.completion}/${latest.integrity}`,
      ];
      if (latest.verifiedFacts.length) {
        lines.push("verified facts:");
        lines.push(...latest.verifiedFacts.map((f) => `- [${f.reportId}] ${f.summary}`));
      }
      if (latest.gaps.length) {
        lines.push("gaps:");
        lines.push(...latest.gaps.map((g) => `- ${g}`));
      }
      if (latest.nextGoals?.length) {
        lines.push("goals for main:");
        lines.push(...latest.nextGoals.map((g) => `- ${g}`));
      }
      return lines.join("\n");
    }
  }
}

export function formatTaskState(state: TaskState): string {
  const lines: string[] = [];
  if (state.requirements.length) {
    lines.push("requirements:");
    for (const r of state.requirements) {
      lines.push(
        `- [${r.status}] ${r.text}${r.evidence.length ? ` (evidence: ${r.evidence.map((e) => `[${e.reportId}]`).join(", ")})` : ""}`,
      );
    }
  }
  if (state.artifacts.length) {
    lines.push("artifacts:");
    for (const a of state.artifacts) {
      lines.push(`- [${a.status}] ${a.path}`);
    }
  }
  if (state.facts.length) {
    lines.push("facts:");
    for (const f of state.facts) {
      lines.push(`- ${f.text} (evidence: [${f.evidence.map((e) => e.reportId).join(",")}])`);
    }
  }
  return lines.length ? lines.join("\n") : "(empty state)";
}

export function buildRoleMessage(
  role: RoleSpec,
  ctx: RoundContext,
  obs: ObservationEnvelope,
  feedback?: string,
  activity?: ActivityEntry[],
): string {
  const parts: string[] = [];
  for (const source of role.receives ?? defaultReceives(role)) {
    parts.push(serializeSource(source, ctx, obs, activity));
  }
  if (feedback) parts.push(`## Verifier feedback\n${feedback}`);
  // 周期审计反馈不拼进 user 消息：由 backend 的 FeedbackInjector 在每次模型调用前
  // 合入上下文（同轮注入），避免与 req.auditFeedback 的 seed 路径重复。
  if (obs.terminal && !role.receives?.includes("env_state")) {
    parts.push(`## Terminal\n${obs.terminal}`);
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Runtime：spec.roles + backends + stateStore 的运行时装配
// ---------------------------------------------------------------------------

export interface RuntimeOptions {
  spec: HarnessSpec;
  root: string;
  backends: Record<string, BackendAdapter>; // key = role id
  stateStore: TaskStateStore;
  debugger?: Debugger;
  emit?: (event: string, attrs: Record<string, unknown>) => void;
  observation?: ObservationEnvelope;
}

export class Runtime implements RuntimeServices {
  readonly spec: HarnessSpec;
  readonly stateStore: TaskStateStore;
  private readonly backends: Record<string, BackendAdapter>;
  private readonly debugger?: Debugger;
  private readonly emitFn?: (event: string, attrs: Record<string, unknown>) => void;
  private readonly root: string;
  private readonly observation: ObservationEnvelope;
  /** per-episode main 活动日志（环形，审计 main_activity 源读取）。 */
  private readonly activity = new Map<string, ActivityEntry[]>();

  constructor(options: RuntimeOptions) {
    this.spec = options.spec;
    this.root = options.root;
    this.backends = options.backends;
    this.stateStore = options.stateStore;
    this.debugger = options.debugger;
    this.emitFn = options.emit;
    this.observation = options.observation ?? {};
  }

  recordActivity(episodeId: string, entry: ActivityEntry): void {
    const entries = this.activity.get(episodeId) ?? [];
    entries.push(entry);
    this.activity.set(episodeId, entries.slice(-20));
  }

  emit(event: string, attrs: Record<string, unknown>): void {
    this.emitFn?.(event, attrs);
  }

  async readState(episodeId: string): Promise<TaskState | undefined> {
    return this.stateStore.read(episodeId);
  }

  async writeState(episodeId: string, state: TaskState): Promise<void> {
    await this.stateStore.write(episodeId, state);
  }

  async appendRound(episodeId: string, round: RoundRecord): Promise<TaskState> {
    return this.stateStore.appendRound(episodeId, round);
  }

  /** 组装该角色本轮的消息（system 静态 + user 按 receives 组装）并调用后端。 */
  async runRoleEpisode(
    roleId: string,
    ctx: RoundContext,
    obs: ObservationEnvelope,
    feedback?: string,
    auditFeedback?: string,
    onTurn?: EpisodeRequest["onTurn"],
  ): Promise<EpisodeResult> {
    const role = this.spec.roles[roleId];
    if (!role) throw new Error(`unknown role: ${roleId}`);
    const backend = this.backends[roleId];
    if (!backend) throw new Error(`no backend for role ${roleId}`);
    const system = loadPromptText(role.prompt.system, this.root);
    const user = buildRoleMessage(role, ctx, obs, feedback, this.activity.get(ctx.episodeId));
    const req: EpisodeRequest = {
      episodeId: ctx.episodeId,
      role: roleId,
      system,
      user,
      tools: role.tools,
      budget: role.budget,
      roundIndex: ctx.index,
      freshPerRound: contextIsFresh(role, this.spec),
      task: ctx.state.goal,
      observation: obs,
      ...(feedback ? { feedback } : {}),
      ...(auditFeedback ? { auditFeedback } : {}),
      ...(onTurn ? { onTurn } : {}),
    };
    await this.debugger?.onRoleStart(roleId, req);
    this.emit("role.start", { role: roleId, round: ctx.index });
    let result: EpisodeResult;
    try {
      result = await backend.runEpisode(req);
    } catch (error) {
      result = {
        status: "error",
        report: error instanceof Error ? error.message : String(error),
      };
    }
    await this.debugger?.onRoleEnd(roleId, result);
    this.emit("role.end", {
      role: roleId,
      round: ctx.index,
      status: result.status,
    });
    return result;
  }

  checkIntegrity(roundIndex: number): Promise<{ clean: boolean; findings: string[] }> {
    // P0：环境侧 integrity 检查（snapshot/diff）后续接 Environment + IntegrityMonitor；
    // 当前返回 clean，由 mock/真实 auditor 的 auditReport.integrity 承担语义。
    return Promise.resolve({ clean: true, findings: [] });
  }
}

/** prompt.system 按路径读取（相对 config root）；文件不存在时当作字面量文本。 */
export function loadPromptText(system: string, root: string): string {
  const p = path.resolve(root, system);
  try {
    return readFileSync(p, "utf8");
  } catch {
    return system;
  }
}

function contextIsFresh(role: RoleSpec, spec: HarnessSpec): boolean {
  const ctx = role.context;
  if (typeof ctx === "object" && ctx.fresh_per_round === true) return true;
  // 实验级 context 默认同样适用
  const globalCtx = spec.context;
  return typeof globalCtx === "object" && globalCtx.fresh_per_round === true;
}
