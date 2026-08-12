import { appendFileSync, mkdirSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

export interface RunWriterOptions {
  /** Print human-readable event lines to stderr as they happen. */
  verbose?: boolean;
}

export class RunWriter {
  readonly resultDir: string;
  private readonly llmTracePath: string;
  private readonly verbose: boolean;
  private llmHandle?: FileHandle;
  private llmQueue: Promise<void> = Promise.resolve();

  constructor(resultDir: string, options: RunWriterOptions = {}) {
    this.resultDir = resultDir;
    this.verbose = options.verbose ?? false;
    this.llmTracePath = path.join(resultDir, "llm_traces.jsonl");
    mkdirSync(resultDir, { recursive: true });
  }

  event(name: string, attributes: Record<string, unknown>): void {
    this.append("events.jsonl", { timestamp: Date.now(), event: name, ...attributes });
    if (this.verbose) {
      process.stderr.write(`${formatEvent(name, attributes)}\n`);
    }
  }

  telemetry(attributes: Record<string, unknown>): void {
    this.append("telemetry.jsonl", { timestamp: Date.now(), ...attributes });
  }

  llmTrace(attributes: Record<string, unknown>): void {
    const line = `${JSON.stringify({ timestamp: Date.now(), ...attributes })}\n`;
    // Queue the write instead of blocking the model request path. The queue
    // keeps records ordered and is drained by flushLlm() before the bridge exits.
    this.llmQueue = this.llmQueue
      .then(() => this.appendLlm(line))
      .catch((error: unknown) => {
        process.stderr.write(
          `[pi-osworld] llm trace write failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
  }

  async flushLlm(): Promise<void> {
    await this.llmQueue;
    if (this.llmHandle) {
      await this.llmHandle.close();
      this.llmHandle = undefined;
    }
  }

  private async appendLlm(line: string): Promise<void> {
    if (!this.llmHandle) {
      this.llmHandle = await open(this.llmTracePath, "a");
    }
    await this.llmHandle.write(line, null, "utf8");
  }

  private append(file: string, record: Record<string, unknown>): void {
    appendFileSync(path.join(this.resultDir, file), `${JSON.stringify(record)}\n`);
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(+${text.length - maxLength} chars)`;
}

function formatEvent(name: string, attributes: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const step =
    typeof attributes.step === "number" ? ` step=${attributes.step}` : "";
  const badge = eventRole(name, attributes);
  const body = formatEventBody(name, attributes);
  return `[pi-osworld] ${ts} ${badge}${step} ${name} | ${body}`;
}

function eventRole(name: string, attributes: Record<string, unknown>): string {
  if (name === "main.decision") return "[main]";
  if (typeof attributes.role === "string" && attributes.role) {
    return `[${attributes.role}]`;
  }
  if (typeof attributes.subagent === "string" && attributes.subagent) {
    return `[sub:${attributes.subagent}]`;
  }
  if (name.startsWith("finish_gate.")) return "[finish_gate]";
  if (name.startsWith("delegate.")) return "[delegation]";
  if (
    name.startsWith("bridge.") ||
    name.startsWith("episode.") ||
    name.startsWith("flow.")
  ) {
    return "[flow]";
  }
  return "[pi-osworld]";
}

function formatEventBody(name: string, attributes: Record<string, unknown>): string {
  switch (name) {
    case "agent.turn":
      return [
        `turn=${attributes.turn ?? "?"}`,
        attributes.text ? `text="${truncate(String(attributes.text), 300)}"` : "",
        attributes.tools
          ? `tools=${summarizeTools(attributes.tools)}`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
    case "tool.execute":
      return formatToolExecution(attributes);
    case "subagent.tool.execute":
      return formatToolExecution(attributes, "subagent");
    case "delegate.start":
      return [
        `agent=${attributes.agent ?? "?"}`,
        `objective="${truncate(String(attributes.objective ?? ""), 300)}"`,
        attributes.success_criteria
          ? `criteria=${summarizeValue(attributes.success_criteria, 200)}`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
    case "delegate.end":
      return [
        `agent=${attributes.agent ?? "?"}`,
        attributes.report
          ? `report="${truncate(String(attributes.report), 300)}"`
          : "",
        attributes.actions_summary
          ? `actions=${attributes.actions_summary}`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
    case "main.decision":
      return [
        `action=${attributes.action ?? "?"}`,
        attributes.question
          ? `question="${truncate(String(attributes.question), 300)}"`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
    case "finish_gate.verdict":
    case "finish_gate.result":
      return [
        `accepted=${String(attributes.accepted)}`,
        attributes.rounds ? `rounds=${attributes.rounds}` : "",
        attributes.feedback
          ? `feedback="${truncate(String(attributes.feedback), 300)}"`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
    case "flow.predict":
      return [
        `actions=${attributes.actions ?? "?"}`,
        `responseLength=${attributes.responseLength ?? "?"}`,
      ].join(" ");
    case "episode.reset":
      return `episode=${String(
        attributes.episode_id ?? attributes.episodeId ?? "?",
      )}`;
    case "bridge.initialize":
      return `topology=${String(attributes.topology ?? "?")}`;
    case "context.tokens":
      return [
        `tokens=${attributes.estimated_tokens ?? "?"}`,
        `compacted=${String(attributes.compacted)}`,
      ].join(" ");
    case "budget.exceeded":
      return summarizeValue(omitCommon(attributes), 400);
    case "context.compact_failed":
    case "bridge.error":
    case "subagent.error":
    case "finish_gate.error":
    case "finish_gate.missing_verdict":
      return attributes.error
        ? `error="${truncate(String(attributes.error), 400)}"`
        : summarizeValue(omitCommon(attributes), 400);
    default:
      return summarizeValue(omitCommon(attributes), 400);
  }
}

function formatToolExecution(
  attributes: Record<string, unknown>,
  kind: "agent" | "subagent" = "agent",
): string {
  const who = kind === "subagent" ? attributes.subagent : attributes.role;
  const whoPart = kind === "subagent" && who ? `${kind}=${who}` : "";
  const parts = [
    whoPart,
    attributes.tool ? `tool=${attributes.tool}` : "",
    attributes.arguments ? `args=${summarizeValue(attributes.arguments, 200)}` : "",
    attributes.result
      ? `result="${truncate(String(attributes.result), 200)}"`
      : "",
    attributes.isError ? "ERROR" : "",
  ];
  return parts.filter(Boolean).join(" ");
}

function summarizeTools(tools: unknown): string {
  if (!Array.isArray(tools)) return String(tools);
  return tools
    .map((tool) => {
      if (typeof tool !== "object" || tool === null) return String(tool);
      const record = tool as Record<string, unknown>;
      return record.arguments
        ? `${String(record.name)}(${summarizeValue(record.arguments, 120)})`
        : String(record.name);
    })
    .join(", ");
}

function summarizeValue(value: unknown, maxLength: number): string {
  if (typeof value === "string") return truncate(value, maxLength);
  try {
    return truncate(JSON.stringify(value), maxLength);
  } catch {
    return String(value);
  }
}

function omitCommon(attributes: Record<string, unknown>): Record<string, unknown> {
  const omitted = { ...attributes };
  for (const key of ["episode_id", "episodeId", "step"]) delete omitted[key];
  return omitted;
}
