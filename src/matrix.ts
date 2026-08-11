import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// matrix：把一组实验配置展开成可执行单元（DESIGN-v2.md P2）
// ---------------------------------------------------------------------------

export interface MatrixSpec {
  configs: string[];
  /** 可选：覆盖/交叉 task_sets；缺省保留 config 自身的 task_set。 */
  task_sets?: string[];
  runs: number;
  /** config/task_set 相对路径的基准目录；缺省为当前工作目录。 */
  root?: string;
}

export interface MatrixCell {
  config: string;
  taskSet?: string;
  run: number;
}

export function loadMatrix(matrixPath: string): MatrixSpec {
  const raw = parseYaml(readFileSync(matrixPath, "utf8")) as Partial<MatrixSpec>;
  if (!Array.isArray(raw.configs) || raw.configs.length === 0) {
    throw new Error(`matrix ${matrixPath} must declare non-empty configs`);
  }
  return {
    configs: raw.configs.map((c) => String(c)),
    ...(Array.isArray(raw.task_sets) && raw.task_sets.length > 0
      ? { task_sets: raw.task_sets.map((t) => String(t)) }
      : {}),
    runs: Number(raw.runs ?? 1),
    ...(typeof raw.root === "string" && raw.root ? { root: raw.root } : {}),
  };
}

export function expandMatrix(spec: MatrixSpec): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const config of spec.configs) {
    const taskSets = spec.task_sets?.length ? spec.task_sets : [undefined];
    for (const taskSet of taskSets) {
      for (let run = 1; run <= spec.runs; run += 1) {
        cells.push({
          config,
          ...(taskSet !== undefined ? { taskSet } : {}),
          run,
        });
      }
    }
  }
  return cells;
}

export function formatMatrixPlan(cells: MatrixCell[]): string {
  if (cells.length === 0) return "matrix: (empty)";
  const lines = ["matrix plan:"];
  for (const cell of cells) {
    lines.push(
      `  run ${cell.run}: ${cell.config}${
        cell.taskSet ? ` (task_set=${cell.taskSet})` : ""
      }`,
    );
  }
  return lines.join("\n");
}

export function matrixCellLabel(cell: MatrixCell): string {
  return [
    path.basename(cell.config, path.extname(cell.config)),
    cell.taskSet ? path.basename(cell.taskSet, path.extname(cell.taskSet)) : "",
    `run${cell.run}`,
  ]
    .filter(Boolean)
    .join("-");
}

export interface MatrixRunOptions {
  /** 启动 run_v2.py 的 Python 解释器路径。 */
  python: string;
  configRoot: string;
  resultDir: string;
  osworldRoot: string;
  providerName: string;
  maxSteps?: number;
  numEnvs?: number;
  extraArgs?: string[];
}

/** 顺序执行 matrix 展开出的每个单元（每个单元 = 一次 run_v2.py）。 */
export async function runMatrix(
  matrixPath: string,
  options: MatrixRunOptions,
): Promise<void> {
  const spec = loadMatrix(matrixPath);
  const cells = expandMatrix(spec);
  const root = spec.root ? path.resolve(spec.root) : process.cwd();
  const matrixRunDir = path.join(
    options.resultDir,
    `matrix-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`,
  );
  mkdirSync(matrixRunDir, { recursive: true });
  const scriptPath = fileURLToPath(
    new URL("../python/run_v2.py", import.meta.url),
  );
  process.stdout.write(`[matrix] result dir: ${matrixRunDir}\n`);
  for (const cell of cells) {
    const label = matrixCellLabel(cell);
    const args = [
      scriptPath,
      "--config",
      path.resolve(root, cell.config),
      "--config-root",
      options.configRoot,
      "--result-dir",
      matrixRunDir,
      "--osworld-root",
      options.osworldRoot,
      "--provider-name",
      options.providerName,
    ];
    if (cell.taskSet) {
      args.push("--task-set", path.resolve(root, cell.taskSet));
    }
    if (options.maxSteps !== undefined) {
      args.push("--max-steps", String(options.maxSteps));
    }
    if (options.numEnvs !== undefined) {
      args.push("--num-envs", String(options.numEnvs));
    }
    args.push(...(options.extraArgs ?? []));
    process.stdout.write(`[matrix] ${label}: starting\n`);
    await spawnPython(options.python, args);
    process.stdout.write(`[matrix] ${label}: finished\n`);
  }
}

function spawnPython(python: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { stdio: "inherit" });
    child.on("error", (error) => reject(error));
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `matrix cell exited with ${
              signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
            }`,
          ),
        );
      }
    });
  });
}
