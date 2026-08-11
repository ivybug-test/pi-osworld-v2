import type { FlowContext } from "../flows/types.js";
import type { PiModelClient } from "../models/client.js";
import { RoleSubagent } from "./role-subagent.js";
import type { Subagent } from "./types.js";

export interface SubagentRegistryOptions {
  /** Test seam: per-role model client overrides keyed by agent role id. */
  clients?: Record<string, PiModelClient>;
  /** Called after every interior subagent turn; return false to stop the loop. */
  onTurn?: () => boolean | void;
}

export class SubagentRegistry {
  private readonly subagents = new Map<string, Subagent>();

  constructor(context: FlowContext, options: SubagentRegistryOptions = {}) {
    for (const [id, spec] of Object.entries(context.config.subagents ?? {})) {
      this.subagents.set(
        id,
        new RoleSubagent({
          id,
          spec,
          context,
          client: options.clients?.[spec.role],
          onTurn: options.onTurn,
        }),
      );
    }
  }

  async initialize(): Promise<void> {
    for (const subagent of this.subagents.values()) {
      await subagent.initialize();
    }
  }

  get(id: string): Subagent {
    const subagent = this.subagents.get(id);
    if (!subagent) throw new Error(`unknown subagent: ${id}`);
    return subagent;
  }

  async reset(): Promise<void> {
    for (const subagent of this.subagents.values()) {
      await subagent.reset();
    }
  }

  async close(): Promise<void> {
    for (const subagent of this.subagents.values()) {
      await subagent.close();
    }
  }

  get cost(): number {
    let total = 0;
    for (const subagent of this.subagents.values()) {
      if ("cost" in subagent) {
        total += (subagent as { cost: number }).cost;
      }
    }
    return total;
  }
}
