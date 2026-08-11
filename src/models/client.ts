import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  Models,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  createProvider,
  envApiKeyAuth,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelSamplingConfig } from "../legacy-config/spec.js";
import type { RunWriter } from "../telemetry/writer.js";
import { resolveModelRef, type ModelRef } from "./registry.js";

export interface LlmTraceMetadata {
  role: string;
  episodeId: string;
  step: number;
}

export interface PiModelClientOptions {
  writer?: RunWriter;
  includeImages?: boolean;
  /** Provider retry attempts on transient errors (Pi's retryProviderRequest). */
  maxRetries?: number;
  /** Cap on server-requested retry delays in milliseconds. */
  maxRetryDelayMs?: number;
  /** Per-role sampling knobs forwarded to Pi's provider stream options. */
  sampling?: ModelSamplingConfig;
}

export interface PiModelClient {
  complete(
    alias: string,
    context: Context,
    trace?: LlmTraceMetadata,
  ): Promise<AssistantMessage>;
}

export interface ResolvedPiModel {
  models: Models;
  model: Model<Api>;
  ref: ModelRef;
}

export function createPiModelClient(
  modelConfig: Record<string, string>,
  options: PiModelClientOptions = {},
): PiModelClient {
  const includeImages = options.includeImages ?? false;
  const maxRetries = options.maxRetries;
  const maxRetryDelayMs = options.maxRetryDelayMs;
  const sampling = options.sampling;
  return {
    async complete(alias, context, trace) {
      const { models, model, ref } = resolveModelForAlias(modelConfig, alias);
      const startedAt = Date.now();
      let assistant: AssistantMessage | undefined;
      let error: string | undefined;
      try {
        assistant = await models.complete(model, context, {
          cacheRetention: "none",
          ...samplingOptions(sampling),
          ...(maxRetries !== undefined ? { maxRetries } : {}),
          ...(maxRetryDelayMs !== undefined ? { maxRetryDelayMs } : {}),
        });
        return assistant;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        if (options.writer) {
          options.writer.llmTrace({
            role: trace?.role ?? alias,
            episode_id: trace?.episodeId,
            step: trace?.step,
            alias,
            provider: ref.provider,
            model: ref.id,
            duration_ms: Date.now() - startedAt,
            request: {
              system_prompt: context.systemPrompt,
              messages: context.messages.map((message) =>
                serializeMessage(message, includeImages),
              ),
              tools: context.tools,
            },
            response: error
              ? { error }
              : assistant
                ? serializeAssistant(assistant)
                : undefined,
          });
        }
      }
    },
  };
}

function samplingOptions(
  sampling?: ModelSamplingConfig,
): {
  temperature?: number;
  maxTokens?: number;
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;
} {
  if (!sampling) return {};
  return {
    ...(sampling.temperature !== undefined
      ? { temperature: sampling.temperature }
      : {}),
    ...(sampling.max_tokens !== undefined
      ? { maxTokens: sampling.max_tokens }
      : {}),
    ...(sampling.thinking_mode === "adaptive"
      ? {
          thinkingEnabled: true,
          ...(sampling.thinking_budget !== undefined
            ? { thinkingBudgetTokens: sampling.thinking_budget }
            : {}),
        }
      : sampling.thinking_mode === "disabled"
        ? { thinkingEnabled: false }
        : {}),
  };
}

/** Resolve a configured model alias to the Pi Models/Model pair used for completion and compaction. */
export function resolveModelForAlias(
  modelConfig: Record<string, string>,
  alias: string,
): ResolvedPiModel {
  const models = builtinModels();
  registerQwenGateway(models);
  const ref = resolveModelRef(modelConfig, alias);
  return { models, model: resolveModel(models, ref.provider, ref.id), ref };
}

const QWEN_GATEWAY_PROVIDER = "qwen-gateway";
const QWEN_GATEWAY_MODEL = "qwen3.7-plus";

/** Register parametrix's OpenAI-compatible gateway as an ad-hoc pi provider. */
function registerQwenGateway(models: MutableModels): void {
  if (models.getModel(QWEN_GATEWAY_PROVIDER, QWEN_GATEWAY_MODEL)) return;
  const baseUrl = process.env.OPENAI_BASE_URL;
  if (!baseUrl) return;
  models.setProvider(
    createProvider({
      id: QWEN_GATEWAY_PROVIDER,
      name: "Qwen Gateway (Parametrix)",
      baseUrl,
      auth: { apiKey: envApiKeyAuth("Parametrix API key", ["OPENAI_API_KEY"]) },
      models: [
        {
          id: QWEN_GATEWAY_MODEL,
          name: "Qwen3.7 Plus",
          api: "openai-completions",
          provider: QWEN_GATEWAY_PROVIDER,
          baseUrl,
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000000,
          maxTokens: 65536,
          compat: {
            thinkingFormat: "qwen",
            supportsDeveloperRole: false,
            supportsStore: false,
            supportsReasoningEffort: false,
          },
        },
      ],
      api: openAICompletionsApi(),
    }),
  );
}

export function serializeMessage(
  message: Message,
  includeImages = false,
): unknown {
  if (message.role === "user") {
    return {
      role: "user",
      content: serializeUserContent(message, includeImages),
      timestamp: message.timestamp,
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: serializeContent(message.content, includeImages),
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  return serializeAssistant(message);
}

function serializeUserContent(
  message: UserMessage,
  includeImages: boolean,
): unknown {
  if (typeof message.content === "string") return message.content;
  return serializeContent(message.content, includeImages);
}

function serializeContent(
  content: (TextContent | ImageContent)[],
  includeImages: boolean,
): unknown[] {
  return content.map((part) =>
    part.type === "image"
      ? includeImages
        ? part
        : { type: "image", mimeType: part.mimeType, dataLength: part.data.length }
      : part,
  );
}

function serializeAssistant(message: AssistantMessage): unknown {
  return {
    role: "assistant",
    content: message.content,
    usage: message.usage,
    stopReason: message.stopReason,
    responseModel: message.responseModel,
    responseId: message.responseId,
    errorMessage: message.errorMessage,
    timestamp: message.timestamp,
  };
}

function resolveModel(
  models: ReturnType<typeof builtinModels>,
  provider: string,
  id: string,
): Model<Api> {
  let model = models.getModel(provider, id);
  if (!model && provider === "anthropic") {
    // Anthropic-compatible endpoints (e.g. proxies or MiniMax) expose model ids
    // that are not in Pi's static catalog. Clone a catalog model and swap the id.
    const template =
      models.getModel("anthropic", "claude-sonnet-4-5") ??
      models.getModel("anthropic", "claude-opus-4-7");
    if (!template) throw new Error(`no anthropic template model available`);
    model = {
      ...template,
      id,
      name: id,
      compat: {
        ...template.compat,
        supportsCacheControlOnTools: false,
        supportsStrictTools: false,
        supportsTemperature: true,
      },
    };
  }
  if (!model) {
    throw new Error(`model not found: ${provider}/${id}`);
  }
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  return baseUrl && provider === "anthropic" ? { ...model, baseUrl } : model;
}
