import { afterEach, describe, expect, it } from "vitest";
import { resolveModelForAlias } from "../src/backends/pi/models/client.js";

describe("qwen-gateway provider", () => {
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  const originalApiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    restore(process.env, "OPENAI_BASE_URL", originalBaseUrl);
    restore(process.env, "OPENAI_API_KEY", originalApiKey);
  });

  it("registers parametrix qwen3.7-plus from env", () => {
    process.env.OPENAI_BASE_URL = "https://parametrix.test/v1";
    process.env.OPENAI_API_KEY = "test-key";

    const { model, ref } = resolveModelForAlias(
      { main: "qwen-gateway/qwen3.7-plus" },
      "main",
    );

    expect(ref.provider).toBe("qwen-gateway");
    expect(ref.id).toBe("qwen3.7-plus");
    expect(model.id).toBe("qwen3.7-plus");
    expect(model.baseUrl).toBe("https://parametrix.test/v1");
  });

  it("still resolves builtin providers when gateway env is absent", () => {
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;

    const { model, ref } = resolveModelForAlias(
      { main: "anthropic/MiniMax-M3" },
      "main",
    );

    expect(ref.provider).toBe("anthropic");
    expect(model.id).toBe("MiniMax-M3");
  });
});

function restore(
  target: Record<string, string | undefined>,
  key: string,
  value: string | undefined,
): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}
