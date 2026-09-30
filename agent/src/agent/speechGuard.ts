// Sentence-level speech guard (design §4.5). Every sentence is checked in code
// before it reaches Vapi, so internal text and promises can't be spoken even if
// the model ignores its instructions.

export const GUARD_FALLBACK = "Let me connect you with a specialist who can help with this.";

export type BlockReason = { kind: "internal_text"; field: string; tool: string } | { kind: "guarantee" };

export type InternalText = { tool: string; field: string; text: string };

const FILLER = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "to", "of", "and", "or", "in", "on", "for",
  "with", "your", "you", "our", "we", "i", "it", "this", "that", "has", "have", "can", "will", "at", "by",
  "as", "from", "so", "just", "please", "any", "all",
]);

const contentWords = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w && !FILLER.has(w));

// Wording that only makes sense for staff. "I'll escalate this to a specialist" is fine.
const STAFF_PHRASES = [
  /\bescalate account[- ]specific\b/i,
  /\binternal (note|notes|guidance|flag|review)\b/i,
  /\bflagged (for|as)\b/i,
  /\brisk (review|score|flag|profile)\b/i,
  /\bsupport notes?\b/i,
];

// Staff instructions inside a customer-facing summary ("Escalate account-specific questions.").
const INSTRUCTION = /\b(escalate|do not|don't|internal|flag|route to)\b/i;

const NEGATED_PROMISE = /\b(not|n't|cannot|no|never)\b(\s+\w+){0,3}\s+(guarantee|promise)/i;
const PROMISES = [
  /\b(i|we)\s+(can\s+|will\s+)?(guarantee|promise)\b/i,
  /\bit'?s\s+guaranteed\b|\bis\s+guaranteed\b|\bguaranteed\s+to\b/i,
  /\bwill\s+definitely\b|\bdefinitely\s+will\b/i,
  /\bwill\s+(arrive|land|clear|be\s+(there|done|completed|processed|resolved))\s+by\b/i,
];

/**
 * Which parts of this turn's tool output count as internal. support_notes is
 * internal in full. For support_summary only its staff-instruction sentences are:
 * the status part may be paraphrased to the caller (design §5.4).
 */
export function internalSegments(items: InternalText[]): InternalText[] {
  const out: InternalText[] = [];
  for (const item of items) {
    if (!item.text.trim()) continue;
    const sentences = item.text.match(/[^.!?]+[.!?]*/g) ?? [item.text];
    for (const s of sentences) {
      if (item.field === "support_notes" || INSTRUCTION.test(s)) out.push({ ...item, text: s.trim() });
    }
  }
  return out;
}

export function checkSentence(sentence: string, internal: InternalText[]): BlockReason | null {
  if (PROMISES.some((p) => p.test(sentence)) && !NEGATED_PROMISE.test(sentence)) return { kind: "guarantee" };

  if (STAFF_PHRASES.some((p) => p.test(sentence))) {
    const source = internal[0];
    return { kind: "internal_text", field: source?.field ?? "staff_phrase", tool: source?.tool ?? "none" };
  }

  const words = new Set(contentWords(sentence));
  if (words.size < 2) return null;
  for (const segment of internal) {
    const segmentWords = new Set(contentWords(segment.text));
    if (segmentWords.size === 0) continue;
    const shared = [...segmentWords].filter((w) => words.has(w)).length;
    // Share of the internal text that reappears in the sentence.
    if (shared / segmentWords.size >= 0.6 && shared >= 2) {
      return { kind: "internal_text", field: segment.field, tool: segment.tool };
    }
  }
  return null;
}

/**
 * Splits streamed text into sentences. A sentence ends at . ! or ? followed by
 * whitespace, so "TXN-9001." mid-stream and "2.5" aren't cut early.
 */
export class SentenceSplitter {
  private buffer = "";

  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    const re = /[.!?]+["')\]]*\s+/g;
    let last = 0;
    for (let m = re.exec(this.buffer); m; m = re.exec(this.buffer)) {
      out.push(this.buffer.slice(last, m.index + m[0].length).trim());
      last = m.index + m[0].length;
    }
    this.buffer = this.buffer.slice(last);
    return out.filter(Boolean);
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }
}
