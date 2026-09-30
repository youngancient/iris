// The trailing outcome tag (design §4.3): [[type:answer;confidence:high]].
// Held back from the stream so it's never spoken, then parsed for the turn log.

export type AnswerType = "answer" | "clarify" | "escalate" | "decline";
export type Outcome = { answerType: AnswerType | null; confidence: "high" | "low" | null };

const TAG = /\[\[\s*type\s*:\s*(answer|clarify|escalate|decline)\s*;\s*confidence\s*:\s*(high|low)\s*\]\]/i;

/** Passes text through, holding back everything from "[[" (or a trailing "[") onwards. */
export class TagStripper {
  private held = "";
  private tagText = "";

  push(text: string): string {
    if (this.tagText) {
      this.tagText += text;
      return "";
    }
    const combined = this.held + text;
    this.held = "";
    const start = combined.indexOf("[[");
    if (start >= 0) {
      this.tagText = combined.slice(start);
      return combined.slice(0, start);
    }
    if (combined.endsWith("[")) {
      this.held = "[";
      return combined.slice(0, -1);
    }
    return combined;
  }

  /** Remaining speakable text (a lone "[" that never became a tag). */
  flush(): string {
    const rest = this.held;
    this.held = "";
    return rest;
  }

  outcome(): Outcome {
    const m = TAG.exec(this.tagText);
    return m
      ? { answerType: m[1].toLowerCase() as AnswerType, confidence: m[2].toLowerCase() as "high" | "low" }
      : { answerType: null, confidence: null };
  }
}
