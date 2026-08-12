import { describe, expect, it } from "vitest";
import { FeedbackInjector } from "../src/engine/feedback.js";

describe("FeedbackInjector", () => {
  it("offer → takePending 取走并清空（不重复注入）", () => {
    const injector = new FeedbackInjector();
    expect(injector.hasPending).toBe(false);
    injector.offer("keep working on gaps");
    expect(injector.hasPending).toBe(true);
    expect(injector.takePending()).toBe("keep working on gaps");
    expect(injector.hasPending).toBe(false);
    expect(injector.takePending()).toBeUndefined();
  });

  it("多次 offer 合并为一条注入（\n\n 分隔）", () => {
    const injector = new FeedbackInjector();
    injector.offer("first");
    injector.offer("second");
    expect(injector.takePending()).toBe("first\n\nsecond");
  });

  it("空白文本忽略", () => {
    const injector = new FeedbackInjector();
    injector.offer(undefined);
    injector.offer("");
    injector.offer("   ");
    expect(injector.hasPending).toBe(false);
  });

  it("生产方只 offer，消费方取走——语义解耦（可复用于 verifier 等）", () => {
    const injector = new FeedbackInjector();
    // 模拟 orchestrator audit 生产
    const produce = (text: string) => injector.offer(text);
    // 模拟 backend 每次模型调用前消费
    const beforeModelCall = () => injector.takePending();
    produce("## Progress audit\ncheck terminal");
    produce("## Verifier feedback\nrejected");
    const delivered = beforeModelCall();
    expect(delivered).toContain("## Progress audit");
    expect(delivered).toContain("## Verifier feedback");
    expect(injector.hasPending).toBe(false);
  });
});
