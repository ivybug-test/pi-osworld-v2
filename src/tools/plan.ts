import { Type, type Tool } from "@earendil-works/pi-ai";

/**
 * Externalized plan checklist for the main agent.
 *
 * Execution is handled by the flow, not the VM: the checklist lives outside
 * the message history and is re-injected into every main-agent turn so it
 * survives compaction.
 */
export const planUpdateTool: Tool = {
  name: "plan.update",
  description:
    "Replace the externalized task checklist. Each item is one line; prefix done items with [x] and pending items with [ ]. The checklist is persisted outside the conversation and re-injected on every turn.",
  parameters: Type.Object({
    items: Type.Array(Type.String({ description: "Checklist line, e.g. '[ ] find file' or '[x] update file'" })),
  }),
};

export interface PlanItem {
  text: string;
  done: boolean;
}

export function parsePlanItems(items: string[]): PlanItem[] {
  return items.map((raw) => {
    const line = raw.trim();
    const done = /^\[x\]/i.test(line);
    const text = done ? line.replace(/^\[x\]/i, "").trim() : line.replace(/^\[ \]\s*/, "").trim();
    return { text, done };
  });
}

export function formatPlan(items: PlanItem[]): string {
  if (items.length === 0) return "(empty plan)";
  return items
    .map((item) => `${item.done ? "[x]" : "[ ]"} ${item.text}`)
    .join("\n");
}
