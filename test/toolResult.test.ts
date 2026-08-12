import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from "@earendil-works/pi-ai";
import { RoleAgent, toolResultMessage } from "../src/backends/pi/agent.js";
import { loadHarnessSpec } from "../src/config/load.js";
import type { FlowContext, StepInput } from "../src/backends/pi/flow.js";
import { buildLegacyConfig } from "../src/backends/pi/compat.js";
import type { PiModelClient as PiModelClientLocal } from "../src/backends/pi/models/client.js";
import { RunWriter } from "../src/backends/pi/telemetry.js";
import { resolveTools } from "../src/backends/pi/tools/registry.js";

const LEGACY_STATEACT = "/home/binqiu/osworld-experiments/experiments/stateact-minimal.yaml";

function tmpRunDir(): string {
  return mkdtempSync(path.join(tmpdir(), "piosworld-v2-toolresult-"));
}

function assistantWithCalls(
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): AssistantMessage {
  return {
    role: "assistant",
    content: calls.map((c) => ({
      type: "toolCall",
      id: c.id,
      name: c.name,
      arguments: c.arguments,
    })),
    api: "anthropic",
    provider: "anthropic",
    model: "fake",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function assistantWithText(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic",
    provider: "anthropic",
    model: "fake",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function recordingClient(assistantMessages: AssistantMessage[]): {
  client: PiModelClientLocal;
  seen: Message[][];
} {
  const seen: Message[][] = [];
  let i = 0;
  const client: PiModelClientLocal = {
    async complete(_alias, context) {
      seen.push(context.messages);
      const next = assistantMessages[Math.min(i, assistantMessages.length - 1)];
      i += 1;
      return next;
    },
  };
  return { client, seen };
}

function userMessage(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

describe("toolResult image handling", () => {
  it("toolResultMessage embeds an image content block", () => {
    const msg = toolResultMessage(
      "call-1",
      "state.view_image",
      "screenshot",
      false,
      { data: "aGVsbG8=", mimeType: "image/png" },
    );
    expect(msg.role).toBe("toolResult");
    expect((msg.content as Array<{ type: string }>).map((b) => b.type)).toEqual([
      "text",
      "image",
    ]);
  });

  it("keeps tool images inside consecutive toolResult messages, no interleaved image user", async () => {
    const runDir = tmpRunDir();
    try {
      const loaded = loadHarnessSpec(LEGACY_STATEACT);
      const spec = loaded.spec;
      const context: FlowContext = {
        config: buildLegacyConfig(spec),
        root: loaded.root,
        resultDir: runDir,
        writer: new RunWriter(runDir),
        toolExecutor: {
          execute: async () => ({
            text: "screenshot bytes",
            isError: false,
            image: { data: "aGVsbG8=", mimeType: "image/png" },
          }),
        },
      };
      const { client, seen } = recordingClient([
        assistantWithCalls([
          { id: "call-1", name: "state.view_image", arguments: { path: "a.png" } },
          { id: "call-2", name: "state.view_image", arguments: { path: "b.png" } },
          { id: "call-3", name: "state.view_image", arguments: { path: "c.png" } },
        ]),
        assistantWithText("done"),
      ]);
      const agent = new RoleAgent({
        context,
        role: "main",
        tools: resolveTools(spec.roles.main.tools),
        client,
      });
      await agent.initialize();
      const input: StepInput = {
        episodeId: "ep-1",
        instruction: "Do the task",
        step: 1,
        observation: { terminal: "vm$" },
      };
      await agent.stepUntilDecision(input, userMessage("start"), {
        executeTool: async (call) => context.toolExecutor!.execute(call),
        isTerminal: (name) =>
          ["delegate.gui", "finish", "fail", "ask_user"].includes(name),
        maxToolCalls: 10,
      });

      const second = seen[1];
      expect(second).toBeDefined();
      const toolResults = second.filter((m) => m.role === "toolResult");
      expect(toolResults).toHaveLength(3);
      for (const result of toolResults) {
        const content = result.content as Array<{ type: string }>;
        expect(content.some((b) => b.type === "image")).toBe(true);
      }
      const imageUsers = second.filter(
        (m) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          (m.content as Array<{ type: string }>).some((b) => b.type === "image"),
      );
      expect(imageUsers).toHaveLength(0);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
