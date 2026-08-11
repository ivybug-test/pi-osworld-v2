import type { UserMessage } from "@earendil-works/pi-ai";
import {
  assistantToolCalls,
  modelErrorMessage,
  RoleAgent,
} from "../agents/role.js";
import type { FlowContext, StepInput } from "../flows/types.js";
import type { PiModelClient } from "../models/client.js";
import type { ObservationEnvelope } from "../observation/router.js";
import { resolveTools } from "../tools/registry.js";

export interface FinishGateOptions {
  /** Test seam: per-role model client overrides keyed by agent role id. */
  clients?: Record<string, PiModelClient>;
}

export interface FinishGateVerdict {
  accepted: boolean;
  feedback?: string;
}

/**
 * Independent verifier for the StateAct finish gate.
 *
 * Each verification runs in a fresh context seeded with only the verbatim task
 * instruction plus the current VM observation. It never sees the main agent's
 * history, plan, or finish rationale. The gate only inspects the persisted
 * artifact through a read-only tool set; write/edit/bash tools are blocked by
 * the executor wrapper so the verifier cannot mutate the deliverable.
 */
export class FinishGate {
  private readonly clients?: Record<string, PiModelClient>;
  private context?: FlowContext;
  private agent?: RoleAgent;

  constructor(options: FinishGateOptions = {}) {
    this.clients = options.clients;
  }

  async initialize(context: FlowContext): Promise<void> {
    const roleConfig = context.config.agents["finish_gate"];
    if (!roleConfig) {
      throw new Error(
        "finish gate requires an agents.finish_gate role in the experiment config",
      );
    }
    this.context = context;
    this.agent = new RoleAgent({
      context,
      role: "finish_gate",
      tools: resolveTools(roleConfig.tools),
      ...(this.clients?.finish_gate
        ? { client: this.clients.finish_gate }
        : {}),
    });
    await this.agent.initialize();
  }

  async reset(): Promise<void> {
    await this.agent?.reset();
  }

  get cost(): number {
    return this.agent?.cost ?? 0;
  }

  async verify(input: StepInput): Promise<FinishGateVerdict> {
    try {
      return await this.verifyInner(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.context?.writer.event("finish_gate.error", {
        episode_id: input.episodeId,
        step: input.step,
        error: message,
      });
      return {
        accepted: false,
        feedback: `Verifier failed: ${message}`,
      };
    }
  }

  private async verifyInner(input: StepInput): Promise<FinishGateVerdict> {
    const context = this.context;
    const agent = this.agent;
    if (!context || !agent) {
      throw new Error("FinishGate is not initialized");
    }

    // Fresh context per verification: the gate must not inherit the previous
    // verdict or the main agent's trajectory.
    await agent.reset();

    const observation = input.observation;
    const stateText = buildGateObservation(input.instruction, observation);
    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: stateText }],
      timestamp: Date.now(),
    };

    const assistant = await agent.stepUntilDecision(
      input,
      userMessage,
      {
        executeTool: (call) => {
          if (isWriteTool(call.name)) {
            return Promise.resolve({
              text: `${call.name} is disabled for the read-only finish gate`,
              isError: true,
            });
          }
          return context.toolExecutor
            ? context.toolExecutor.execute(call)
            : Promise.resolve({
                text: `tool ${call.name} is unavailable: no VM tool executor`,
                isError: true,
              });
        },
        isTerminal: (name) => name === "finish_gate.verdict",
        maxToolCalls: context.config.agents["finish_gate"].budget?.max_steps ?? 20,
      },
    );

    const modelError = modelErrorMessage(assistant);
    if (modelError) {
      context.writer.event("finish_gate.error", {
        episode_id: input.episodeId,
        step: input.step,
        error: modelError,
      });
      return {
        accepted: false,
        feedback: `Finish gate model error: ${modelError}`,
      };
    }

    const verdictCall = assistantToolCalls(assistant).find(
      (call) => call.name === "finish_gate.verdict",
    );
    if (!verdictCall) {
      context.writer.event("finish_gate.missing_verdict", {
        episode_id: input.episodeId,
        step: input.step,
      });
      return {
        accepted: false,
        feedback: "Finish gate did not produce a verdict; re-verify the deliverable.",
      };
    }

    const accepted = Boolean(verdictCall.arguments.accepted);
    const feedback = String(verdictCall.arguments.feedback ?? "");
    context.writer.event("finish_gate.verdict", {
      episode_id: input.episodeId,
      step: input.step,
      accepted,
      ...(feedback ? { feedback } : {}),
    });
    return {
      accepted,
      feedback: accepted ? undefined : feedback || "Verifier rejected the deliverable.",
    };
  }
}

function buildGateObservation(
  instruction: string,
  observation: ObservationEnvelope,
): string {
  const parts = [
    `task instruction (verbatim): ${instruction}`,
    "Verify against the persisted artifact only. Never assume completion from narration.",
  ];
  if (observation.terminal) {
    parts.push(`terminal:\n${observation.terminal}`);
  }
  if (observation.userResponse) {
    parts.push(`user_response: ${observation.userResponse}`);
  }
  return parts.join("\n\n");
}

function isWriteTool(name: string): boolean {
  return ["state.write_file", "state.edit_file", "state.bash", "state.python"].includes(name);
}
