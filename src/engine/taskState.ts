import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type RoundRecord,
  type TaskState,
} from "./types.js";

// ---------------------------------------------------------------------------
// TaskStateStore：内存 / 文件两种后端
// 落盘布局：runs/<runId>/state/<episodeId>/round-<i>/...
// ---------------------------------------------------------------------------

export interface TaskStateStore {
  read(episodeId: string): Promise<TaskState | undefined>;
  write(episodeId: string, state: TaskState): Promise<void>;
  appendRound(episodeId: string, round: RoundRecord): Promise<TaskState>;
  /** 清空某 episode 的全部状态（serve reset / 重跑同一任务）。 */
  clear(episodeId: string): Promise<void>;
  close?(): Promise<void>;
}

export function createTaskState(
  task: string,
  schema: Array<"requirements" | "artifacts" | "facts">,
): TaskState {
  return {
    goal: task,
    requirements: schema.includes("requirements")
      ? [{ id: "req-1", text: task, status: "pending", evidence: [] }]
      : [],
    artifacts: schema.includes("artifacts") ? [] : [],
    facts: schema.includes("facts") ? [] : [],
    gate: { rejections: 0 },
    rounds: [],
  };
}

export class MemoryTaskStateStore implements TaskStateStore {
  private readonly states = new Map<string, TaskState>();
  private readonly rounds = new Map<string, RoundRecord[]>();

  async clear(episodeId: string): Promise<void> {
    this.states.delete(episodeId);
    this.rounds.delete(episodeId);
  }

  async read(episodeId: string): Promise<TaskState | undefined> {
    const s = this.states.get(episodeId);
    return s ? structuredClone(s) : undefined;
  }
  async write(episodeId: string, state: TaskState): Promise<void> {
    this.states.set(episodeId, structuredClone(state));
  }
  async appendRound(episodeId: string, round: RoundRecord): Promise<TaskState> {
    const list = this.rounds.get(episodeId) ?? [];
    list.push(structuredClone(round));
    this.rounds.set(episodeId, list);
    const s = this.states.get(episodeId) ?? {
      goal: "",
      requirements: [],
      artifacts: [],
      facts: [],
      rounds: [],
    };
    s.rounds = structuredClone(list);
    this.states.set(episodeId, s);
    return structuredClone(s);
  }
}

export class FileTaskStateStore implements TaskStateStore {
  constructor(
    private readonly stateRoot: string, // runs/<runId>/state
  ) {}

  async clear(episodeId: string): Promise<void> {
    rmSync(path.join(this.stateRoot, episodeId), {
      recursive: true,
      force: true,
    });
  }

  private statePath(episodeId: string): string {
    return path.join(this.stateRoot, episodeId, "task_state.json");
  }
  private roundDir(episodeId: string, index: number): string {
    return path.join(this.stateRoot, episodeId, `round-${index}`);
  }

  async read(episodeId: string): Promise<TaskState | undefined> {
    try {
      const raw = readFileSync(this.statePath(episodeId), "utf8");
      return JSON.parse(raw) as TaskState;
    } catch {
      return undefined;
    }
  }

  async write(episodeId: string, state: TaskState): Promise<void> {
    mkdirSync(path.dirname(this.statePath(episodeId)), { recursive: true });
    writeFileSync(
      this.statePath(episodeId),
      JSON.stringify(state, null, 2),
      "utf8",
    );
  }

  async appendRound(episodeId: string, round: RoundRecord): Promise<TaskState> {
    const dir = this.roundDir(episodeId, round.index);
    mkdirSync(dir, { recursive: true });
    if (round.contract) {
      writeFileSync(
        path.join(dir, "contract.md"),
        formatContract(round.contract),
        "utf8",
      );
    }
    if (round.executorReport) {
      writeFileSync(path.join(dir, "executor_report.md"), round.executorReport, "utf8");
    }
    if (round.auditReport) {
      writeFileSync(
        path.join(dir, "audit_report.md"),
        formatAuditReport(round.auditReport),
        "utf8",
      );
    }
    writeFileSync(
      path.join(dir, "decision.json"),
      JSON.stringify(round.decision, null, 2),
      "utf8",
    );
    let state = await this.read(episodeId);
    if (!state) {
      state = {
        goal: "",
        requirements: [],
        artifacts: [],
        facts: [],
        rounds: [],
      };
    }
    state.rounds.push(structuredClone(round));
    await this.write(episodeId, state);
    return structuredClone(state);
  }
}

export function formatContract(c: {
  goal: string;
  acceptanceCriteria: string[];
  boundaryConstraints: string[];
  evidenceRefs: Array<{ reportId: string; summary: string }>;
  target: string;
}): string {
  const lines = [
    `# Contract ${c.target}`,
    "",
    `## Goal`,
    c.goal,
    "",
    "## Acceptance criteria",
    ...c.acceptanceCriteria.map((x) => `- ${x}`),
    "",
    "## Boundary constraints",
    ...(c.boundaryConstraints.length
      ? c.boundaryConstraints.map((x) => `- ${x}`)
      : ["- (none)"]),
    "",
    "## Evidence refs",
    ...(c.evidenceRefs.length
      ? c.evidenceRefs.map((e) => `- [${e.reportId}] ${e.summary}`)
      : ["- (none)"]),
  ];
  return lines.join("\n");
}

export function formatAuditReport(a: {
  completion: string;
  integrity: string;
  contractAudit: string;
  verifiedFacts: Array<{ reportId: string; summary: string }>;
  gaps: string[];
  evidence: string[];
}): string {
  const lines = [
    `completion: ${a.completion}`,
    `integrity: ${a.integrity}`,
    `contract_audit: ${a.contractAudit}`,
    "",
    "## Verified facts",
    ...(a.verifiedFacts.length
      ? a.verifiedFacts.map((f) => `- [${f.reportId}] ${f.summary}`)
      : ["- (none)"]),
    "",
    "## Gaps",
    ...(a.gaps.length ? a.gaps.map((g) => `- ${g}`) : ["- (none)"]),
    "",
    "## Evidence",
    ...(a.evidence.length ? a.evidence.map((e) => `- ${e}`) : ["- (none)"]),
  ];
  return lines.join("\n");
}
