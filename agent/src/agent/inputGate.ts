import { SUPPORT_EMAIL_SPOKEN } from "./support.js";

// Input gate (design §2 step 3a): runs in code before any model or retrieval work.

export type GateClass = "unintelligible" | "small_talk" | "normal";

export const UNINTELLIGIBLE_REPLY = "Sorry, I didn't catch that. Could you say it again?";
export const UNINTELLIGIBLE_LIMIT_REPLY =
  `I'm having trouble hearing you. You can type your message in the box below the conversation, or email ${SUPPORT_EMAIL_SPOKEN}.`;
export const UNINTELLIGIBLE_LIMIT = 3;

const SMALL_TALK = new Set([
  "hi", "hello", "hey", "hiya", "good morning", "good afternoon", "good evening",
  "how are you", "how are you doing", "hows it going", "how is it going", "whats up",
  "thanks", "thank you", "thank you so much", "thanks a lot", "cheers",
  "ok", "okay", "alright", "cool", "great", "nice", "got it",
  "bye", "goodbye", "see you", "have a nice day",
]);

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const REFERENCE = /\b(txn|pay|cus|tkt|esc)[-\s]?\d+\b/i;

const normalize = (text: string) =>
  text.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9@.\s-]/g, " ").replace(/\s+/g, " ").trim();

/** A token that could plausibly be a spoken word, number, reference or email. */
function wordLike(token: string): boolean {
  if (/^\d+([.,]\d+)?$/.test(token)) return true;
  if (EMAIL.test(token) || REFERENCE.test(token)) return true;
  if (!/^[a-z][a-z'-]*$/.test(token) || token.length > 20) return false;
  if (token.length <= 2) return true;
  // Real words have a vowel (or y) and no long consonant runs.
  return /[aeiouy]/.test(token) && !/[bcdfghjklmnpqrstvwxz]{5,}/.test(token);
}

export function classifyInput(transcript: string): GateClass {
  const text = normalize(transcript);
  if (!text || !/[a-z0-9]/.test(text)) return "unintelligible";
  // Vapi transcripts are punctuated: "hi." and "jade," must count as words.
  const tokens = text.split(" ").map((t) => (EMAIL.test(t) ? t : t.replace(/^[.-]+|[.-]+$/g, ""))).filter(Boolean);
  if (tokens.length === 0) return "unintelligible";
  const wordish = tokens.filter(wordLike).length;
  if (wordish / tokens.length < 0.5) return "unintelligible";
  if (SMALL_TALK.has(text.replace(/[.-]/g, "").trim())) return "small_talk";
  return "normal";
}

const QUESTION_WORDS = /\b(what|why|how|when|where|which|who|can|could|do|does|is|are|will|should)\b/;
const YES_NO = /^(yes|yeah|yep|no|nope|correct|right|thats right|sure|please)\b/;

/**
 * Turns that only hand over data (an email, an ID, digits, a yes/no, a short answer)
 * don't need knowledge-base retrieval (design §2 step 3b).
 */
export function isDataOnly(transcript: string): boolean {
  const text = normalize(transcript);
  if (!text) return true;
  if (EMAIL.test(text) || REFERENCE.test(text)) return !QUESTION_WORDS.test(text) || text.split(" ").length <= 4;
  if (/^[\d\s.-]+$/.test(text)) return true;
  if (YES_NO.test(text) && text.split(" ").length <= 4) return true;
  return text.split(" ").length < 4 && !transcript.includes("?") && !QUESTION_WORDS.test(text);
}

/** Consecutive unintelligible turns so far, read from the history Vapi sends (stateless). */
export function priorUnintelligibleCount(assistantReplies: string[]): number {
  let count = 0;
  for (let i = assistantReplies.length - 1; i >= 0; i--) {
    if (assistantReplies[i] !== UNINTELLIGIBLE_REPLY) break;
    count++;
  }
  return count;
}
