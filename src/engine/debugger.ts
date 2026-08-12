import type { EpisodeRequest, EpisodeResult, RoundContext } from "./types.js";
import { appendIntervention, type InterventionEntry } from "./interventions.js";

// ---------------------------------------------------------------------------
// 调试器：一等公民。事件日志 / 交互暂停 / 干预（DESIGN-v2.md 10.5）
// ---------------------------------------------------------------------------

export type DebugEvent =
  | { type: "round.start"; round: number; episodeId: string }
  | { type: "round.end"; round: number; outcomeKind: string; episodeId: string }
  | { type: "role.start"; role: string; round: number; req: EpisodeRequest }
  | { type: "role.end"; role: string; round: number; status: string };

export interface Debugger {
  onRoundStart(ctx: RoundContext): void | Promise<void>;
  onRoundEnd(
    ctx: RoundContext,
    outcome: { kind: string },
  ): void | Promise<void>;
  onRoleStart(role: string, req: EpisodeRequest): void | Promise<void>;
  onRoleEnd(role: string, result: EpisodeResult): void | Promise<void>;
  inspect(path: string): Promise<unknown>;
  mutate(path: string, value: unknown): Promise<void>;
}

/** 记录型调试器：收集全部事件，供测试与审计。 */
export class RecordingDebugger implements Debugger {
  readonly events: DebugEvent[] = [];
  readonly interventions: InterventionEntry[] = [];

  constructor(private readonly resultDir?: string) {}

  async onRoundStart(ctx: RoundContext): Promise<void> {
    this.events.push({ type: "round.start", round: ctx.index, episodeId: ctx.episodeId });
  }
  async onRoundEnd(ctx: RoundContext, outcome: { kind: string }): Promise<void> {
    this.events.push({ type: "round.end", round: ctx.index, outcomeKind: outcome.kind, episodeId: ctx.episodeId });
  }
  async onRoleStart(role: string, req: EpisodeRequest): Promise<void> {
    this.events.push({ type: "role.start", role, round: req.roundIndex, req });
  }
  async onRoleEnd(role: string, result: EpisodeResult): Promise<void> {
    this.events.push({ type: "role.end", role, round: 0, status: result.status });
  }
  async inspect(path: string): Promise<unknown> {
    throw new Error(`RecordingDebugger.inspect not implemented: ${path}`);
  }
  async mutate(path: string, value: unknown): Promise<void> {
    const entry: InterventionEntry = { timestamp: Date.now(), path, value };
    this.interventions.push(entry);
    if (this.resultDir) appendIntervention(this.resultDir, entry);
  }
}

/** CLI 调试器：打印结构化轮次日志；--interactive 时轮间暂停接受命令。 */
export class CliDebugger implements Debugger {
  constructor(
    private readonly opts: {
      interactive?: boolean;
      log?: (line: string) => void;
      resultDir?: string;
    } = {},
  ) {}

  private out(line: string): void {
    (this.opts.log ?? ((l) => process.stderr.write(`${l}\n`)))(line);
  }

  async onRoundStart(ctx: RoundContext): Promise<void> {
    this.out(`── round ${ctx.index} start ──`);
    if (this.opts.interactive) await this.pause(ctx);
  }

  async onRoundEnd(ctx: RoundContext, outcome: { kind: string }): Promise<void> {
    this.out(`── round ${ctx.index} end: ${outcome.kind} ──`);
    if (this.opts.interactive) await this.pause(ctx);
  }

  async onRoleStart(role: string, req: EpisodeRequest): Promise<void> {
    this.out(
      `  [${role}] round ${req.roundIndex} ${req.freshPerRound ? "(fresh)" : ""} tools=[${req.tools.join(",")}]`,
    );
  }

  async onRoleEnd(role: string, result: EpisodeResult): Promise<void> {
    this.out(
      `  [${role}] -> ${result.status}${result.report ? `\n    report: ${truncate(result.report, 400)}` : ""}`,
    );
  }

  async inspect(path: string): Promise<unknown> {
    this.out(`inspect ${path} (CLI 直接读取 runs 目录产物)`);
    return undefined;
  }

  async mutate(path: string, value: unknown): Promise<void> {
    this.out(`mutate ${path} = ${JSON.stringify(value)} (recorded)`);
    if (this.opts.resultDir) {
      appendIntervention(this.opts.resultDir, {
        timestamp: Date.now(),
        path,
        value,
      });
    }
  }

  private async pause(ctx: RoundContext): Promise<void> {
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    await new Promise<void>((resolve) => {
      rl.question(`  [debug] round ${ctx.index} (continue|inspect <path>|abort) > `, (answer) => {
        rl.close();
        if (answer.trim() === "abort") process.exit(1);
        resolve();
      });
    });
  }
}

function truncate(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}...(+${text.length - n} chars)` : text;
}
