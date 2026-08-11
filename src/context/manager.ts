import { randomUUID } from "node:crypto";
import type { Api, Message, Model, Models } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  InMemorySessionStorage,
  Session,
  shouldCompact,
  type AgentMessage,
  type CompactionSettings,
} from "@earendil-works/pi-agent-core";
import type { ContextConfig } from "../legacy-config/spec.js";
import {
  createCompactionStrategy,
  type CompactionStrategy,
  type CompactionStrategyId,
  type TurnRetentionConfig,
  sanitizeAgentMessages,
} from "./compaction.js";
import type { M3ImageTruncationOptions } from "./image-truncation.js";

export interface PiContextOptions {
  /** Model context window used for compaction decisions. */
  contextWindow?: number;
  compaction?: Partial<CompactionSettings>;
  /** Strategy used when the context window is crossed. Defaults to pi-summary. */
  strategy?: CompactionStrategyId;
  turnRetention?: TurnRetentionConfig;
  /** M3-style image truncation knobs; applied as a view transform by RoleAgent. */
  imageTruncation?: M3ImageTruncationOptions;
  /** Called when compaction fails; the run continues with the full history. */
  onError?: (message: string) => void;
}

export interface CompactRequest {
  models: Models;
  model: Model<Api>;
  customInstructions?: string;
}

export function contextOptionsFromConfig(
  config?: ContextConfig,
): PiContextOptions {
  return {
    contextWindow: config?.context_window,
    strategy: config?.compaction?.strategy,
    turnRetention: config?.compaction?.turn_retention,
    imageTruncation: config?.compaction?.image_truncation
      ? {
          screenshotTurns: config.compaction.image_truncation.screenshot_turns,
          chunkSize: config.compaction.image_truncation.chunk_size,
          placeholder: config.compaction.image_truncation.placeholder,
        }
      : undefined,
    compaction: config?.compaction
      ? {
          enabled: config.compaction.enabled,
          reserveTokens: config.compaction.reserve_tokens,
          keepRecentTokens: config.compaction.keep_recent_tokens,
        }
      : undefined,
  };
}

/**
 * Merge the experiment-level context block with a role-level override.
 * Role-level compaction fields win, but unspecified fields keep the global
 * defaults (e.g. main keeps reserve_tokens while overriding strategy).
 */
export function mergeContextConfig(
  global?: ContextConfig,
  role?: string | ContextConfig,
): ContextConfig | undefined {
  if (typeof role === "string" || role === undefined) return global;
  const globalCompaction = global?.compaction ?? {};
  return {
    ...global,
    ...role,
    context_window: role.context_window ?? global?.context_window,
    compaction: role.compaction
      ? {
          ...globalCompaction,
          ...role.compaction,
          turn_retention:
            role.compaction.turn_retention ?? globalCompaction.turn_retention,
          image_truncation:
            role.compaction.image_truncation ?? globalCompaction.image_truncation,
        }
      : global?.compaction,
  };
}

/**
 * Per-role conversation context backed by Pi's session store.
 *
 * Messages are appended as immutable session entries; each predict rebuilds
 * the LLM view through Pi's buildSessionContext/convertToLlm, and optional
 * compaction replaces old history with a summary once the context window
 * threshold is crossed.
 */
export class PiContextManager {
  private session: Session;
  private readonly settings: CompactionSettings;
  private readonly contextWindow: number;
  private readonly strategy: CompactionStrategy;
  private readonly onError?: (message: string) => void;

  constructor(options: PiContextOptions = {}) {
    this.settings = {
      ...DEFAULT_COMPACTION_SETTINGS,
      ...options.compaction,
    };
    this.contextWindow = options.contextWindow ?? 200_000;
    this.strategy = createCompactionStrategy(
      options.strategy ?? "pi-summary",
      options.turnRetention,
    );
    this.onError = options.onError;
    this.session = this.createSession();
  }

  async reset(): Promise<void> {
    this.session = this.createSession();
  }

  async append(message: Message): Promise<void> {
    await this.session.appendMessage(message as AgentMessage);
  }

  async build(): Promise<Message[]> {
    const entries = await this.session.findEntriesOnBranch({ order: "oldestFirst" });
    const context = buildSessionContext(entries);
    return convertToLlm(context.messages);
  }

  async estimatedTokens(): Promise<number> {
    const entries = await this.session.findEntriesOnBranch({ order: "oldestFirst" });
    const context = buildSessionContext(entries);
    return estimateContextTokens(context.messages).tokens;
  }

  /**
   * Compact the session when estimated tokens exceed the configured window.
   * Returns true when a summary was written; failures are reported and never
   * interrupt the step.
   */
  async maybeCompact(request: CompactRequest): Promise<boolean> {
    const entries = await this.session.findEntriesOnBranch({ order: "oldestFirst" });
    const context = buildSessionContext(entries);
    const tokens = estimateContextTokens(context.messages).tokens;
    if (!shouldCompact(tokens, this.contextWindow, this.settings)) return false;

    try {
      const outcome = await this.strategy.compact(
        entries,
        this.settings,
        request,
      );
      if (!outcome) return false;
      const entry = {
        type: "compaction" as const,
        id: randomUUID(),
        summary: outcome.summary,
        retainedTail: sanitizeAgentMessages(outcome.retainedTail),
        tokensBefore: outcome.tokensBefore,
        ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
        ...(outcome.details !== undefined ? { details: outcome.details } : {}),
      };
      await this.session.appendEntry(
        entry,
        "main",
      );
      return true;
    } catch (error) {
      this.onError?.(
        `context compaction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private createSession(): Session {
    const storage = new InMemorySessionStorage({
      id: randomUUID(),
      createdAt: Date.now(),
    });
    return new Session(storage);
  }
}
