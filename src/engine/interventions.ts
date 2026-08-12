import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface InterventionEntry {
  timestamp: number;
  path: string;
  value: unknown;
  role?: string;
  round?: number;
}

/** 追加一条调试干预记录；供 debug 追溯人工修改。 */
export function appendIntervention(
  resultDir: string,
  entry: InterventionEntry,
): void {
  mkdirSync(resultDir, { recursive: true });
  appendFileSync(
    path.join(resultDir, "interventions.jsonl"),
    `${JSON.stringify(entry)}\n`,
    "utf8",
  );
}
