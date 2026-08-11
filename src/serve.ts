import { createInterface } from "node:readline";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { BackendId } from "./config/spec.js";
import type { BridgeRequest, BridgeResponse } from "./bridge/protocol.js";
import { loadHarnessSpec } from "./config/load.js";
import { buildBackends, uniqueBackends } from "./backends/factory.js";
import { RecordingDebugger } from "./engine/debugger.js";
import { Orchestrator } from "./engine/orchestrator.js";
import { Runtime } from "./engine/runtime.js";
import {
  FileTaskStateStore,
  MemoryTaskStateStore,
  type TaskStateStore,
} from "./engine/taskState.js";
import type { EpisodeSummary } from "./engine/types.js";

// ---------------------------------------------------------------------------
// serve：JSONL bridge（复用旧 BridgeRequest/BridgeResponse 协议）。
// 每个 predict = v2 引擎一轮（resume），返回 StepOutput {response, actions}，
// 由 OSWorld runner 用 env.step 执行动作并回传新观察——step 驱动复现路径。
// ---------------------------------------------------------------------------

export interface ServeOptions {
  configPath: string;
  root?: string;
  resultDir: string;
  backend?: BackendId;
  mockScript?: string;
}

export async function runServe(options: ServeOptions): Promise<void> {
  const loaded = loadHarnessSpec(options.configPath, options.root);
  const spec = loaded.spec;
  mkdirSync(options.resultDir, { recursive: true });
  const eventsPath = path.join(options.resultDir, "events.jsonl");
  const emit = (event: string, attrs: Record<string, unknown>): void => {
    appendFileSync(
      eventsPath,
      `${JSON.stringify({ timestamp: Date.now(), event, ...attrs })}\n`,
    );
  };

  const stateStore =
    spec.state?.store === "memory"
      ? new MemoryTaskStateStore()
      : new FileTaskStateStore(path.join(options.resultDir, "state"));
  const backends = buildBackends({
    spec,
    root: loaded.root,
    resultDir: options.resultDir,
    backendOverride: options.backend,
    toolServerUrl: process.env.PI_OSWORLD_TOOL_SERVER,
    mockScriptPath: options.mockScript,
    emit,
  });
  const dbg = new RecordingDebugger();
  const runtime = new Runtime({
    spec,
    root: loaded.root,
    backends,
    stateStore,
    debugger: dbg,
    emit,
  });
  const orchestrator = new Orchestrator(spec, { runtime, debugger: dbg });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const request = JSON.parse(line) as BridgeRequest;
    let response: BridgeResponse;
    try {
      switch (request.type) {
        case "initialize":
          response = { id: request.id, ok: true, result: "ok" };
          break;
        case "reset": {
          await stateStore.clear(request.episodeId);
          for (const backend of uniqueBackends(backends)) {
            await backend.resetEpisode?.(request.episodeId);
          }
          emit("episode.reset", { episodeId: request.episodeId });
          response = { id: request.id, ok: true, result: "ok" };
          break;
        }
        case "predict": {
          emit("episode.start", {
            episodeId: request.episodeId,
            step: request.step,
            experiment: spec.experiment,
          });
          const summary = await orchestrator.runEpisode({
            episodeId: request.episodeId,
            task: request.instruction,
            observation: request.observation,
            roundLimit: 1,
          });
          response = {
            id: request.id,
            ok: true,
            result: summaryToStepOutput(summary),
          };
          break;
        }
        case "close":
          for (const backend of uniqueBackends(backends)) {
            await backend.close?.();
          }
          await (stateStore as TaskStateStore).close?.();
          process.stdout.write(
            `${JSON.stringify({ id: request.id, ok: true, result: "ok" } satisfies BridgeResponse)}\n`,
          );
          process.exit(0);
      }
    } catch (error) {
      response = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

/** v2 一轮结果 → OSWorld StepOutput（actions 驱动 env.step）。 */
export function summaryToStepOutput(
  summary: EpisodeSummary,
): { response: string; actions: string[] } {
  const last = summary.state.rounds.at(-1);
  const actions = (last?.metadata?.actions as string[] | undefined) ?? [];
  switch (summary.outcome.kind) {
    case "done":
      return {
        response: last?.executorReport ?? "Task complete",
        actions: actions.length ? actions : ["DONE"],
      };
    case "blocked":
      return {
        response: String(summary.outcome.reason ?? "Task failed"),
        actions: ["FAIL"],
      };
    case "ask":
      return { response: summary.outcome.question, actions: [] };
    case "execute":
      return {
        response: last?.executorReport ?? "continuing",
        actions: actions.length ? actions : ["WAIT"],
      };
    case "max_rounds":
      return { response: "max rounds reached", actions: ["FAIL"] };
  }
}
