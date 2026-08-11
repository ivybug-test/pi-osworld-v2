import type { AssistantMessage, ImageContent, UserMessage } from "@earendil-works/pi-ai";
import {
  assistantToolCalls,
  RoleAgent,
  toolResultMessage,
} from "../agents/role.js";
import type { ObservationPolicy } from "../legacy-config/spec.js";
import { buildRoleView } from "../observation/router.js";
import type { ObservationEnvelope } from "../observation/router.js";
import { resolveTools } from "../tools/registry.js";
import type { Subagent, SubagentInput, SubagentOptions, SubagentOutput } from "./types.js";

/**
 * A subagent backed by one RoleAgent.
 *
 * Delegation semantics differ from a plain tool call: by default the context
 * is reset before every invocation, so each delegation runs in a fresh window
 * seeded only with the focused subtask, matching StateAct's fresh-context
 * specialists.
 */
export class RoleSubagent implements Subagent {
  readonly id: string;

  private readonly spec: SubagentOptions["spec"];
  private readonly context: SubagentOptions["context"];
  private readonly clientOverride?: SubagentOptions["client"];
  private readonly onTurn?: SubagentOptions["onTurn"];
  private agent?: RoleAgent;

  constructor(options: SubagentOptions) {
    this.id = options.id;
    this.spec = options.spec;
    this.context = options.context;
    this.clientOverride = options.client;
    this.onTurn = options.onTurn;
  }

  async initialize(): Promise<void> {
    const roleConfig = this.context.config.agents[this.spec.role];
    if (!roleConfig) throw new Error(`unknown agent role for subagent ${this.id}: ${this.spec.role}`);
    this.agent = new RoleAgent({
      context: this.context,
      role: this.spec.role,
      tools: resolveTools(roleConfig.tools),
      ...(this.clientOverride ? { client: this.clientOverride } : {}),
    });
    await this.agent.initialize();
  }

  async reset(): Promise<void> {
    await this.agent?.reset();
  }

  get cost(): number {
    return this.agent?.cost ?? 0;
  }

  async close(): Promise<void> {}

  async invoke(input: SubagentInput): Promise<SubagentOutput> {
    try {
      return await this.runLoop(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.context.writer.event("subagent.error", {
        subagent: this.id,
        episode_id: input.episodeId,
        step: input.step,
        error: truncateText(message, 500),
      });
      return {
        report: `subagent ${this.id} failed: ${message}`,
        actions: [],
      };
    }
  }

  private async runLoop(input: SubagentInput): Promise<SubagentOutput> {
    const agent = this.agent;
    const roleConfig = this.context.config.agents[this.spec.role];
    if (!agent || !roleConfig) {
      throw new Error(`subagent ${this.id} is not initialized`);
    }
    if (this.spec.fresh_context !== false) {
      await agent.reset();
    }

    const maxTurns = this.spec.max_turns ?? 50;
    let observation = input.observation;
    let lastAssistant: AssistantMessage | undefined;

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const userMessage = this.buildUserMessage(
        roleConfig.observation,
        input,
        observation,
      );
      lastAssistant = await agent.step(
        {
          episodeId: input.episodeId,
          instruction: input.instruction,
          step: input.step,
          observation,
        },
        userMessage,
      );
      if (this.onTurn?.() === false) break;

      const calls = assistantToolCalls(lastAssistant);
      if (calls.length === 0) {
        const report = this.extractReport(lastAssistant, calls);
        await agent.compact(input);
        return { report, actions: [] };
      }

      const terminal = this.spec.terminal_tool
        ? calls.find((call) => call.name === this.spec.terminal_tool)
        : undefined;
      const executable = terminal
        ? calls.filter((call) => call !== terminal)
        : calls;

      let touchedGui = false;
      for (const call of executable) {
        const result = await this.executeTool(call);
        await agent.append(
          toolResultMessage(call.id, call.name, result.text, result.isError),
        );
        if (result.image) {
          await agent.append({
            role: "user",
            content: [
              { type: "image", data: result.image.data, mimeType: result.image.mimeType },
              { type: "text", text: `image returned by ${call.name}` },
            ],
            timestamp: Date.now(),
          });
        }
        this.context.writer.event("subagent.tool.execute", {
          subagent: this.id,
          episode_id: input.episodeId,
          step: input.step,
          tool: call.name,
          arguments: summarizeArgs(call.arguments),
          result: truncateText(result.text, 300),
          isError: result.isError,
        });
        if (call.name.startsWith("computer.")) touchedGui = true;
      }

      if (terminal) {
        const report = this.extractReport(lastAssistant, calls);
        await agent.compact(input);
        return { report, actions: [] };
      }

      // GUI actions change the screen; refresh the observation so the next
      // model turn sees the result of what it just did.
      if (touchedGui && this.context.toolExecutor?.observe) {
        const fresh = await this.context.toolExecutor.observe();
        if (fresh?.screenshotB64) observation = fresh;
      }
    }

    await agent.compact(input);
    return {
      report: lastAssistant
        ? this.extractReport(lastAssistant, assistantToolCalls(lastAssistant))
        : "no report",
      actions: [],
    };
  }

  private buildUserMessage(
    observationPolicy: ObservationPolicy,
    input: SubagentInput,
    observation: ObservationEnvelope,
  ): UserMessage {
    const view = buildRoleView(observationPolicy, observation, input.task);
    const imageContent: ImageContent[] = view.screenshot
      ? [{ type: "image", data: view.screenshot, mimeType: "image/png" }]
      : [];
    const textParts: string[] = [];
    if (view.stateText) {
      textParts.push(view.stateText);
    } else {
      textParts.push(input.task);
    }
    if (view.accessibilityTree) {
      textParts.push(`accessibility_tree:\n${view.accessibilityTree}`);
    }
    if (view.terminal) {
      textParts.push(`terminal:\n${view.terminal}`);
    }
    if (view.userResponse) {
      textParts.push(`user_response: ${view.userResponse}`);
    }
    return {
      role: "user",
      content: [...imageContent, { type: "text", text: textParts.join("\n\n") }],
      timestamp: Date.now(),
    };
  }

  private async executeTool(call: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ text: string; isError: boolean; image?: { mimeType: string; data: string } }> {
    if (!this.context.toolExecutor) {
      return {
        text: `tool ${call.name} is unavailable: no VM tool executor`,
        isError: true,
      };
    }
    try {
      return await this.context.toolExecutor.execute(call);
    } catch (error) {
      return {
        text: `tool ${call.name} execution failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }
  }

  private extractReport(
    assistant: AssistantMessage,
    calls: Array<{ name: string; arguments: Record<string, unknown> }>,
  ): string {
    const terminal = this.spec.terminal_tool;
    if (terminal) {
      const complete = calls.find((call) => call.name === terminal);
      const report = complete?.arguments.report;
      if (typeof report === "string" && report.trim()) return report;
    }
    const text = assistant.content
      .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> =>
        block.type === "text",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();
    return text || "no report";
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(+${text.length - maxLength} chars)`;
}

function summarizeArgs(args: Record<string, unknown>): string {
  try {
    return truncateText(JSON.stringify(args), 200);
  } catch {
    return String(args);
  }
}
