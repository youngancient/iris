import { describe, expect, it } from "vitest";
import { classifyInput, isDataOnly, priorUnintelligibleCount, UNINTELLIGIBLE_REPLY } from "../src/agent/inputGate.js";
import { TagStripper } from "../src/agent/outcomeTag.js";
import { checkSentence, internalSegments, SentenceSplitter } from "../src/agent/speechGuard.js";

describe("input gate", () => {
  it.each(["", "   ", "...", "?!", "xkcdqwrt zzzzbrr fhtgkl", "mmm hmm grrrrrzt pfft"])("%j is unintelligible", (t) => {
    expect(classifyInput(t)).toBe("unintelligible");
  });

  it.each(["Hi", "hello!", "How are you?", "thanks", "Thank you so much.", "okay", "bye"])("%j is small talk", (t) => {
    expect(classifyInput(t)).toBe("small_talk");
  });

  // Real questions, IDs, emails and short answers must never be treated as noise.
  it.each([
    "What fees does RelayPay charge?", "TXN-9001", "txn 9001", "amara@lagosledger.example", "yes", "no",
    "My payment is stuck.", "9001", "Can RelayPay guarantee my payout arrives by 9am tomorrow?", "OkoyeWorks",
    // Punctuated Vapi transcripts (first live call: this was misheard as noise).
    "Hi. I'm Jade.", "Hi. I'm Jade. Up?", "Yes. Okay. Fine.", "Jade, from Lagos.",
  ])("%j is normal", (t) => {
    expect(classifyInput(t)).toBe("normal");
  });

  it.each(["amara@lagosledger.example", "TXN-9001", "yes that's right", "4 7 1 9 2 3", "OkoyeWorks"])("%j is data-only (no retrieval)", (t) => {
    expect(isDataOnly(t)).toBe(true);
  });

  it.each(["My payment is stuck.", "What fees do you charge?", "how long does verification take", "Why is TXN-9001 delayed and what should I do?"])(
    "%j needs retrieval",
    (t) => {
      expect(isDataOnly(t)).toBe(false);
    },
  );

  it("counts consecutive unintelligible replies from the history", () => {
    expect(priorUnintelligibleCount(["Hello!", UNINTELLIGIBLE_REPLY, UNINTELLIGIBLE_REPLY])).toBe(2);
    expect(priorUnintelligibleCount([UNINTELLIGIBLE_REPLY, "Sure."])).toBe(0);
  });
});

describe("speech guard", () => {
  const internal = internalSegments([
    { tool: "lookup_customer", field: "support_notes", text: "Account is under compliance review. Escalate account-specific questions." },
    { tool: "lookup_transaction", field: "support_summary", text: "Transaction requires compliance review. Escalate account-specific questions." },
    { tool: "lookup_customer", field: "support_notes", text: "Customer often uses contractor payouts." },
  ]);

  it("only the instruction part of a support_summary counts as internal", () => {
    const fromSummary = internal.filter((s) => s.field === "support_summary").map((s) => s.text);
    expect(fromSummary).toEqual(["Escalate account-specific questions."]);
  });

  it.each([
    "Our notes say this account is under compliance review.",
    "I see you often use contractor payouts.",
    "Per the internal note, I can't discuss this.",
    "We need to escalate account-specific questions.",
    "Safe to retry.",
    "It's safe to call it again with the same details.",
  ])("blocks internal text: %j", (s) => {
    expect(checkSentence(s, internal)?.kind).toBe("internal_text");
  });

  it.each([
    "I guarantee it will arrive by 9am.",
    "It will definitely arrive tomorrow.",
    "Your payout will arrive by Friday.",
    "We promise it'll be sorted today.",
  ])("blocks promises: %j", (s) => {
    expect(checkSentence(s, [])?.kind).toBe("guarantee");
  });

  it.each([
    "RelayPay doesn't guarantee payment timelines.",
    "I can't guarantee that, but I can tell you what the record says.",
    "I'll escalate this to a specialist.",
    "This transaction needs a compliance review, so a specialist will follow up.",
    "Your payout is processing and is expected on August 19.",
    "Your account is active.",
  ])("lets safe sentences through: %j", (s) => {
    expect(checkSentence(s, internal)).toBeNull();
  });
});

describe("sentence splitter", () => {
  it("splits on sentence ends followed by space, across chunks", () => {
    const s = new SentenceSplitter();
    expect(s.push("Let me check that. Your pay")).toEqual(["Let me check that."]);
    expect(s.push("out TXN-9001 is processing. Fees are 2.5")).toEqual(["Your payout TXN-9001 is processing."]);
    expect(s.push(" percent? Yes")).toEqual(["Fees are 2.5 percent?"]);
    expect(s.flush()).toEqual(["Yes"]);
  });

  it("a newline between text blocks is a boundary", () => {
    const s = new SentenceSplitter();
    expect(s.push("Safe to retry.")).toEqual([]);
    expect(s.push("\nThank you, Efua. ")).toEqual(["Safe to retry.", "Thank you, Efua."]);
  });
});

describe("outcome tag", () => {
  it("strips the tag from the stream and parses it, even split across chunks", () => {
    const t = new TagStripper();
    const out = [t.push("Your payout is processing. ["), t.push("[type:ans"), t.push("wer;confidence:high]]"), t.flush()].join("");
    expect(out).toBe("Your payout is processing. ");
    expect(t.outcome()).toEqual({ answerType: "answer", confidence: "high" });
  });

  it("a missing tag gives nulls", () => {
    const t = new TagStripper();
    t.push("Hello.");
    expect(t.outcome()).toEqual({ answerType: null, confidence: null });
  });

  it("a lone [ that never becomes a tag is still spoken", () => {
    const t = new TagStripper();
    expect(t.push("See [") + t.push("note]") + t.flush()).toBe("See [note]");
  });
});
