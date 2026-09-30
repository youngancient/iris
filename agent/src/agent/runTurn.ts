import type { TurnResult, TurnStore } from "../logging/turnStore.js";
import {
  classifyInput,
  isDataOnly,
  priorUnintelligibleCount,
  UNINTELLIGIBLE_LIMIT,
  UNINTELLIGIBLE_LIMIT_REPLY,
  UNINTELLIGIBLE_REPLY,
} from "./inputGate.js";
import type { ModelRunner } from "./modelRunner.js";
import { TagStripper } from "./outcomeTag.js";
import { formatForPrompt, type RetrievalResult, type RetrievalScope } from "./retrieval.js";
import { checkSentence, GUARD_FALLBACK, internalSegments, SentenceSplitter, type InternalText } from "./speechGuard.js";
import { buildTurnPrompt, PROMPT_VERSION } from "./systemPrompt.js";

// One spoken turn (design §2). Yields sentences as they pass the speech guard.

export const HOLDING_REPLY = "One moment, I'm still working on that.";
export const FAILURE_REPLY =
  "I'm having trouble right now. Please try again in a few minutes, or contact support from your RelayPay dashboard.";

export const LOOKUP_ACK = "Let me check that for you.";

// The model must show signs of life within 8s (design §7.1), and a whole turn,
// tool calls included, gets 25s. Either limit ends the turn with the failure line.
const FIRST_ACTIVITY_TIMEOUT_MS = 8000;
const TURN_TIMEOUT_MS = 25_000;
const RETRY_IN_PROGRESS_MS = 30_000;
const INTERNAL_FIELDS = ["support_notes", "support_summary"] as const;
const FOLLOW_UP_STATUSES = new Set(["review required", "failed", "restricted"]);

export type ChatMessage = { role: string; content?: unknown };

export type TurnRequest = { conversationId: string; channel: string; messages: ChatMessage[] };

export type TurnDeps = {
  store: TurnStore;
  runModel: ModelRunner;
  retrieve: (query: string, scope: RetrievalScope) => Promise<RetrievalResult>;
  model: string;
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
    console.error(JSON.stringify({ level: "error", msg: `${what} failed`, err: String(err) }));
  }
}

export async function* runTurn(deps: TurnDeps, req: TurnRequest): AsyncGenerator<string> {
  const now = deps.now ?? Date.now;
  const started = now();
  const { store, conversationId: conv } = { store: deps.store, conversationId: req.conversationId };

  const history = req.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: messageText(m.content).trim() }))
    .filter((m) => m.content);
  const lastUser = history.map((m) => m.role).lastIndexOf("user");
  const latest = lastUser >= 0 ? history[lastUser].content : "";
  const prior = lastUser >= 0 ? history.slice(0, lastUser) : history;
  // Stable across Vapi retries of the same turn: the number of caller messages so far.
  const turnIndex = Math.max(0, history.filter((m) => m.role === "user").length - 1);

  const gate = classifyInput(latest);
  const scope = { conversationId: conv, turnIndex };
  // Retrieval runs alongside the database round-trips below (design §2 step 3b).
  const retrieval =
    gate === "normal" && !isDataOnly(latest)
      ? deps.retrieve(latest, scope).catch((err) => {
          console.error(JSON.stringify({ level: "error", msg: "retrieval failed", err: String(err) }));
          return null;
        })
      : Promise.resolve(null);

  await store.ensureConversation(conv, req.channel);
  const claim = await store.claimTurn(conv, turnIndex, latest);
  if (claim.state === "completed") {
    yield claim.response;
    return;
  }
  if (claim.state === "in_progress" && claim.ageMs < RETRY_IN_PROGRESS_MS) {
    yield HOLDING_REPLY;
    return;
  }

  const base = { model: null, promptVersion: null, costUsd: null, inputTokens: null, outputTokens: null, cacheReadTokens: null };

  if (gate === "unintelligible") {
    const priorCount = priorUnintelligibleCount(prior.filter((m) => m.role === "assistant").map((m) => m.content));
    const reply = priorCount + 1 >= UNINTELLIGIBLE_LIMIT ? UNINTELLIGIBLE_LIMIT_REPLY : UNINTELLIGIBLE_REPLY;
    yield reply;
    await safely("completeTurn", () =>
      store.completeTurn(conv, turnIndex, {
        ...base, assistantResponse: reply, answerType: "clarify", confidenceNote: "unintelligible",
        retrievalUsed: false, latencyMs: now() - started,
      }),
    );
    return;
  }

  const retrieved = await retrieval;
  const knowledge = retrieved ? formatForPrompt(retrieved) : null;
  let kbSearched = false;
  const prompt = buildTurnPrompt({ conversationId: conv, history: prior, latest, knowledge, smallTalk: gate === "small_talk" });

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
  const timers = [limit(FIRST_ACTIVITY_TIMEOUT_MS, "no model activity within 8s", true), limit(TURN_TIMEOUT_MS, "turn exceeded 25s", false)];

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
    while (true) {
      const next = await Promise.race([iterator.next(), stopped]);
      if (next.done) break;
      const event = next.value;
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
  }

  // Only the lookup acknowledgement was said: the caller still needs an answer.
  if (!spoken.some((s) => s !== LOOKUP_ACK)) {
    const fallback = modelError || blocked === 0 ? FAILURE_REPLY : GUARD_FALLBACK;
    spoken.push(fallback);
    yield fallback;
  }

  const outcome = stripper.outcome();
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
  };

  if (modelError) {
    await safely("failTurn", () => store.failTurn(conv, turnIndex, modelError!, result));
    return;
  }
  await safely("completeTurn", () => store.completeTurn(conv, turnIndex, result));
  // Recorded by code from the outcome tag, so the model never spends a round-trip on it.
  const decisionEvent = outcome.answerType === "decline" ? "declined" : outcome.answerType === "clarify" ? "clarification_requested" : null;
  if (decisionEvent) {
    await safely("decision event", () =>
      store.event(conv, decisionEvent, `Iris ${decisionEvent === "declined" ? "declined" : "asked a clarifying question"}.`, { turn_index: turnIndex }),
    );
  }
  // An answer with neither matching knowledge nor a tool result behind it (design §4.4).
  if (outcome.answerType === "answer" && !retrieved?.matched && !kbSearched && !toolSucceeded && gate !== "small_talk") {
    await safely("ungrounded event", () =>
      store.event(conv, "ungrounded_answer", "Answered without matching knowledge or a tool result.", { turn_index: turnIndex }),
    );
  }
}
