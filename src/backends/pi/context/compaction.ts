import type { Api, Model, Models, Usage } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  compact,
  estimateContextTokens,
  generateSummary,
  prepareCompaction,
  type AgentMessage,
  type CompactionSettings,
  type Entry,
} from "@earendil-works/pi-agent-core";

export type CompactionStrategyId =
  | "pi-summary"
  | "turn-retention"
  | "m3-image-truncation"
  | "truncate"
  | "none";

export interface TurnRetentionConfig {
  /** Keep screenshot blocks from the last N turns; older images become text placeholders. */
  screenshot_turns?: number;
  /** Keep raw text for the last N turns; older turns are summarized or truncated. */
  text_turns?: number;
  /** Summarize dropped text with the model; false truncates it without an extra LLM call. */
  summarize_text?: boolean;
}

export interface CompactRequest {
  models: Models;
  model: Model<Api>;
  customInstructions?: string;
}

export interface CompactOutcome {
  summary: string;
  retainedTail: AgentMessage[];
  tokensBefore: number;
  usage?: Usage;
  details?: unknown;
}

/**
 * A compaction strategy turns old session entries into a summary plus a
 * recent tail. Strategies only run after PiContextManager's threshold check.
 */
export interface CompactionStrategy {
  readonly id: CompactionStrategyId;
  compact(
    entries: Entry[],
    settings: CompactionSettings,
    request: CompactRequest,
  ): Promise<CompactOutcome | undefined>;
}

const TRUNCATE_SUMMARY =
  "Older conversation messages were truncated to keep the context window small.";

class PiSummaryCompactor implements CompactionStrategy {
  readonly id = "pi-summary" as const;

  async compact(
    entries: Entry[],
    settings: CompactionSettings,
    request: CompactRequest,
  ): Promise<CompactOutcome | undefined> {
    const preparationResult = prepareCompaction(entries, settings);
    if (!preparationResult.ok) throw new Error(preparationResult.error.message);
    const preparation = preparationResult.value;
    if (!preparation) return undefined;

    const result = await compact(
      preparation,
      request.models,
      request.model,
      request.customInstructions,
    );
    if (!result.ok) throw new Error(result.error.message);
    return {
      summary: result.value.summary,
      retainedTail: result.value.retainedTail,
      tokensBefore: result.value.tokensBefore,
      usage: result.value.usage,
      details: result.value.details,
    };
  }
}

class TruncateCompactor implements CompactionStrategy {
  readonly id = "truncate" as const;

  async compact(
    entries: Entry[],
    settings: CompactionSettings,
  ): Promise<CompactOutcome | undefined> {
    const preparationResult = prepareCompaction(entries, settings);
    if (!preparationResult.ok) throw new Error(preparationResult.error.message);
    const preparation = preparationResult.value;
    if (!preparation) return undefined;

    const retainedTail = preparation.isSplitTurn
      ? [...preparation.turnPrefixMessages, ...preparation.retainedTail]
      : preparation.retainedTail;
    return {
      summary: TRUNCATE_SUMMARY,
      retainedTail,
      tokensBefore: preparation.tokensBefore,
    };
  }
}

class TurnRetentionCompactor implements CompactionStrategy {
  readonly id = "turn-retention" as const;

  constructor(private readonly config: TurnRetentionConfig = {}) {}

  async compact(
    entries: Entry[],
    settings: CompactionSettings,
    request: CompactRequest,
  ): Promise<CompactOutcome | undefined> {
    const messages = buildSessionContext(entries).messages;
    const screenshotTurns = this.config.screenshot_turns ?? 3;
    const textTurns = this.config.text_turns ?? 10;
    const summarizeText = this.config.summarize_text ?? true;
        const tokensBefore = estimateContextTokens(messages).tokens;

        const turns = assignTurns(messages);
        const retainedTail = turns
      .filter(({ turnFromEnd }) => turnFromEnd < textTurns)
      .map(({ message, turnFromEnd }) =>
        retainScreenshots(message, turnFromEnd, screenshotTurns),
      );
    const toSummarize = turns
      .filter(({ turnFromEnd }) => turnFromEnd >= textTurns)
      .map(({ message }) => message);
    if (toSummarize.length === 0) return undefined;

    const summary = summarizeText
      ? await summarizeTurns(toSummarize, request, settings)
      : TRUNCATE_SUMMARY;
    return { summary, retainedTail, tokensBefore };
  }
}

async function summarizeTurns(
  messages: AgentMessage[],
  request: CompactRequest,
  settings: CompactionSettings,
): Promise<string> {
  const summaryResult = await generateSummary(
    messages,
    request.models,
    request.model,
    settings.reserveTokens,
  );
  if (!summaryResult.ok) throw new Error(summaryResult.error.message);
  return summaryResult.value;
}

class NoneCompactor implements CompactionStrategy {
  readonly id = "none" as const;

  async compact(): Promise<CompactOutcome | undefined> {
    return undefined;
  }
}

export function createCompactionStrategy(
  id: CompactionStrategyId,
  turnRetention?: TurnRetentionConfig,
): CompactionStrategy {
  switch (id) {
    case "pi-summary":
      return new PiSummaryCompactor();
    case "turn-retention":
      return new TurnRetentionCompactor(turnRetention);
    case "m3-image-truncation":
      // Image truncation is applied as a deterministic view transform before
      // each completion (see RoleAgent), never as a model-backed summary.
      return new NoneCompactor();
    case "truncate":
      return new TruncateCompactor();
    case "none":
      return new NoneCompactor();
  }
}

interface TurnMessage {
  message: AgentMessage;
  turnFromEnd: number;
}

function assignTurns(messages: AgentMessage[]): TurnMessage[] {
  let turn = 0;
  const turnByIndex: number[] = [];
  for (const message of messages) {
    if (message.role === "user") turn += 1;
    turnByIndex.push(turn);
  }
  const totalTurns = turn;
  return messages.map((message, index) => ({
    message,
    turnFromEnd: totalTurns - turnByIndex[index],
  }));
}

function retainScreenshots(
  message: AgentMessage,
  turnFromEnd: number,
  screenshotTurns: number,
): AgentMessage {
  if (message.role !== "user" && message.role !== "toolResult") return message;
  const content = message.content;
  if (typeof content === "string") return message;
  const retained = content.map((block) =>
    block.type === "image" && turnFromEnd >= screenshotTurns
      ? { type: "text" as const, text: "[screenshot omitted]" }
      : block,
  );
  return { ...message, content: retained };
}

function cleanValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanValue);
  if (value !== null && typeof value === "object") {
    const cleaned: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      cleaned[key] = cleanValue(item);
    }
    return cleaned;
  }
  return value;
}

/**
 * Strip undefined fields before persisting messages on a compaction entry.
 * Pi's session storage rejects durable payloads that contain undefined values.
 */
export function sanitizeAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => cleanValue(message) as AgentMessage);
}
