import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// run 目录对比（DESIGN-v2.md P2：matrix / compare / manifest / result）
// ---------------------------------------------------------------------------

export interface TaskResultRow {
  taskId: string;
  score?: number;
  status?: string;
}

export interface RunCompare {
  runId: string;
  experiment?: string;
  topology?: string;
  taskSet?: string;
  maxSteps?: number;
  startedAt?: string;
  config?: string;
  tasks: TaskResultRow[];
  steps?: number;
  delegates?: number;
  gateResults: Array<{ accepted: boolean; rounds: number }>;
  finished: boolean;
  error?: string;
}

interface RunManifest {
  run_id?: string;
  experiment?: string;
  topology?: string;
  task_set?: string;
  max_steps?: number;
  start_time?: string;
  config?: string;
  tasks?: string[];
}

export function loadRunCompare(runDir: string): RunCompare {
  const entry: RunCompare = {
    runId: path.basename(runDir),
    tasks: [],
    gateResults: [],
    finished: false,
  };
  try {
    const manifest = loadManifest(runDir);
    if (manifest) {
      entry.runId = manifest.run_id ?? entry.runId;
      entry.experiment = manifest.experiment;
      entry.topology = manifest.topology;
      entry.taskSet = manifest.task_set;
      entry.maxSteps =
        typeof manifest.max_steps === "number" ? manifest.max_steps : undefined;
      entry.startedAt = manifest.start_time;
      entry.config = manifest.config;
    }

    const runnerPath = path.join(runDir, "runner.log");
    if (existsSync(runnerPath)) {
      const runner = readFileSync(runnerPath, "utf8");
      entry.experiment ??=
        runner.match(/experiment=([^\s]+)/)?.[1] ?? undefined;
      entry.topology ??= runner.match(/topology=([^\s]+)/)?.[1] ?? undefined;
      const loggedRunDir = runner.match(/run_dir=([^\s]+)/)?.[1];
      const inferred = inferFromRunName(
        loggedRunDir ? path.basename(loggedRunDir) : "",
      );
      entry.experiment ??= inferred.experiment;
      entry.topology ??= inferred.topology;
    }
    if (!entry.experiment && !entry.topology) {
      const inferred = inferFromRunName(path.basename(runDir));
      entry.experiment ??= inferred.experiment;
      entry.topology ??= inferred.topology;
    }

    const resultsPath = path.join(runDir, "summary", "results.json");
    if (existsSync(resultsPath)) {
      const results = JSON.parse(readFileSync(resultsPath, "utf8")) as Array<
        Record<string, unknown>
      >;
      for (const row of results) {
        entry.tasks.push({
          taskId: String(row.task_id ?? row.taskId ?? "?"),
          score: typeof row.score === "number" ? row.score : undefined,
          status: row.status !== undefined ? String(row.status) : undefined,
        });
      }
      entry.finished = true;
    }

    const trajFiles = findFiles(runDir, "traj.jsonl", 5);
    if (trajFiles.length > 0) {
      entry.steps = trajFiles.reduce(
        (total, file) => total + countLines(file),
        0,
      );
    }

    const eventsPath = path.join(runDir, "events.jsonl");
    if (existsSync(eventsPath)) {
      for (const line of readFileSync(eventsPath, "utf8")
        .split("\n")
        .filter((l) => l.trim())) {
        try {
          const ev = JSON.parse(line) as { event?: string } & Record<string, unknown>;
          if (ev.event === "delegate.start") {
            entry.delegates = (entry.delegates ?? 0) + 1;
          } else if (ev.event === "finish_gate.result") {
            entry.gateResults.push({
              accepted: Boolean(ev.accepted),
              rounds: Number(ev.rounds ?? 1),
            });
          }
        } catch {
          // ignore malformed event lines
        }
      }
    }
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
  }
  return entry;
}

/** 把输入路径展开成可比较的 run 目录：直接 run 目录原样返回；父目录自动枚举子 run。 */
export function resolveRunDirs(inputs: string[]): string[] {
  const out: string[] = [];
  for (const input of inputs) {
    const resolved = path.resolve(input);
    if (isRunDir(resolved)) {
      out.push(resolved);
      continue;
    }
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(resolved, { withFileTypes: true });
    } catch {
      out.push(resolved); // 让调用方报错
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(resolved, entry.name);
      if (isRunDir(full)) out.push(full);
    }
  }
  return out;
}

function isRunDir(dir: string): boolean {
  return (
    existsSync(path.join(dir, "manifest.json")) ||
    existsSync(path.join(dir, "runner.log")) ||
    existsSync(path.join(dir, "summary", "results.json"))
  );
}

export function formatCompare(runs: RunCompare[]): string {
  const headers = [
    "run",
    "experiment",
    "topology",
    "task",
    "score",
    "status",
    "steps",
    "delegates",
    "gate",
  ];
  const widths = headers.map((h, i) => {
    const values = runs.flatMap((r) => compareRow(r).map((c) => c[i]));
    return Math.max(h.length, ...values.map((v) => String(v).length));
  });
  const fmt = (row: string[]): string =>
    row.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  const lines = [
    fmt(headers),
    fmt(headers.map((_, i) => "-".repeat(widths[i]))),
  ];
  for (const run of runs) {
    for (const row of compareRow(run)) {
      lines.push(fmt(row));
    }
  }
  return lines.join("\n");
}

function compareRow(run: RunCompare): string[][] {
  const taskRows = run.tasks.length
    ? run.tasks.map((t) => [
        run.runId,
        run.experiment ?? "-",
        run.topology ?? "-",
        t.taskId,
        t.score !== undefined ? t.score.toFixed(4) : "-",
        t.status ?? "-",
        String(run.steps ?? "-"),
        String(run.delegates ?? 0),
        run.gateResults.length
          ? run.gateResults
              .map((g) => (g.accepted ? "PASS" : `FAIL(${g.rounds})`))
              .join(",")
          : "-",
      ])
    : [[
        run.runId,
        run.experiment ?? "-",
        run.topology ?? "-",
        "-",
        "-",
        run.finished ? "no-results" : "running",
        String(run.steps ?? "-"),
        String(run.delegates ?? 0),
        "-",
      ]];
  return taskRows;
}

function loadManifest(runDir: string): RunManifest | undefined {
  const manifestPath = path.join(runDir, "manifest.json");
  if (!existsSync(manifestPath)) return undefined;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as RunManifest;
  } catch {
    return undefined;
  }
}

/** 从 `YYYYMMDDTHHMMSS-<experiment>-<topology>` 形式的 run 目录名反推标识。 */
function inferFromRunName(name: string): {
  experiment?: string;
  topology?: string;
} {
  const match = name.match(/^\d{8}T\d{6}-(.+)$/);
  if (!match) return {};
  const rest = match[1];
  const sep = rest.lastIndexOf("-");
  if (sep > 0) {
    return { experiment: rest.slice(0, sep), topology: rest.slice(sep + 1) };
  }
  return { experiment: rest };
}

function findFiles(dir: string, name: string, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth) return;
    try {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isFile() && entry.name === name) {
          out.push(full);
        } else if (entry.isDirectory()) {
          walk(full, depth + 1);
        }
      }
    } catch {
      return;
    }
  };
  walk(dir, 0);
  return out;
}

function countLines(filePath: string): number {
  try {
    return readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim())
      .length;
  } catch {
    return 0;
  }
}
