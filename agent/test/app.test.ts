import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { signCallToken } from "../src/callToken.js";
import type { CallStore, CallSummary } from "../src/logging/callStore.js";
import type { TurnStore } from "../src/logging/turnStore.js";

const SECRET = "vapi-secret-that-is-at-least-32-characters";

const turnStore: TurnStore = {
  priorActions: async () => ({ identifiedCustomer: null, tickets: [], escalations: [] }),
  claimTurn: async () => ({ state: "claimed" }),
  completeTurn: async () => true,
  failTurn: async () => true,
  event: async () => {},
  toolCallRejected: async () => {},
};

const ended: { id: string; finalStatus: string; callerId: string; costUsd?: number | null; durationS?: number | null }[] = [];
const events: string[] = [];
let summary: CallSummary = { tickets: 0, escalations: 0, turns: 2, followUpSeen: true, identifiedCustomer: "CUS-1001" };
const calls: CallStore = {
  summarize: async () => summary,
  endCall: async (id, f) => void ended.push({ id, finalStatus: f.finalStatus, callerId: f.callerId, costUsd: f.costUsd, durationS: f.durationS }),
  event: async (_id, type) => void events.push(type),
  hasEvent: async (_id, type) => events.includes(type),
};

// Token gate: calls start with a token signed by the web app (design §8).
const TOKEN_SECRET = "call-token-secret-at-least-32-characters";
const verified = new Set<string>();
const usedNonces = new Map<string, string>();
const gateEvents: string[] = [];
const gate = {
  tokenSecret: TOKEN_SECRET,
  store: {
    isVerified: async (id: string) => verified.has(id),
    claimNonce: async (id: string, nonce: string, _customerId: string | null) => {
      const owner = usedNonces.get(nonce);
      if (owner && owner !== id) return false;
      usedNonces.set(nonce, id);
      verified.add(id);
      return true;
    },
    event: async (_id: string, type: string) => void gateEvents.push(type),
    spentSoFar: async () => 0,
  },
};
const token = (nonce = "n".repeat(22), exp = Math.floor(Date.now() / 1000) + 120) => signCallToken(TOKEN_SECRET, { n: nonce, e: exp });

let base = "";
let close: () => void;
beforeAll(async () => {
  const app = createApp({
    vapiSecret: SECRET,
    calls,
    gate,
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
    const res = await post("/chat/completions", { stream: true, call: { id: "call-9", metadata: { callToken: token("a".repeat(22)) } }, messages: [{ role: "user", content: "Can you help me with a payout?" }] });
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
    const report = { message: { type: "end-of-call-report", call: { id: "call-9" }, cost: 0.042, durationSeconds: 95.4, analysis: { summary: "Caller asked about a payout." } } };
    expect((await post("/vapi/events", report, { "x-vapi-secret": SECRET })).status).toBe(200);
    await post("/vapi/events", report, { "x-vapi-secret": SECRET });
    expect(ended[0]).toEqual({ id: "call-9", finalStatus: "resolved", callerId: "CUS-1001", costUsd: 0.042, durationS: 95.4 });
    expect(events.filter((e) => e === "missed_followup")).toHaveLength(1);
  });

  it("other Vapi events are acknowledged and ignored", async () => {
    summary = { ...summary };
    expect((await post("/vapi/events", { message: { type: "status-update", call: { id: "x" } } })).status).toBe(200);
  });

  const speak = async (call: Record<string, unknown>) => {
    const res = await post("/chat/completions", { stream: true, call, messages: [{ role: "user", content: "Hello, can you help?" }] });
    return (await res.text()).split("\n\n").filter((c) => c.startsWith("data: {")).map((c) => JSON.parse(c.slice(6)).choices[0].delta.content ?? "").join("");
  };

  it("refuses a web call with no start token, and ends it", async () => {
    const text = await speak({ id: "call-no-token" });
    expect(text).toContain("couldn't be started");
    expect(text).toContain("This call will now end.");
    expect(gateEvents).toContain("call_token_invalid");
  });

  it("refuses an expired or forged token", async () => {
    expect(await speak({ id: "call-expired", metadata: { callToken: token("b".repeat(22), 1) } })).toContain("couldn't be started");
    const forged = signCallToken("some-other-secret-that-is-32-chars-long", { n: "c".repeat(22), e: Math.floor(Date.now() / 1000) + 60 });
    expect(await speak({ id: "call-forged", metadata: { callToken: forged } })).toContain("couldn't be started");
  });

  it("a token starts exactly one call", async () => {
    const t = token("d".repeat(22));
    expect(await speak({ id: "call-first", metadata: { callToken: t } })).not.toContain("couldn't be started");
    expect(await speak({ id: "call-second", metadata: { callToken: t } })).toContain("couldn't be started");
  });

  it("later turns of a verified call don't need the token again", async () => {
    await speak({ id: "call-multi", assistantOverrides: { metadata: { callToken: token("e".repeat(22)) } } });
    expect(await speak({ id: "call-multi" })).not.toContain("couldn't be started");
  });

  it("phone calls are exempt (no browser to issue a token)", async () => {
    expect(await speak({ id: "call-phone", type: "inboundPhoneCall" })).not.toContain("couldn't be started");
  });
});
