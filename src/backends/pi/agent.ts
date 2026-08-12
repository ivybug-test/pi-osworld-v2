import type {
  AssistantMessage,
  Message,
  Tool,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  contextOptionsFromConfig,
  mergeContextConfig,
  PiContextManager,
} from "./context/manager.js";
import {
  applyM3ImageTruncation,
  type M3ImageTruncationOptions,
} from "./context/image-truncation.js";
import type { FlowContext, StepInput } from "./flow.js";
import {
  createPiModelClient,
  resolveModelForAlias,
  type PiModelClient,
} from "./models/client.js";
import type { ToolExecutionResult } from "./tools/executor.js";
import type { TurnSummary } from "../../engine/types.js";
import { resolvePrompt, type ResolvedPrompt } from "./prompt.js";

export interface RoleAgentOptions {
  context: FlowContext;
  role: string;
  tools: Tool[];
  /** Test seam: override the real model client. */
  client?: PiModelClient;
}

export interface ToolLoopOptions {
  executeTool: (call: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<ToolExecutionResult>;
  /** Tool calls that stop the loop and are handled by the flow. */
  isTerminal?: (name: string) => boolean;
  /** Cap on tool-call rounds inside one predict. Defaults to 20. */
  maxToolCalls?: number;
  transform?: (messages: Message[]) => Message[];
  /** Called after every model completion; return false to stop the loop early.
   *  第三个参数是该次调用的摘要（文本 + 工具名），供 orchestrator 记录活动日志。 */
  afterTurn?: (
    turn: number,
    costUsd: number,
    summary?: TurnSummary,
  ) => boolean | void | Promise<boolean | void>;
}

/**
 * One model role: prompt + model client + Pi-backed context manager.
 *
 * A topology is then just one or more RoleAgents plus its own orchestration
 * (e.g. m3 uses one, stateact chains main -> gui).
 */
export class RoleAgent {
  readonly role: string;
  readonly tools: Tool[];

  private readonly context: FlowContext;
  private readonly clientOverride?: PiModelClient;
  private prompt?: ResolvedPrompt;
  private client?: PiModelClient;
  private contextManager?: PiContextManager;
  private m3ImageTruncation?: M3ImageTruncationOptions;
  private turnCount = 0;
  private costUsd = 0;

  constructor(options: RoleAgentOptions) {
    this.context = options.context;
    this.role = options.role;
    this.tools = options.tools;
    this.clientOverride = options.client;
  }

  async initialize(): Promise<void> {
    const roleConfig = this.context.config.agents[this.role];
    if (!roleConfig) throw new Error(`unknown agent role: ${this.role}`);
    this.prompt = await resolvePrompt(roleConfig.prompt, this.context.root);
    this.client = this.clientOverride ?? this.createClient();
    const mergedContext = mergeContextConfig(
      this.context.config.context,
      roleConfig.context,
    );
    this.contextManager = new PiContextManager({
      ...contextOptionsFromConfig(mergedContext),
      onError: (message) =>
        this.context.writer.event("context.compact_failed", { error: message }),
    });
    const imageTruncation = mergedContext?.compaction?.image_truncation;
    this.m3ImageTruncation =
      mergedContext?.compaction?.strategy === "m3-image-truncation"
        ? {
            screenshotTurns: imageTruncation?.screenshot_turns,
            chunkSize: imageTruncation?.chunk_size,
            placeholder: imageTruncation?.placeholder,
          }
        : undefined;
  }

  async reset(): Promise<void> {
    await this.contextManager?.reset();
    this.turnCount = 0;
    this.costUsd = 0;
  }

  get turns(): number {
    return this.turnCount;
  }

  get cost(): number {
    return this.costUsd;
  }

  async append(message: Message): Promise<void> {
    await this.requireContextManager().append(message);
  }

  async estimatedTokens(): Promise<number> {
    return this.requireContextManager().estimatedTokens();
  }

  async step(
    input: StepInput,
    userMessage: UserMessage,
    transform?: (messages: Message[]) => Message[],
  ): Promise<AssistantMessage> {
    const prompt = this.requirePrompt();
    const contextManager = this.requireContextManager();
    await contextManager.append(userMessage);

    let messages = this.applyM3Truncation(await contextManager.build());
    if (transform) messages = transform(messages);

    const assistant = await this.requireClient().complete(
      this.role,
      {
        systemPrompt: [prompt.system, ...prompt.append].join("\n\n"),
        messages,
        tools: this.tools,
      },
      { role: this.role, episodeId: input.episodeId, step: input.step },
    );
    await contextManager.append(assistant);
    this.trackUsage(assistant);
    this.emitTurn(input, assistant);
    this.context.writer.telemetry({
      role: this.role,
      episode_id: input.episodeId,
      step: input.step,
      input_tokens: assistant.usage.input,
      output_tokens: assistant.usage.output,
      cost_usd: assistant.usage.cost.total,
    });
    return assistant;
  }

  /**
   * Keep completing until the model stops requesting executable tools.
   *
   * Executable tools are run through `executeTool` and their results are
   * appended before the next completion. Terminal calls (delegate/finish/...)
   * are left for the flow to handle; a message containing any terminal call
   * returns immediately so no tool call is left unresolved.
   */
  async stepUntilDecision(
    input: StepInput,
    userMessage: UserMessage,
    options: ToolLoopOptions,
  ): Promise<AssistantMessage> {
    const prompt = this.requirePrompt();
    const contextManager = this.requireContextManager();
    const maxToolCalls = options.maxToolCalls ?? 20;
    await contextManager.append(userMessage);

    for (let round = 0; round < maxToolCalls; round += 1) {
      let messages = this.applyM3Truncation(await contextManager.build());
      if (options.transform) messages = options.transform(messages);

      const assistant = await this.requireClient().complete(
        this.role,
        {
          systemPrompt: [prompt.system, ...prompt.append].join("\n\n"),
          messages,
          tools: this.tools,
        },
        { role: this.role, episodeId: input.episodeId, step: input.step },
      );
      await contextManager.append(assistant);
      this.trackUsage(assistant);
      this.emitTurn(input, assistant);
      this.context.writer.telemetry({
        role: this.role,
        episode_id: input.episodeId,
        step: input.step,
        input_tokens: assistant.usage.input,
        output_tokens: assistant.usage.output,
        cost_usd: assistant.usage.cost.total,
      });

      if (
        (await options.afterTurn?.(
          this.turnCount,
          this.costUsd,
          {
            text: summarizeAssistantText(assistant),
            tools: assistantToolCalls(assistant).map((call) => call.name),
          },
        )) === false
      ) {
        return assistant;
      }

      const calls = assistantToolCalls(assistant);
      if (calls.length === 0) return assistant;
      const executable = calls.filter(
        (call) => !(options.isTerminal?.(call.name) ?? false),
      );
      if (executable.length !== calls.length) return assistant;

      for (const call of executable) {
        let result: ToolExecutionResult;
        try {
          result = await options.executeTool(call);
        } catch (error) {
          result = {
            text: `tool ${call.name} execution failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            isError: true,
          };
        }
        await contextManager.append(
          toolResultMessage(
            call.id,
            call.name,
            result.text,
            result.isError,
            result.image,
          ),
        );
        this.context.writer.event("tool.execute", {
          role: this.role,
          episode_id: input.episodeId,
          step: input.step,
          tool: call.name,
          arguments: summarizeArgs(call.arguments),
          result: truncateText(result.text, 300),
          isError: result.isError,
        });
      }
    }

    throw new Error(
      `${this.role} did not reach a decision after ${maxToolCalls} tool-call rounds in one predict`,
    );
  }

  async compact(input: StepInput): Promise<void> {
    const contextManager = this.requireContextManager();
    const compacted = await contextManager.maybeCompact(
      resolveModelForAlias(this.context.config.models, this.role),
    );
    this.context.writer.event("context.tokens", {
      role: this.role,
      episode_id: input.episodeId,
      step: input.step,
      estimated_tokens: await contextManager.estimatedTokens(),
      compacted,
    });
  }

  private createClient(): PiModelClient {
    const roleConfig = this.context.config.agents[this.role];
    return createPiModelClient(this.context.config.models, {
      writer: this.context.writer,
      includeImages: this.context.config.trace?.include_images ?? false,
      maxRetries: this.context.config.llm_retry?.max_retries,
      maxRetryDelayMs: this.context.config.llm_retry?.max_retry_delay_ms,
      sampling: roleConfig?.model_options,
    });
  }

  private applyM3Truncation(messages: Message[]): Message[] {
    return this.m3ImageTruncation
      ? applyM3ImageTruncation(messages, this.m3ImageTruncation)
      : messages;
  }

  private trackUsage(assistant: AssistantMessage): void {
    this.turnCount += 1;
    this.costUsd += assistant.usage.cost.total;
  }

  private emitTurn(input: StepInput, assistant: AssistantMessage): void {
    this.context.writer.event("agent.turn", {
      role: this.role,
      episode_id: input.episodeId,
      step: input.step,
      turn: this.turnCount,
      text: summarizeAssistantText(assistant),
      tools: assistantToolCalls(assistant).map((call) => ({
        name: call.name,
        arguments: summarizeArgs(call.arguments),
      })),
    });
  }

  private requirePrompt(): ResolvedPrompt {
    if (!this.prompt) throw new Error(`RoleAgent ${this.role} is not initialized`);
    return this.prompt;
  }

  private requireClient(): PiModelClient {
    if (!this.client) throw new Error(`RoleAgent ${this.role} is not initialized`);
    return this.client;
  }

  private requireContextManager(): PiContextManager {
    if (!this.contextManager) {
      throw new Error(`RoleAgent ${this.role} is not initialized`);
    }
    return this.contextManager;
  }
}

export function assistantToolCalls(
  assistant: AssistantMessage,
): Array<Extract<AssistantMessage["content"][number], { type: "toolCall" }>> {
  return assistant.content.filter(
    (block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
      block.type === "toolCall",
  );
}

/** Human-readable reason when a model completion failed, or undefined. */
export function modelErrorMessage(
  assistant: AssistantMessage,
): string | undefined {
  if (assistant.stopReason !== "error" && !assistant.errorMessage) {
    return undefined;
  }
  return assistant.errorMessage || "model returned an error response";
}

export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  text: string,
  isError = false,
  image?: { mimeType: string; data: string },
): Message {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [
      { type: "text", text },
      ...(image
        ? [{ type: "image" as const, data: image.data, mimeType: image.mimeType }]
        : []),
    ],
    isError,
    timestamp: Date.now(),
  };
}

function summarizeAssistantText(assistant: AssistantMessage): string {
  const text = assistant.content
    .filter(
      (block): block is Extract<AssistantMessage["content"][number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
  return truncateText(text, 300);
}

function summarizeArgs(args: Record<string, unknown>): string {
  try {
    return truncateText(JSON.stringify(args), 200);
  } catch {
    return String(args);
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(+${text.length - maxLength} chars)`;
}
