import type { TurnResult, TurnStore } from "../logging/turnStore.js";
import {
  classifyInput,
  type GateClass,
  isDataOnly,
  priorUnintelligibleCount,
  UNINTELLIGIBLE_LIMIT,
  UNINTELLIGIBLE_LIMIT_REPLY,
  UNINTELLIGIBLE_REPLY,
} from "./inputGate.js";
import type { ModelEvent, ModelRunner } from "./modelRunner.js";
import { TagStripper, type AnswerType } from "./outcomeTag.js";
import { formatForPrompt, type RetrievalResult, type RetrievalScope } from "./retrieval.js";
import { checkSentence, GUARD_FALLBACK, internalSegments, SentenceSplitter, type InternalText } from "./speechGuard.js";
import { buildTurnPrompt, PROMPT_VERSION } from "./systemPrompt.js";
import { log } from "../logger.js";

// One spoken turn (design §2). Yields sentences as they pass the speech guard.

// The caller asking about a ticket, escalation or something Iris said or did earlier in the call.
const EARLIER_ACTION = /\b(ticket|escalat\w*|specialist|why did you|you (said|did|logged|created|made|opened|raised))\b/i;

/**
 * Best guess for a reply the model didn't tag. A reply after a successful lookup is an answer, even
 * when it ends with "anything else?". Otherwise a closing question means clarify. (A knowledge match
 * isn't used: it shows the caller's words resembled some knowledge, not that the reply used it.)
 */
function inferAnswerType(spoken: string[], gate: GateClass, grounded: boolean): AnswerType {
  if (gate === "small_talk") return "social";
  if (grounded) return "answer";
  const last = spoken.filter((s) => s !== LOOKUP_ACK && s !== STALL_REPLY).at(-1) ?? "";
  return last.trim().endsWith("?") ? "clarify" : "answer";
}

// A follow-up about a record already looked up in this call ("can you guarantee it arrives then?").
const ABOUT_A_RECORD = /\b(payouts?|transactions?|payments?|arriv\w*|status|records?|guarantee\w*|on track|late)\b/i;

export const HOLDING_REPLY = "One moment, I'm still working on that.";
export const FAILURE_REPLY =
  "I'm having trouble right now. Please try again in a few minutes, or contact support from your RelayPay dashboard.";
export const LOOKUP_ACK = "Let me check that for you.";
export const STALL_REPLY = "Sorry, just a moment.";
// Vapi hangs up when the assistant says this (endCallPhrases in vapi/assistant.json).
export const END_CALL_PHRASE = "This call will now end.";
// Stopped from the dashboard: said once, then the call ends.
export const MAINTENANCE_REPLY = `Support is temporarily unavailable. Please use your RelayPay dashboard. ${END_CALL_PHRASE}`;
export const COST_CAP_REPLY = `I've reached the limit for this call. Please contact support from your RelayPay dashboard. ${END_CALL_PHRASE}`;

// No model activity after 8s: say a holding line and keep waiting (occasionally the
// SDK is slow to start; giving up there would fail a turn that was about to succeed).
// No activity by 20s, or a whole turn over 25s: stop the SDK and fail the turn (design §7.1).
const STALL_NOTICE_MS = 8000;
const FIRST_ACTIVITY_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 25_000;
const RETRY_IN_PROGRESS_MS = 30_000;
const INTERNAL_FIELDS = ["support_notes", "support_summary"] as const;
const FOLLOW_UP_STATUSES = new Set(["review required", "failed", "restricted"]);

export type ChatMessage = { role: string; content?: unknown };

export type TurnRequest = {
  conversationId: string;
  channel: string;
  messages: ChatMessage[];
  /** Fires when Vapi drops the request (the caller kept talking): the attempt stops and logs nothing. */
  signal?: AbortSignal;
};

export type TurnDeps = {
  store: TurnStore;
  runModel: ModelRunner;
  retrieve: (query: string, scope: RetrievalScope) => Promise<RetrievalResult>;
  model: string;
  /** The dashboard's kill switch (app_settings.maintenance). When on, the model is never called. */
  maintenance?: () => Promise<boolean>;
  /** Per-call spending cap (design §8): model spend so far on this call, and the limit. */
  spend?: { soFar: (conversationId: string) => Promise<number>; capUsd: number };
  now?: () => number;
};

/** OpenAI-format content can be a string or an array of parts. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join(" ");
  }
  return "";
}

// A failed log write is recorded on stderr; it never blocks or changes the spoken reply.
async function safely(what: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    log.error({ err }, `${what} failed`);
  }
}

export async function* runTurn(deps: TurnDeps, req: TurnRequest): AsyncGenerator<string> {
  const now = deps.now ?? Date.now;
  const started = now();
  const store = deps.store;
  const conv = req.conversationId;

  const history = req.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: messageText(m.content).trim() }))
    .filter((m) => m.content);
  const lastUser = history.map((m) => m.role).lastIndexOf("user");
  const latest = lastUser >= 0 ? history[lastUser].content : "";
  const prior = lastUser >= 0 ? history.slice(0, lastUser) : history;
  // Stable across Vapi retries of the same turn: the number of caller messages so far.
  const turnIndex = Math.max(0, history.filter((m) => m.role === "user").length - 1);

  const timings: Record<string, number> = {};
  const mark = (phase: string) => {
    if (timings[phase] === undefined) timings[phase] = now() - started;
  };

  const gate = classifyInput(latest);
  // Claimed first so the conversation row exists before anything references it.
  const claimed = store.claimTurn(conv, req.channel, turnIndex, latest);
  const scope = { conversationId: conv, turnIndex, ready: claimed };
  // Retrieval runs alongside the database round-trip below (design §2 step 3b).
  const retrieval =
    gate === "normal" && !isDataOnly(latest)
      ? deps.retrieve(latest, scope).catch((err) => {
          log.error({ err }, "retrieval failed");
          return null;
        })
      : Promise.resolve(null);

  // What this call already did, read in parallel with retrieval (design: stateless turns, state from our records).
  // Read on every turn, the first included: it carries who the caller is signed in as.
  const priorActions = store.priorActions(conv).catch((err) => {
        log.error({ err }, "priorActions failed");
        return null;
      });

  // Spend so far, read alongside retrieval; the first turn can't be over the cap.
  const spentSoFar =
    deps.spend && turnIndex > 0
      ? deps.spend.soFar(conv).catch((err) => {
          log.error({ err }, "spend read failed");
          return 0;
        })
      : Promise.resolve(0);

  const claim = await claimed;
  mark("claim");
  if (claim.state === "completed") {
    yield claim.response;
    return;
  }
  if (claim.state === "in_progress" && claim.ageMs < RETRY_IN_PROGRESS_MS) {
    yield HOLDING_REPLY;
    return;
  }

  const base = { model: null, promptVersion: null, costUsd: null, inputTokens: null, outputTokens: null, cacheReadTokens: null };

  if (deps.spend && (await spentSoFar) >= deps.spend.capUsd) {
    yield COST_CAP_REPLY;
    await safely("cost cap event", () =>
      store.event(conv, "cost_cap_reached", `Call ended at the $${deps.spend!.capUsd.toFixed(2)} spending cap.`, { turn_index: turnIndex }),
    );
    await safely("completeTurn", () =>
      store.completeTurn(conv, turnIndex, {
        ...base, assistantResponse: COST_CAP_REPLY, answerType: "decline", confidenceNote: "cost_cap",
        retrievalUsed: false, latencyMs: now() - started, timings: { ...timings, total: now() - started },
      }, latest),
    );
    return;
  }

  if (deps.maintenance && (await deps.maintenance())) {
    yield MAINTENANCE_REPLY;
    await safely("completeTurn", () =>
      store.completeTurn(conv, turnIndex, {
        ...base, assistantResponse: MAINTENANCE_REPLY, answerType: "decline", confidenceNote: "maintenance",
        retrievalUsed: false, latencyMs: now() - started, timings: { ...timings, total: now() - started },
      }, latest),
    );
    return;
  }

  if (gate === "unintelligible") {
    const priorCount = priorUnintelligibleCount(prior.filter((m) => m.role === "assistant").map((m) => m.content));
    const reply = priorCount + 1 >= UNINTELLIGIBLE_LIMIT ? UNINTELLIGIBLE_LIMIT_REPLY : UNINTELLIGIBLE_REPLY;
    yield reply;
    await safely("completeTurn", () =>
      store.completeTurn(conv, turnIndex, {
        ...base, assistantResponse: reply, answerType: "clarify", confidenceNote: "unintelligible",
        retrievalUsed: false, latencyMs: now() - started, timings: { ...timings, total: now() - started },
      }, latest),
    );
    return;
  }

  const retrieved = await retrieval;
  mark("retrieval");
  const knowledge = retrieved ? formatForPrompt(retrieved) : null;
  let kbSearched = false;
  const prompt = buildTurnPrompt({
    conversationId: conv, history: prior, latest, knowledge, smallTalk: gate === "small_talk", priorActions: await priorActions,
  });

  const internal: InternalText[] = [];
  const spoken: string[] = [];
  const stripper = new TagStripper();
  const splitter = new SentenceSplitter();
  let blocked = 0;
  let toolSucceeded = false;
  let metrics = { costUsd: null as number | null, inputTokens: null as number | null, outputTokens: null as number | null, cacheReadTokens: null as number | null };
  let modelError: string | null = null;

  const speak = async function* (sentences: string[]) {
    for (const sentence of sentences) {
      const reason = checkSentence(sentence, internalSegments(internal));
      if (reason) {
        blocked++;
        // Record what was matched, never the text itself.
        await safely("guard event", () =>
          reason.kind === "guarantee"
            ? store.event(conv, "guarantee_blocked", "A sentence promising an outcome was held back.", { turn_index: turnIndex })
            : store.event(conv, "internal_text_blocked", "A sentence repeating internal text was held back.", {
                turn_index: turnIndex, field: reason.field, tool: reason.tool,
              }),
        );
        continue;
      }
      spoken.push(sentence);
      mark("first_spoken");
      yield sentence;
    }
  };

  const abort = new AbortController();
  let sawActivity = false;
  let acked = false;
  let timedOut: string | null = null;
  // Rejects when a limit is hit, so the loop below stops at once instead of
  // waiting for the SDK to wind down.
  let stop: (reason: Error) => void = () => {};
  const stopped = new Promise<never>((_, reject) => (stop = reject));
  stopped.catch(() => {});
  const limit = (ms: number, why: string, onlyIfIdle: boolean) =>
    setTimeout(() => {
      if (onlyIfIdle && sawActivity) return;
      timedOut = why;
      abort.abort();
      stop(new Error(why));
    }, ms);
  const onCancel = () => {
    abort.abort();
    stop(new Error("request cancelled"));
  };
  if (req.signal?.aborted) onCancel();
  req.signal?.addEventListener("abort", onCancel, { once: true });
  const timers = [limit(FIRST_ACTIVITY_TIMEOUT_MS, "no model activity within 20s", true), limit(TURN_TIMEOUT_MS, "turn exceeded 25s", false)];
  // Resolves if the model is still silent at 8s, so the loop below can speak a holding line.
  let stallTimer: NodeJS.Timeout | undefined;
  const stalled = new Promise<"stalled">((resolve) => {
    stallTimer = setTimeout(() => resolve("stalled"), STALL_NOTICE_MS);
  });
  timers.push(stallTimer!);
  let stallNoticed = false;
  let pending: Promise<IteratorResult<ModelEvent>> | undefined;

  try {
    const events = deps.runModel({
      prompt,
      conversationId: conv,
      turnIndex,
      abortController: abort,
      searchKnowledge: async (q) => {
        kbSearched = true;
        const result = await deps.retrieve(q, scope);
        return formatForPrompt(result);
      },
    });

    const iterator = events[Symbol.asyncIterator]();
    pending = iterator.next();
    while (true) {
      const next = await Promise.race([pending, stopped, ...(stallNoticed || sawActivity ? [] : [stalled])]);
      if (next === "stalled") {
        stallNoticed = true;
        mark("stall_notice");
        log.warn({ conversation_id: conv, turn_index: turnIndex }, "model silent after 8s, holding");
        if (spoken.length === 0) yield* speak([STALL_REPLY]);
        continue; // keep waiting on the same pending event
      }
      if (next.done) break;
      pending = iterator.next();
      const event = next.value;
      if (event.type === "mcp_status") mark("sdk_init");
      else if (event.type === "activity") mark("first_activity");
      else if (event.type === "text") mark("first_text");
      else if (event.type === "tool_start") mark("first_tool");

      if (event.type === "activity") {
        sawActivity = true;
      } else if (event.type === "tool_start") {
        sawActivity = true;
        // The model doesn't speak before tool calls, so the code fills the silence (design §4.2 item 6).
        if (!acked && spoken.length === 0 && /^mcp__relaypay__lookup_/.test(event.tool)) {
          acked = true;
          yield* speak([LOOKUP_ACK]);
        }
      } else if (event.type === "text") {
        sawActivity = true;
        yield* speak(splitter.push(stripper.push(event.text)));
      } else if (event.type === "tool_result") {
        if (event.isError) {
          if (/Input validation error/i.test(event.text)) {
            await safely("toolCallRejected", () => store.toolCallRejected(conv, turnIndex, event.tool, event.text));
          } else {
            // Any error the model saw (including the SDK giving up on a tool), so it shows in v_failures.
            await safely("tool error event", () =>
              store.event(conv, "tool_error_seen", `${event.tool} returned an error to the model.`, { turn_index: turnIndex, tool: event.tool, error: event.text.slice(0, 200) }),
            );
          }
          continue;
        }
        toolSucceeded = true;
        try {
          const data = JSON.parse(event.text) as Record<string, unknown>;
          for (const field of INTERNAL_FIELDS) {
            if (typeof data[field] === "string") internal.push({ tool: event.tool, field, text: data[field] as string });
          }
          for (const field of ["status", "account_status", "kyc_status"]) {
            if (FOLLOW_UP_STATUSES.has(String(data[field] ?? ""))) {
              await safely("follow-up event", () =>
                store.event(conv, "follow_up_status_seen", `${event.tool} returned ${field} "${data[field]}".`, { turn_index: turnIndex, tool: event.tool }),
              );
            }
          }
        } catch {
          // Not JSON (e.g. knowledge-base text): nothing internal to collect.
        }
      } else if (event.type === "mcp_status" && event.server === "relaypay" && event.status !== "connected") {
        await safely("mcp event", () => store.event(conv, "mcp_unavailable", `MCP server status: ${event.status}`, { turn_index: turnIndex }));
      } else if (event.type === "result") {
        metrics = { costUsd: event.costUsd, inputTokens: event.inputTokens, outputTokens: event.outputTokens, cacheReadTokens: event.cacheReadTokens };
        if (event.isError) modelError = event.error ?? "model error";
      }
    }
    yield* speak(splitter.push(stripper.flush()));
    yield* speak(splitter.flush());
  } catch (err) {
    modelError = timedOut ?? String(err);
  } finally {
    for (const t of timers) clearTimeout(t);
    req.signal?.removeEventListener("abort", onCancel);
    // After a stop, the SDK's last pending read may reject once its process is killed.
    pending?.catch(() => {});
  }

  // Vapi dropped this attempt: nobody hears it, and the newer attempt owns the turn's record.
  if (req.signal?.aborted) return;

  // Nothing but (at most) a holding line was said: the caller still needs a reply.
  if (!spoken.some((s) => s !== LOOKUP_ACK && s !== STALL_REPLY)) {
    const fallback = modelError || blocked === 0 ? FAILURE_REPLY : GUARD_FALLBACK;
    spoken.push(fallback);
    yield fallback;
  }

  // A missing tag still gets a type, so the turn's events are logged; confidence stays "untagged" to show it.
  const tagged = stripper.outcome();
  const outcome = tagged.answerType
    ? tagged
    : { ...tagged, answerType: inferAnswerType(spoken, gate, toolSucceeded) };
  const topScore = retrieved?.topScore;
  const result: TurnResult = {
    assistantResponse: spoken.join(" "),
    answerType: outcome.answerType,
    confidenceNote: outcome.confidence
      ? `${outcome.confidence}${topScore != null ? `; top_similarity=${topScore.toFixed(2)}` : ""}`
      : gate === "small_talk" ? "small_talk" : "untagged",
    retrievalUsed: Boolean(retrieved) || kbSearched,
    latencyMs: now() - started,
    model: deps.model,
    promptVersion: PROMPT_VERSION,
    ...metrics,
    timings: { ...timings, total: now() - started },
  };

  if (modelError) {
    await safely("failTurn", () => store.failTurn(conv, turnIndex, modelError!, result, latest));
    return;
  }
  let current = true;
  await safely("completeTurn", async () => {
    current = await store.completeTurn(conv, turnIndex, result, latest);
  });
  // Taken over by a newer attempt: its own outcome is the one that counts.
  if (!current) return;
  // Recorded by code from the outcome tag, so the model never spends a round-trip on it.
  const decisionEvent = outcome.answerType === "decline" ? "declined" : outcome.answerType === "clarify" ? "clarification_requested" : null;
  if (decisionEvent) {
    await safely("decision event", () =>
      store.event(conv, decisionEvent, `Iris ${decisionEvent === "declined" ? "declined" : "asked a clarifying question"}.`, { turn_index: turnIndex }),
    );
  }
  // An answer with neither matching knowledge nor a tool result behind it (design §4.4).
  // A question about what Iris already did in this call is grounded in the call's own records.
  const done = await priorActions;
  const aboutEarlierActions =
    (Boolean(done && done.tickets.length + done.escalations.length > 0) && EARLIER_ACTION.test(latest)) ||
    (Boolean(done?.lookupsFound) && ABOUT_A_RECORD.test(latest));
  if (outcome.answerType === "answer" && !retrieved?.matched && !kbSearched && !toolSucceeded && gate !== "small_talk" && !aboutEarlierActions) {
    await safely("ungrounded event", () =>
      store.event(conv, "ungrounded_answer", "Answered without matching knowledge or a tool result.", { turn_index: turnIndex }),
    );
  }
}
