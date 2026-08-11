#!/usr/bin/env node
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { loadHarnessSpec } from "./config/load.js";
import type { BackendId } from "./config/spec.js";
import { buildBackends, uniqueBackends } from "./backends/factory.js";
import { CliDebugger, RecordingDebugger } from "./engine/debugger.js";
import { Orchestrator } from "./engine/orchestrator.js";
import { Runtime } from "./engine/runtime.js";
import {
  FileTaskStateStore,
  MemoryTaskStateStore,
} from "./engine/taskState.js";
import { runServe } from "./serve.js";
import { formatReplay, loadEvents, summarizeRounds } from "./replay.js";

// ---------------------------------------------------------------------------
// pi-osworld v2 CLI：run / serve / debug / replay
// ---------------------------------------------------------------------------

function usage(): void {
  process.stderr.write(`pi-osworld v2

usage:
  piosworld run --config <yaml> [--root <dir>] [--episode-id <id>] [--task <text>]
                [--result-dir <dir>] [--backend pi|mock] [--mock-script <yaml>] [--interactive]
  piosworld serve --config <yaml> [--root <dir>] [--result-dir <dir>]
                  [--backend pi|mock] [--mock-script <yaml>]   # JSONL bridge（OSWorld step 驱动）
  piosworld debug <run-dir>
  piosworld replay <run-dir>
`);
}

interface CliArgs {
  command: string;
  config: string;
  root?: string;
  episodeId: string;
  task: string;
  resultDir: string;
  backend?: BackendId;
  mockScript?: string;
  interactive: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: argv[0] ?? "run",
    config: "",
    episodeId: `ep-${Date.now()}`,
    task: "",
    resultDir: "runs",
    interactive: false,
  };
  const rest = argv.slice(1);
  if (args.command === "debug" || args.command === "replay") {
    args.config = rest[0] ?? "";
    return args;
  }
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--config") args.config = rest[++i] ?? "";
    else if (a === "--root") args.root = rest[++i] ?? "";
    else if (a === "--episode-id") args.episodeId = rest[++i] ?? "";
    else if (a === "--task") args.task = rest[++i] ?? "";
    else if (a === "--result-dir") args.resultDir = rest[++i] ?? "";
    else if (a === "--backend") args.backend = rest[++i] as BackendId;
    else if (a === "--mock-script") args.mockScript = rest[++i] ?? "";
    else if (a === "--interactive") args.interactive = true;
  }
  return args;
}

async function cmdRun(args: CliArgs): Promise<void> {
  if (!args.config) {
    usage();
    process.exit(1);
  }
  const loaded = loadHarnessSpec(args.config, args.root);
  const spec = loaded.spec;
  const task = args.task || `complete: ${spec.experiment}`;

  const resultDir = path.resolve(args.resultDir);
  mkdirSync(resultDir, { recursive: true });
  const eventsPath = path.join(resultDir, "events.jsonl");
  const emit = (event: string, attrs: Record<string, unknown>): void => {
    appendFileSync(
      eventsPath,
      `${JSON.stringify({ timestamp: Date.now(), event, ...attrs })}\n`,
    );
  };

  const stateStore =
    spec.state?.store === "memory"
      ? new MemoryTaskStateStore()
      : new FileTaskStateStore(path.join(resultDir, "state"));

  const backends = buildBackends({
    spec,
    root: loaded.root,
    resultDir,
    backendOverride: args.backend,
    toolServerUrl: process.env.PI_OSWORLD_TOOL_SERVER,
    mockScriptPath: args.mockScript,
    emit,
  });

  const dbg = args.interactive
    ? new CliDebugger({ interactive: true })
    : new RecordingDebugger();
  const runtime = new Runtime({
    spec,
    root: loaded.root,
    backends,
    stateStore,
    debugger: dbg,
    emit,
  });
  const orchestrator = new Orchestrator(spec, { runtime, debugger: dbg });

  emit("episode.start", {
    episodeId: args.episodeId,
    experiment: spec.experiment,
    configHash: loaded.configHash,
  });
  const summary = await orchestrator.runEpisode({
    episodeId: args.episodeId,
    task,
  });
  emit("episode.end", {
    episodeId: args.episodeId,
    outcome: summary.outcome.kind,
    rounds: summary.rounds,
  });

  for (const backend of uniqueBackends(backends)) {
    await backend.close?.();
  }

  const result = {
    episodeId: args.episodeId,
    experiment: spec.experiment,
    configHash: loaded.configHash,
    legacy: loaded.legacy,
    outcome: summary.outcome,
    rounds: summary.rounds,
    requirements: summary.state.requirements.map((r) => ({
      id: r.id,
      status: r.status,
    })),
    facts: summary.state.facts.length,
  };
  writeJson(path.join(resultDir, "result.json"), result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function cmdDebug(runDir: string): Promise<void> {
  const stateRoot = path.join(runDir, "state");
  let episodes: string[] = [];
  try {
    episodes = readdirSync(stateRoot);
  } catch {
    process.stderr.write(`no state dir at ${stateRoot}\n`);
    return;
  }
  for (const ep of episodes) {
    process.stdout.write(`episode ${ep}\n`);
    const roundDirs = readdirSync(path.join(stateRoot, ep))
      .filter((d) => d.startsWith("round-"))
      .sort(
        (a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]),
      );
    for (const rd of roundDirs) {
      const files: string[] = [];
      for (const f of [
        "contract.md",
        "executor_report.md",
        "audit_report.md",
        "decision.json",
      ]) {
        try {
          readFileSync(path.join(stateRoot, ep, rd, f));
          files.push(f);
        } catch {
          /* skip */
        }
      }
      process.stdout.write(
        `  ${rd}: ${files.join(", ") || "(no artifacts)"}\n`,
      );
    }
  }
}

async function cmdReplay(runDir: string): Promise<void> {
  const events = loadEvents(runDir);
  process.stdout.write(`${formatReplay(summarizeRounds(events))}\n`);
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "run") {
    await cmdRun(args);
  } else if (args.command === "serve") {
    await runServe({
      configPath: args.config,
      root: args.root,
      resultDir: args.resultDir,
      backend: args.backend,
      mockScript: args.mockScript,
    });
  } else if (args.command === "debug") {
    await cmdDebug(args.config);
  } else if (args.command === "replay") {
    await cmdReplay(args.config);
  } else {
    usage();
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(
    `[pi-osworld] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
