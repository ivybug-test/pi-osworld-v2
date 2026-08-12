import { describe, expect, it } from "vitest";
import { toolResultMessage } from "../src/backends/pi/agent.js";

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
});
