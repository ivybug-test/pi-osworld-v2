import type { HarnessSpec, RoleSpec } from "../../config/spec.js";
import type { BackendAdapter } from "../base.js";
import type {
  EpisodeRequest,
  EpisodeResult,
  ObservationEnvelope,
} from "../../engine/types.js";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import {
  RoleAgent,
  RoleSubagent,
  assistantToolCalls,
  toolResultMessage,
  resolveTools,
  actionsFromToolCalls,
  formatPlan,
  parsePlanItems,
  buildRoleView,
  type FlowContext,
  type PlanItem,
  type PiModelClient,
  type StepInput,
  type SubagentOutput,
  type ToolExecutionResult,
} from "./index.js";
import { buildLegacyFlowContext } from "./compat.js";
import { policyForRole } from "../../primitives/permission.js";

// ---------------------------------------------------------------------------
// Pi 后端：包装旧 RoleAgent + PiContextManager + RoleSubagent，不重写。
// 行为旋钮全部来自 spec.roles.<id>（interior_loop / terminal_tools / plan_tool /
// refresh_state / message_style / read_only），编排仍由 v2 引擎负责。
// ---------------------------------------------------------------------------

export interface PiBackendOptions {
  spec: HarnessSpec;
  /** config root（prompt 相对路径基准）。 */
  root: string;
  /** run 目录：旧 RunWriter 把 events/telemetry/llm_traces 落在这里。 */
  resultDir: string;
  /** OSWorld tool server（旧 HttpToolExecutor 直连）。 */
  toolServerUrl?: string;
  /** Test seam：per-role model client 覆盖（keyed by role id）。 */
  clientOverrides?: Record<string, PiModelClient>;
  emit?: (event: string, attrs: Record<string, unknown>) => void;
}

interface PiSession {
  plan: PlanItem[];
  nonFinishTurns: number;
}

export class PiBackend implements BackendAdapter {
  readonly id = "pi" as const;

  private readonly context: FlowContext;
  private readonly agents = new Map<string, RoleAgent>();
  private readonly subagents = new Map<string, RoleSubagent>();
  private readonly sessions = new Map<string, PiSession>();

  constructor(private readonly options: PiBackendOptions) {
    this.context = buildLegacyFlowContext(options);
  }

  async close(): Promise<void> {
    await this.context.writer.flushLlm();
  }

  /** serve reset：清空某 episode 的跨轮会话（plan / 非终结计数）并重置角色上下文。 */
  async resetEpisode(episodeId: string): Promise<void> {
    for (const key of [...this.sessions.keys()]) {
      if (key.startsWith(`${episodeId}:`)) this.sessions.delete(key);
    }
    for (const agent of this.agents.values()) await agent.reset();
    for (const subagent of this.subagents.values()) await subagent.reset();
  }

  async runEpisode(req: EpisodeRequest): Promise<EpisodeResult> {
    const role = this.options.spec.roles[req.role];
    if (!role) throw new Error(`unknown role: ${req.role}`);
    const agent = await this.ensureAgent(req.role);
    if (req.freshPerRound) await agent.reset();
    const input: StepInput = {
      episodeId: req.episodeId,
      instruction: req.task,
      step: req.roundIndex,
      observation: req.observation,
    };
    if (role.interior_loop === true) {
      return this.interiorLoop(role, req, agent, input);
    }
    return this.singleStep(role, req, agent, input);
  }

  // -------------------------------------------------------------------------
  // 单次完成（m3 风格）：一次 predict，computer.* 动作交给 runner 执行。
  // -------------------------------------------------------------------------

  private async singleStep(
    role: RoleSpec,
    req: EpisodeRequest,
    agent: RoleAgent,
    input: StepInput,
  ): Promise<EpisodeResult> {
    const userMessage = this.buildUserMessage(role, req, input, []);
    const assistant = await agent.step(input, userMessage);
    const calls = assistantToolCalls(assistant);
    for (const call of calls) {
      await agent.append(toolResultMessage(call.id, call.name, "executed"));
    }
    await agent.compact(input);
    const actions = actionsFromToolCalls(calls);
    return {
      status: "done",
      report: actions.response ?? "M3 action",
      metadata: { actions: actions.actions },
    };
  }

  // -------------------------------------------------------------------------
  // 内部工具循环（stateact main / finish_gate / executor / auditor）
  // -------------------------------------------------------------------------

  private async interiorLoop(
    role: RoleSpec,
    req: EpisodeRequest,
    agent: RoleAgent,
    input: StepInput,
  ): Promise<EpisodeResult> {
    const terminal = new Set(role.terminal_tools ?? []);
    const session = this.session(req.episodeId, req.role);
    const turnsBefore = agent.turns;
    let liveObs = input.observation;

    let assistant;
    try {
      assistant = await agent.stepUntilDecision(
        input,
        this.buildUserMessage(role, req, input, session.plan),
        {
          executeTool: async (call) =>
            this.executeInteriorTool(role, req, call, input, {
              getObservation: () => liveObs,
              setObservation: (obs) => {
                liveObs = obs;
              },
            }, session),
          isTerminal: (name) => terminal.has(name),
          maxToolCalls: req.budget?.max_steps ?? 20,
          transform:
            role.refresh_state === true
              ? (messages) =>
                  this.refreshStateText(messages, req, input, liveObs, session.plan)
              : undefined,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("pi.loop_exhausted", {
        episode_id: req.episodeId,
        role: req.role,
        error: message,
      });
      return {
        status: "done",
        report: message,
        decision: { kind: "blocked", reason: message },
      };
    }

    const turnsDelta = agent.turns - turnsBefore;
    const calls = assistantToolCalls(assistant);
    const terminalCall = calls.find((call) => terminal.has(call.name));
    if (terminalCall) {
      session.nonFinishTurns += Math.max(0, turnsDelta - 1);
      return this.classifyTerminal(
        role,
        req,
        agent,
        input,
        terminalCall,
        session,
        liveObs,
      );
    }
    session.nonFinishTurns += turnsDelta;
    return {
      status: "done",
      report: assistantText(assistant) || "(no report)",
      decision: { kind: "execute" },
    };
  }

  private async classifyTerminal(
    role: RoleSpec,
    req: EpisodeRequest,
    agent: RoleAgent,
    input: StepInput,
    call: { id?: string; name: string; arguments: Record<string, unknown> },
    session: PiSession,
    observation: ObservationEnvelope,
  ): Promise<EpisodeResult> {
    const spec = this.options.spec;
    switch (call.name) {
      case "finish": {
        const minSteps = this.minStepsBeforeFinish();
        if (session.nonFinishTurns < minSteps) {
          void agent.append(
            toolResultMessage(
              call.id ?? "finish-call",
              "finish",
              `finish rejected: at least ${minSteps} non-finish model turns must pass before finishing. Continue working.`,
              true,
            ),
          );
          return {
            status: "done",
            report: "finish rejected too early",
            decision: { kind: "execute" },
          };
        }
        void agent.append(
          toolResultMessage(
            call.id ?? "finish",
            "finish",
            "finish requested; independent verification pending",
          ),
        );
        session.nonFinishTurns = 0;
        return {
          status: "done",
          report: "finish requested; verifying",
          decision: { kind: "done" },
        };
      }
      case "fail":
        return {
          status: "done",
          report: "Task failed",
          decision: { kind: "blocked", reason: "main agent declared fail" },
        };
      case "ask_user":
        return {
          status: "done",
          report: String(call.arguments.question ?? ""),
          decision: {
            kind: "ask",
            question: String(call.arguments.question ?? ""),
          },
        };
      default: {
        // delegate.*：执行委派（终结工具不进 executeTool），报告回灌 main 上下文
        const delegation = (this.options.spec.delegations ?? []).find(
          (d) => d.from_role === req.role && d.tool === call.name,
        );
        if (delegation) {
          const subtask = buildDelegatedTask(input.instruction, call.arguments);
          this.emit("delegate.start", {
            episode_id: req.episodeId,
            step: req.roundIndex,
            agent: delegation.to_role,
            objective: String(call.arguments.objective ?? ""),
            success_criteria: call.arguments.success_criteria,
          });
          const output = await this.invokeSubagent(
            delegation,
            input,
            subtask,
            observation,
          );
          this.emit("delegate.end", {
            episode_id: req.episodeId,
            step: req.roundIndex,
            agent: delegation.to_role,
            report: truncateText(output.report, 300),
            actions_summary: output.actions.join(", "),
          });
          await agent.append(
            toolResultMessage(
              call.id ?? "delegate",
              call.name,
              output.report,
            ),
          );
          return {
            status: "done",
            report: output.report,
            decision: { kind: "execute" },
          };
        }
        // 其他终结构造工具（如 finish_gate.verdict）
        if (this.isVerdictTool(req.role, call.name)) {
          this.emit("finish_gate.verdict", {
            episode_id: req.episodeId,
            step: req.roundIndex,
            role: req.role,
            accepted: Boolean(call.arguments.accepted),
            ...(typeof call.arguments.feedback === "string"
              ? { feedback: call.arguments.feedback }
              : {}),
          });
          return {
            status: "done",
            report: assistantTextForArgs(call.arguments),
            verdict: {
              accepted: Boolean(call.arguments.accepted),
              ...(typeof call.arguments.feedback === "string"
                ? { feedback: call.arguments.feedback }
                : {}),
            },
          };
        }
        return {
          status: "done",
          report: assistantTextForArgs(call.arguments),
          decision: { kind: "execute" },
        };
      }
    }
  }

  private async executeInteriorTool(
    role: RoleSpec,
    req: EpisodeRequest,
    call: { name: string; arguments: Record<string, unknown> },
    input: StepInput,
    obsRef: { getObservation(): ObservationEnvelope; setObservation(o: ObservationEnvelope): void },
    session: PiSession,
  ): Promise<ToolExecutionResult> {
    const spec = this.options.spec;
    if (role.plan_tool && call.name === role.plan_tool) {
      const items = Array.isArray(call.arguments.items)
        ? call.arguments.items.map(String)
        : [];
      session.plan = parsePlanItems(items);
      this.emit("plan.update", {
        episode_id: req.episodeId,
        step: req.roundIndex,
        items: session.plan.length,
      });
      return { text: formatPlan(session.plan), isError: false };
    }

    const decision = policyForRole(role).check(call.name);
    if (!decision.allow) {
      return {
        text: decision.reason ?? `${call.name} is disabled for the read-only role`,
        isError: true,
      };
    }
    const effectiveCall = decision.readonly
      ? { ...call, name: "state.inspect_python" }
      : call;

    if (!this.context.toolExecutor) {
      return {
        text: `tool ${call.name} is unavailable: no VM tool executor`,
        isError: true,
      };
    }
    const result = await this.context.toolExecutor.execute(effectiveCall);
    if (
      role.refresh_state === true &&
      isStateMutatingTool(effectiveCall.name) &&
      this.context.toolExecutor.observe
    ) {
      const fresh = await this.context.toolExecutor.observe();
      if (fresh) obsRef.setObservation(fresh);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // 消息拼法（A4：与旧 flow 逐字段对齐）
  // -------------------------------------------------------------------------

  private buildUserMessage(
    role: RoleSpec,
    req: EpisodeRequest,
    input: StepInput,
    plan: PlanItem[],
  ): UserMessage {
    const view = buildRoleView(role.observation, input.observation, "");
    const imageContent = input.observation.screenshotB64 && view.screenshot
      ? [{ type: "image" as const, data: view.screenshot, mimeType: input.observation.screenshotMime ?? "image/png" }]
      : [];
    const text = ((): string => {
      const base = (() => {
        switch (role.message_style ?? "engine") {
          case "raw_task":
            return req.task;
          case "state_text":
            return buildStateText(
              {
                task: req.task,
                roundIndex: req.roundIndex,
                observation: input.observation,
              },
              plan,
            );
          case "gate":
            return buildGateText(req, input);
          case "engine":
          default:
            return req.user;
        }
      })();
      return req.feedback
        ? `${base}\n\n## Verifier feedback\n${req.feedback}`
        : base;
    })();
    return {
      role: "user",
      content: [...imageContent, { type: "text", text }],
      timestamp: Date.now(),
    };
  }

  /** stateact main 的 transform：每轮把最新 state 文本写回最后一条 user 消息。 */
  private refreshStateText(
    messages: Message[],
    req: EpisodeRequest,
    input: StepInput,
    obs: ObservationEnvelope,
    plan: PlanItem[],
  ): Message[] {
    const base = buildStateText(
      { task: req.task, roundIndex: req.roundIndex, observation: obs },
      plan,
    );
    const text = req.feedback
      ? `${base}\n\n## Verifier feedback\n${req.feedback}`
      : base;
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex >= 0) {
      const last = messages[lastUserIndex] as UserMessage;
      messages[lastUserIndex] = {
        ...last,
        content: [{ type: "text", text }],
      };
    }
    return messages;
  }

  // -------------------------------------------------------------------------
  // 子代理（委派）：复用旧 RoleSubagent
  // -------------------------------------------------------------------------

  private async invokeSubagent(
    delegation: { id: string; to_role: string },
    input: StepInput,
    subtask: string,
    observation: ObservationEnvelope,
  ): Promise<SubagentOutput> {
    const sub = await this.ensureSubagent(delegation);
    return sub.invoke({
      episodeId: input.episodeId,
      instruction: input.instruction,
      task: subtask,
      step: input.step,
      observation,
    });
  }

  private async ensureSubagent(delegation: {
    id: string;
    to_role: string;
    terminal_tool?: string;
    fresh_context?: boolean;
    max_turns?: number;
  }): Promise<RoleSubagent> {
    let sub = this.subagents.get(delegation.id);
    if (!sub) {
      sub = new RoleSubagent({
        id: delegation.id,
        spec: {
          role: delegation.to_role,
          ...(delegation.fresh_context !== undefined
            ? { fresh_context: delegation.fresh_context }
            : {}),
          ...(delegation.max_turns !== undefined
            ? { max_turns: delegation.max_turns }
            : {}),
          ...(delegation.terminal_tool !== undefined
            ? { terminal_tool: delegation.terminal_tool }
            : {}),
        },
        context: this.context,
        ...(this.options.clientOverrides?.[delegation.to_role]
          ? { client: this.options.clientOverrides[delegation.to_role] }
          : {}),
      });
      await sub.initialize();
      this.subagents.set(delegation.id, sub);
    }
    return sub;
  }

  // -------------------------------------------------------------------------
  // 内部 helpers
  // -------------------------------------------------------------------------

  private async ensureAgent(role: string): Promise<RoleAgent> {
    let agent = this.agents.get(role);
    if (!agent) {
      const roleSpec = this.options.spec.roles[role];
      if (!roleSpec) throw new Error(`unknown role: ${role}`);
      agent = new RoleAgent({
        context: this.context,
        role,
        tools: resolveTools(roleSpec.tools),
        ...(this.options.clientOverrides?.[role]
          ? { client: this.options.clientOverrides[role] }
          : {}),
      });
      await agent.initialize();
      this.agents.set(role, agent);
    }
    return agent;
  }

  private session(episodeId: string, role: string): PiSession {
    const key = `${episodeId}:${role}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = { plan: [], nonFinishTurns: 0 };
      this.sessions.set(key, s);
    }
    return s;
  }

  private minStepsBeforeFinish(): number {
    const loop = this.options.spec.loop;
    if (loop.driver === "gate_verdict") {
      return loop.min_steps_before_finish ?? 3;
    }
    return 3;
  }

  private isVerdictTool(roleId: string, name: string): boolean {
    const spec = this.options.spec;
    if (spec.loop.driver !== "gate_verdict") return false;
    const gate = spec.gates?.[spec.loop.gate];
    return Boolean(gate && gate.role === roleId && gate.verdict_tool === name);
  }

  private emit(event: string, attrs: Record<string, unknown>): void {
    this.options.emit?.(event, attrs);
  }
}

// ---------------------------------------------------------------------------
// 消息格式 helpers（与旧 flow 逐字段一致）
// ---------------------------------------------------------------------------

export function buildStateText(
  req: { task: string; roundIndex: number; observation: ObservationEnvelope },
  plan: PlanItem[],
): string {
  return [
    `instruction: ${req.task}`,
    ...(plan.length > 0 ? [`plan:\n${formatPlan(plan)}`] : []),
    req.observation.terminal
      ? `terminal:\n${req.observation.terminal}`
      : null,
    req.observation.userResponse
      ? `user_response: ${req.observation.userResponse}`
      : null,
    `step: ${req.roundIndex}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildGateText(
  req: Pick<EpisodeRequest, "task">,
  input: Pick<StepInput, "observation">,
): string {
  return [
    `task instruction (verbatim): ${req.task}`,
    "Verify against the persisted artifact only. Never assume completion from narration.",
    ...(input.observation.terminal
      ? [`terminal:\n${input.observation.terminal}`]
      : []),
    ...(input.observation.userResponse
      ? [`user_response: ${input.observation.userResponse}`]
      : []),
  ].join("\n\n");
}

export function buildDelegatedTask(
  instruction: string,
  args: Record<string, unknown>,
): string {
  const lines = [
    `overall instruction: ${instruction}`,
    `delegated subtask: ${String(args.objective ?? "")}`,
  ];
  const criteria = args.success_criteria;
  if (Array.isArray(criteria) && criteria.length > 0) {
    lines.push("success criteria:", ...criteria.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

export function isWriteTool(name: string): boolean {
  return ["state.write_file", "state.edit_file", "state.bash", "state.python"].includes(name);
}

export function isStateMutatingTool(name: string): boolean {
  return [
    "state.bash",
    "state.python",
    "state.write_file",
    "state.edit_file",
  ].includes(name);
}

function assistantText(
  assistant: { content: Array<{ type: string; text?: string }> },
): string {
  return assistant.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

function assistantTextForArgs(args: Record<string, unknown>): string {
  return typeof args.report === "string" && args.report.trim()
    ? args.report
    : "(terminal decision)";
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(+${text.length - maxLength} chars)`;
}
