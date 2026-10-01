import { describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelInput } from "../src/agent/modelRunner.js";
import type { RetrievalResult } from "../src/agent/retrieval.js";
import { FAILURE_REPLY, HOLDING_REPLY, LOOKUP_ACK, runTurn, STALL_REPLY, type TurnDeps } from "../src/agent/runTurn.js";
import { GUARD_FALLBACK } from "../src/agent/speechGuard.js";
import { UNINTELLIGIBLE_LIMIT_REPLY, UNINTELLIGIBLE_REPLY } from "../src/agent/inputGate.js";
import type { PriorActions, TurnClaim, TurnResult, TurnStore } from "../src/logging/turnStore.js";

class FakeStore implements TurnStore {
  turns = new Map<string, { status: string; transcript?: string; result?: Partial<TurnResult>; error?: string; updatedAt: number }>();
  events: { type: string; metadata?: Record<string, unknown> }[] = [];
  rejected: string[] = [];
  prior: PriorActions = { identifiedCustomer: null, tickets: [], escalations: [] };
  async priorActions() {
    return this.prior;
  }
  async claimTurn(c: string, _channel: string, i: number, transcript = ""): Promise<TurnClaim> {
    const key = `${c}:${i}`;
    const t = this.turns.get(key);
    // Same rule as migration 011: a different transcript takes the turn over.
    if (!t || t.transcript !== transcript) {
      this.turns.set(key, { status: "in_progress", transcript, updatedAt: Date.now() });
      return { state: "claimed" };
    }
    if (t.status === "completed") return { state: "completed", response: t.result?.assistantResponse ?? "" };
    if (t.status === "in_progress") return { state: "in_progress", ageMs: Date.now() - t.updatedAt };
    return { state: "failed" };
  }
  async completeTurn(c: string, i: number, result: TurnResult, transcript: string) {
    if (this.turns.get(`${c}:${i}`)?.transcript !== transcript) return;
    this.turns.set(`${c}:${i}`, { status: "completed", transcript, result, updatedAt: Date.now() });
  }
  async failTurn(c: string, i: number, error: string, result: Partial<TurnResult>, transcript: string) {
    if (this.turns.get(`${c}:${i}`)?.transcript !== transcript) return;
    this.turns.set(`${c}:${i}`, { status: "failed", transcript, error, result, updatedAt: Date.now() });
  }
  async event(_c: string, type: string, _s: string, metadata?: Record<string, unknown>) {
    this.events.push({ type, metadata });
  }
  async toolCallRejected(_c: string, _i: number, tool: string) {
    this.rejected.push(tool);
  }
}

const matched: RetrievalResult = {
  chunks: [{ id: 1, section: "FAQ", title: "Fees", content: "Fees vary.", summary: "Fees vary.", score: 0.55 }],
  matched: true, method: "vector", topScore: 0.55,
};

function setup(events: ModelEvent[] | ((input: ModelInput) => AsyncIterable<ModelEvent>), retrieval: RetrievalResult = matched) {
  const store = new FakeStore();
  const prompts: string[] = [];
  const retrieved: string[] = [];
  const deps: TurnDeps = {
    store,
    model: "claude-sonnet-5-5",
    retrieve: async (q) => {
      retrieved.push(q);
      return retrieval;
    },
    runModel:
      typeof events === "function"
        ? events
        : async function* (input) {
            prompts.push(input.prompt);
            for (const e of events) yield e;
          },
  };
  return { store, deps, prompts, retrieved };
}

const collect = async (gen: AsyncGenerator<string>) => {
  const out: string[] = [];
  for await (const s of gen) out.push(s);
  return out;
};

const req = (content: string, history: { role: string; content: string }[] = []) => ({
  conversationId: "call-1", channel: "web", messages: [...history, { role: "user", content }],
});

const result: ModelEvent = { type: "result", isError: false, error: null, costUsd: 0.004, inputTokens: 900, outputTokens: 40, cacheReadTokens: 800 };

describe("runTurn", () => {
  it("answers, strips the tag, and logs the turn", async () => {
    const { store, deps, prompts, retrieved } = setup([
      { type: "text", text: "Fees vary by transaction type, corridor and payment method. " },
      { type: "text", text: "You'll see them before you confirm. [[type:answer;confidence:high]]" },
      result,
    ]);
    const spoken = await collect(runTurn(deps, req("What fees do you charge?")));
    expect(spoken).toEqual(["Fees vary by transaction type, corridor and payment method.", "You'll see them before you confirm."]);
    expect(retrieved).toEqual(["What fees do you charge?"]);
    expect(prompts[0]).toContain("Approved knowledge for this turn");
    expect(store.turns.get("call-1:0")?.result).toMatchObject({
      answerType: "answer", confidenceNote: "high; top_similarity=0.55", retrievalUsed: true, costUsd: 0.004, cacheReadTokens: 800,
    });
  });

  it("unintelligible input: fixed reply, no model call, no retrieval", async () => {
    const { deps, prompts, retrieved, store } = setup([result]);
    expect(await collect(runTurn(deps, req("xkcdqwrt zzzzbrr")))).toEqual([UNINTELLIGIBLE_REPLY]);
    expect(prompts).toHaveLength(0);
    expect(retrieved).toHaveLength(0);
    expect(store.turns.get("call-1:0")?.result).toMatchObject({ answerType: "clarify", confidenceNote: "unintelligible" });
  });

  it("third unintelligible turn in a row points the caller elsewhere", async () => {
    const { deps } = setup([result]);
    const history = [
      { role: "user", content: "zzzbrrt" }, { role: "assistant", content: UNINTELLIGIBLE_REPLY },
      { role: "user", content: "hmmmrrrg" }, { role: "assistant", content: UNINTELLIGIBLE_REPLY },
    ];
    expect(await collect(runTurn(deps, req("xkcdqwrt", history)))).toEqual([UNINTELLIGIBLE_LIMIT_REPLY]);
  });

  it("small talk: model runs, retrieval is skipped", async () => {
    const { deps, retrieved, prompts } = setup([{ type: "text", text: "I'm well, thanks! How can I help? [[type:clarify;confidence:high]]" }, result]);
    await collect(runTurn(deps, req("How are you?")));
    expect(retrieved).toHaveLength(0);
    expect(prompts[0]).toContain("small talk");
  });

  it("a Vapi retry of a completed turn replays the stored reply without re-running", async () => {
    const { deps, prompts } = setup([{ type: "text", text: "Done. [[type:answer;confidence:high]]" }, result]);
    await collect(runTurn(deps, req("What fees do you charge?")));
    expect(await collect(runTurn(deps, req("What fees do you charge?")))).toEqual(["Done."]);
    expect(prompts).toHaveLength(1);
  });

  it("a retry while the first attempt is still running gets a holding line", async () => {
    const { deps, store } = setup([result]);
    await store.claimTurn("call-1", "web", 0, "What fees do you charge?");
    expect(await collect(runTurn(deps, req("What fees do you charge?")))).toEqual([HOLDING_REPLY]);
  });

  it("a longer transcript for the same turn takes it over, and the stale attempt can't overwrite it", async () => {
    const { deps, store } = setup([{ type: "text", text: "Payouts take one to two days. [[type:answer;confidence:high]]" }, result]);
    await store.claimTurn("call-1", "web", 0, "Hi. I'm Jade.");
    expect(await collect(runTurn(deps, req("Hi. I'm Jade. How long do payouts take?")))).toEqual(["Payouts take one to two days."]);
    await store.completeTurn("call-1", 0, { assistantResponse: "stale" } as TurnResult, "Hi. I'm Jade.");
    expect(store.turns.get("call-1:0")?.result?.assistantResponse).toBe("Payouts take one to two days.");
  });

  it("blocks internal notes from a tool result, and logs the block without the text", async () => {
    const { deps, store } = setup([
      { type: "text", text: "Let me check that. " },
      { type: "tool_result", tool: "mcp__relaypay__lookup_customer", isError: false, text: JSON.stringify({ found: true, support_notes: "Account is under compliance review. Escalate account-specific questions." }) },
      { type: "text", text: "Your notes say the account is under compliance review. A specialist will need to help with this. [[type:escalate;confidence:high]]" },
      result,
    ]);
    const spoken = await collect(runTurn(deps, req("Can you check my account?")));
    expect(spoken).toEqual(["Let me check that.", "A specialist will need to help with this."]);
    const block = store.events.find((e) => e.type === "internal_text_blocked");
    expect(block?.metadata).toMatchObject({ field: "support_notes" });
    expect(JSON.stringify(store.events)).not.toContain("compliance review");
  });

  it("if every sentence is blocked, the caller hears the specialist fallback", async () => {
    const { deps } = setup([{ type: "text", text: "I guarantee it arrives by 9am. [[type:answer;confidence:low]]" }, result]);
    expect(await collect(runTurn(deps, req("Can you guarantee my payout by 9am tomorrow?")))).toEqual([GUARD_FALLBACK]);
  });

  it("a model failure before any text: failure line, turn marked failed", async () => {
    const { deps, store } = setup(async function* () {
      throw new Error("anthropic 529");
    });
    expect(await collect(runTurn(deps, req("What fees do you charge?")))).toEqual([FAILURE_REPLY]);
    expect(store.turns.get("call-1:0")).toMatchObject({ status: "failed" });
  });

  it("records follow-up statuses and MCP rejections", async () => {
    const { deps, store } = setup([
      { type: "tool_result", tool: "mcp__relaypay__lookup_payout", isError: false, text: JSON.stringify({ found: true, status: "review required" }) },
      { type: "tool_result", tool: "mcp__relaypay__create_escalation", isError: true, text: "Input validation error: Invalid arguments for tool create_escalation: user_name" },
      { type: "text", text: "A specialist needs to review this. [[type:escalate;confidence:high]]" },
      result,
    ]);
    await collect(runTurn(deps, req("What is happening with payout PAY-7002?")));
    expect(store.events.map((e) => e.type)).toContain("follow_up_status_seen");
    expect(store.rejected).toEqual(["mcp__relaypay__create_escalation"]);
  });

  it("flags an answer given with no matching knowledge and no tool result", async () => {
    const noMatch: RetrievalResult = { chunks: [], matched: false, method: "vector", topScore: 0.2 };
    const { deps, store, prompts } = setup([{ type: "text", text: "Sure, it's sunny. [[type:answer;confidence:low]]" }, result], noMatch);
    await collect(runTurn(deps, req("What's the weather in Lagos today?")));
    expect(prompts[0]).toContain("No approved knowledge matches");
    expect(store.events.map((e) => e.type)).toContain("ungrounded_answer");
  });

  it("turn index is the caller's message count, so retries map to the same turn", async () => {
    const { deps, store } = setup([{ type: "text", text: "Okay. [[type:clarify;confidence:high]]" }, result]);
    await collect(runTurn(deps, req("It's TXN-9001", [{ role: "assistant", content: "Hi, I'm Iris." }, { role: "user", content: "My payment is stuck" }, { role: "assistant", content: "Which reference?" }])));
    expect([...store.turns.keys()]).toEqual(["call-1:1"]);
  });

  it("speaks an acknowledgement when a lookup starts, before the result", async () => {
    const { deps } = setup([
      { type: "tool_start", tool: "mcp__relaypay__lookup_transaction" },
      { type: "tool_result", tool: "mcp__relaypay__lookup_transaction", isError: false, text: JSON.stringify({ found: true, status: "processing" }) },
      { type: "text", text: "It's processing. [[type:answer;confidence:high]]" },
      result,
    ]);
    expect(await collect(runTurn(deps, req("Can you check transaction TXN-9001?")))).toEqual([LOOKUP_ACK, "It's processing."]);
  });

  it("if only the acknowledgement was spoken before a failure, the caller still hears the failure line", async () => {
    const { deps } = setup(async function* () {
      yield { type: "tool_start", tool: "mcp__relaypay__lookup_transaction" } as ModelEvent;
      throw new Error("mcp down");
    });
    expect(await collect(runTurn(deps, req("Can you check transaction TXN-9001?")))).toEqual([LOOKUP_ACK, FAILURE_REPLY]);
  });

  it("a model silent at 8s gets a holding line, and is stopped (not waited on) at 20s", async () => {
    vi.useFakeTimers();
    const abortSeen: boolean[] = [];
    const { deps, store } = setup(async function* (input) {
      input.abortController.signal.addEventListener("abort", () => abortSeen.push(true));
      await new Promise(() => {}); // never yields
    });
    const out: string[] = [];
    const pending = (async () => {
      for await (const s of runTurn(deps, req("What fees do you charge?"))) out.push(s);
    })();
    await vi.advanceTimersByTimeAsync(8100);
    expect(out).toEqual([STALL_REPLY]);
    await vi.advanceTimersByTimeAsync(12_100);
    await pending;
    expect(out).toEqual([STALL_REPLY, FAILURE_REPLY]);
    expect(abortSeen).toEqual([true]);
    expect(store.turns.get("call-1:0")).toMatchObject({ status: "failed", error: "no model activity within 20s" });
    vi.useRealTimers();
  });

  it("a slow start that recovers after the holding line still answers normally", async () => {
    vi.useFakeTimers();
    const { deps, store } = setup(async function* () {
      await new Promise((r) => setTimeout(r, 9000));
      yield { type: "activity" } as ModelEvent;
      yield { type: "text", text: "Fees vary by corridor. [[type:answer;confidence:high]]" } as ModelEvent;
      yield result;
    });
    const out: string[] = [];
    const pending = (async () => {
      for await (const s of runTurn(deps, req("What fees do you charge?"))) out.push(s);
    })();
    await vi.advanceTimersByTimeAsync(9500);
    await pending;
    expect(out).toEqual([STALL_REPLY, "Fees vary by corridor."]);
    expect(store.turns.get("call-1:0")).toMatchObject({ status: "completed" });
    vi.useRealTimers();
  });

  it("declines and clarifications are logged by code, not the model", async () => {
    const { deps, store } = setup([{ type: "text", text: "Is it incoming or outgoing? [[type:clarify;confidence:high]]" }, result]);
    await collect(runTurn(deps, req("My payment is stuck.")));
    expect(store.events.map((e) => e.type)).toContain("clarification_requested");
  });

  it("records per-phase timings on the turn", async () => {
    const { deps, store } = setup([{ type: "text", text: "Fees vary. [[type:answer;confidence:high]]" }, result]);
    await collect(runTurn(deps, req("What fees do you charge?")));
    const timings = store.turns.get("call-1:0")?.result?.timings ?? {};
    for (const phase of ["claim", "retrieval", "first_text", "first_spoken", "total"]) expect(timings[phase]).toBeTypeOf("number");
  });

  it("tells the model what this call already did, from the store", async () => {
    const { deps, store, prompts } = setup([{ type: "text", text: "Your escalation is in. [[type:escalate;confidence:high]]" }, result]);
    store.prior = { identifiedCustomer: "CUS-1003", tickets: [{ id: "TKT-1", turn: 0 }], escalations: [{ id: "ESC-1", turn: 2 }] };
    await collect(runTurn(deps, req("Please escalate this again.", [{ role: "user", content: "My account is restricted." }, { role: "assistant", content: "Sorry." }])));
    expect(prompts[0]).toContain("Already done in this call");
    expect(prompts[0]).toContain("Support ticket TKT-1 created (turn 0)");
    expect(prompts[0]).toContain("Escalation ESC-1 created (turn 2)");
    expect(prompts[0]).toContain("signed in as customer CUS-1003");
  });

  it("kill switch on: the fixed unavailable line, and the model is never called", async () => {
    const { deps, prompts, store } = setup([{ type: "text", text: "Hello. [[type:answer;confidence:high]]" }, result]);
    const out = await collect(runTurn({ ...deps, maintenance: async () => true }, req("What fees do you charge?")));
    expect(out).toEqual(["Support is temporarily unavailable. Please use your RelayPay dashboard."]);
    expect(prompts).toHaveLength(0);
    expect(store.turns.get("call-1:0")?.result).toMatchObject({ confidenceNote: "maintenance" });
  });

  it("over the spending cap: a polite closing line, no model call", async () => {
    const { deps, prompts, store } = setup([{ type: "text", text: "Hi. [[type:answer;confidence:high]]" }, result]);
    const capped = { ...deps, spend: { soFar: async () => 0.62, capUsd: 0.5 } };
    const out = await collect(runTurn(capped, req("And one more thing?", [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }])));
    expect(out[0]).toContain("reached the limit for this call");
    expect(out[0]).toContain("This call will now end.");
    expect(prompts).toHaveLength(0);
    expect(store.events.map((e) => e.type)).toContain("cost_cap_reached");
  });

  it("under the cap, the turn runs normally", async () => {
    const { deps } = setup([{ type: "text", text: "Sure. [[type:answer;confidence:high]]" }, result]);
    const out = await collect(runTurn({ ...deps, spend: { soFar: async () => 0.1, capUsd: 0.5 } }, req("Next?", [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }])));
    expect(out).toEqual(["Sure."]);
  });

  it("tells the model on the first turn whether the caller is signed in", async () => {
    const { deps, store, prompts } = setup([{ type: "text", text: "Hi. [[type:answer;confidence:high]]" }, result]);
    await collect(runTurn(deps, req("Can you check my account?")));
    expect(prompts[0]).toContain("The caller is not signed in.");
    store.prior = { identifiedCustomer: "CUS-1006", tickets: [], escalations: [] };
    await collect(runTurn(deps, { ...req("Can you check my account?"), conversationId: "call-2" }));
    expect(prompts[1]).toContain("signed in as customer CUS-1006");
  });
});
