import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOutageAlerter } from "../src/notify/outageAlert.js";

describe("outage alert (database writes failing)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(down = false) {
    const posts: { channel: string; content: string }[] = [];
    const alerter = createOutageAlerter(
      async (channel, content) => {
        if (down) throw new Error("discord down");
        posts.push({ channel, content });
      },
      "ERR",
      60_000,
      () => Date.now(),
    );
    return { alerter, posts };
  }

  it("posts the first failure straight away, with emails masked", async () => {
    const { alerter, posts } = setup();
    alerter.report("create_escalation", new Error("insert failed for amara@lagosledger.example"));
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("ERR");
    expect(posts[0].content).toContain("create_escalation");
    expect(posts[0].content).toContain("a***@lagosledger.example");
  });

  it("batches an outage into at most one post a minute, with the count", async () => {
    const { alerter, posts } = setup();
    alerter.report("create_escalation", new Error("timeout"));
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) alerter.report(i % 2 ? "lookup_payout" : "create_support_ticket", new Error("timeout"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(posts).toHaveLength(2);
    expect(posts[1].content).toContain("5 writes");
    expect(posts[1].content).toContain("lookup_payout");
    expect(posts[1].content).toContain("create_support_ticket");
  });

  it("never throws when Discord is down too", async () => {
    const { alerter } = setup(true);
    expect(() => alerter.report("create_escalation", new Error("timeout"))).not.toThrow();
    await expect(vi.advanceTimersByTimeAsync(0)).resolves.not.toThrow();
  });
});

describe("tool record write failing", () => {
  it("reports to the outage hook after the retry, and the tool still answers", async () => {
    const { withToolLogging } = await import("../src/lib/withToolLogging.js");
    const reported: string[] = [];
    const ctx = {
      db: { insertToolCall: async () => Promise.reject(new Error("connection refused")) } as never,
      conversationId: "call-1",
      turnIndex: 0,
      onRecordFailed: (tool: string) => void reported.push(tool),
    };
    const tool = withToolLogging(ctx, { name: "create_escalation", purpose: "p", failureMessage: "f" }, async () => ({ status: "success", data: { ok: true } }));
    const result = await tool({});
    expect(result.isError).toBeFalsy();
    await vi.waitFor(() => expect(reported).toEqual(["create_escalation"]));
  });
});
