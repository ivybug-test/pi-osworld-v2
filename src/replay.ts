import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 重放：从 events.jsonl 无模型复现轮次结构（DESIGN-v2.md 10.5）
// ---------------------------------------------------------------------------

export interface ReplayEvent {
  timestamp: number;
  event: string;
  [key: string]: unknown;
}

export function loadEvents(runDir: string): ReplayEvent[] {
  const p = path.join(runDir, "events.jsonl");
  try {
    const text = readFileSync(p, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ReplayEvent);
  } catch (error) {
    throw new Error(
      `cannot load ${p}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface RoundSummary {
  round: number;
  episodeId: string;
  roles: Array<{ role: string; status: string }>;
  outcome?: string;
}

export function summarizeRounds(events: ReplayEvent[]): RoundSummary[] {
  const rounds = new Map<number, RoundSummary>();
  for (const ev of events) {
    if (ev.event === "round.start") {
      rounds.set(Number(ev.round), {
        round: Number(ev.round),
        episodeId: String(ev.episodeId ?? "unknown"),
        roles: [],
      });
    } else if (ev.event === "role.end") {
      const r = Number(ev.round);
      const entry = rounds.get(r) ?? {
        round: r,
        episodeId: String(ev.episodeId ?? "unknown"),
        roles: [],
      };
      entry.roles.push({
        role: String(ev.role ?? "?"),
        status: String(ev.status ?? "?"),
      });
      rounds.set(r, entry);
    } else if (ev.event === "round.decision") {
      const r = Number(ev.round);
      const entry = rounds.get(r) ?? {
        round: r,
        episodeId: String(ev.episodeId ?? "unknown"),
        roles: [],
      };
      entry.outcome = String(ev.outcome ?? "?");
      rounds.set(r, entry);
    }
  }
  return [...rounds.values()].sort((a, b) => a.round - b.round);
}

export function formatReplay(rounds: RoundSummary[]): string {
  const lines: string[] = ["replay:"];
  for (const r of rounds) {
    const roles = r.roles.map((x) => `${x.role}:${x.status}`).join(", ");
    lines.push(
      `  round ${r.round} [${r.episodeId}] ${roles} -> ${r.outcome ?? "?"}`,
    );
  }
  return lines.join("\n");
}
