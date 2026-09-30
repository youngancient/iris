import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { CallStore, CallSummary } from "../src/logging/callStore.js";
import type { TurnStore } from "../src/logging/turnStore.js";

const SECRET = "vapi-secret-that-is-at-least-32-characters";

const turnStore: TurnStore = {
  priorActions: async () => ({ identifiedCustomer: null, tickets: [], escalations: [] }),
  claimTurn: async () => ({ state: "claimed" }),
  completeTurn: async () => {},
  failTurn: async () => {},
  event: async () => {},
  toolCallRejected: async () => {},
};

const ended: { id: string; finalStatus: string; callerId: string }[] = [];
const events: string[] = [];
let summary: CallSummary = { tickets: 0, escalations: 0, turns: 2, followUpSeen: true, identifiedCustomer: "CUS-1001" };
const calls: CallStore = {
  summarize: async () => summary,
  endCall: async (id, f) => void ended.push({ id, finalStatus: f.finalStatus, callerId: f.callerId }),
  event: async (_id, type) => void events.push(type),
  hasEvent: async (_id, type) => events.includes(type),
};

let base = "";
let close: () => void;
beforeAll(async () => {
  const app = createApp({
    vapiSecret: SECRET,
    calls,
    turn: {
      store: turnStore,
      model: "test",
      retrieve: async () => ({ chunks: [], matched: false, method: "vector", topScore: null }),
      runModel: async function* () {
        yield { type: "text", text: "Hello there. How can I help? [[type:clarify;confidence:high]]" };
      },
    },
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

const post = (path: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("agent HTTP", () => {
  it("rejects requests without the Vapi secret", async () => {
    expect((await post("/chat/completions", {}, {})).status).toBe(401);
    expect((await post("/chat/completions", {}, { authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("streams OpenAI-style chunks ending in [DONE], with the tag removed", async () => {
    const res = await post("/chat/completions", { stream: true, call: { id: "call-9" }, messages: [{ role: "user", content: "Can you help me with a payout?" }] });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const chunks = text.split("\n\n").filter(Boolean);
    expect(chunks.at(-1)).toBe("data: [DONE]");
    const content = chunks
      .slice(0, -1)
      .map((c) => JSON.parse(c.slice(6)).choices[0].delta.content ?? "")
      .join("");
    expect(content).toBe("Hello there. How can I help? ");
    expect(text).not.toContain("[[type");
  });

  it("rejects a body without a call id", async () => {
    expect((await post("/chat/completions", { messages: [] })).status).toBe(400);
  });

  it("end-of-call report: sets final status and flags a missed follow-up once", async () => {
    const report = { message: { type: "end-of-call-report", call: { id: "call-9" }, analysis: { summary: "Caller asked about a payout." } } };
    expect((await post("/vapi/events", report, { "x-vapi-secret": SECRET })).status).toBe(200);
    await post("/vapi/events", report, { "x-vapi-secret": SECRET });
    expect(ended[0]).toEqual({ id: "call-9", finalStatus: "resolved", callerId: "CUS-1001" });
    expect(events.filter((e) => e === "missed_followup")).toHaveLength(1);
  });

  it("other Vapi events are acknowledged and ignored", async () => {
    summary = { ...summary };
    expect((await post("/vapi/events", { message: { type: "status-update", call: { id: "x" } } })).status).toBe(200);
  });
});
