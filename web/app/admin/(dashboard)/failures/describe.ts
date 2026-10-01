// Each failure written as what happened and what it means (design §15).

export type Severity = "red" | "amber" | "grey";

export function describeFailure(kind: string, source: string): { text: string; severity: Severity } {
  switch (kind) {
    case "turn_failed":
      return { severity: "red", text: "Iris couldn't reply to a caller, who heard \"I'm having trouble right now\". Engineering should check the agent." };
    case "mcp_unavailable":
      return { severity: "red", text: "Iris couldn't reach customer records, so callers couldn't get account or payment details." };
    case "tool_error":
      return { severity: "amber", text: `A request to the support tools failed (${source.replace(/_/g, " ")}). The caller was told Iris couldn't do it right now.` };
    case "tool_error_seen":
      return { severity: "amber", text: "A lookup or action failed or took too long during a call. The caller was told Iris couldn't do it right now." };
    case "missed_followup":
      return { severity: "amber", text: "A record needed a specialist's follow-up, but no ticket was created on that call. Someone should follow up by hand." };
    case "ungrounded_answer":
      return { severity: "amber", text: "Iris answered without approved knowledge behind the answer. Worth reading the call to check what was said." };
    case "internal_text_blocked":
      return { severity: "grey", text: "Iris tried to repeat internal notes. The sentence was held back, so the caller didn't hear it." };
    case "guarantee_blocked":
      return { severity: "grey", text: "Iris tried to promise an outcome. The sentence was held back, so the caller didn't hear it." };
    case "conversation_id_mismatch":
      return { severity: "grey", text: "A tool call used the wrong call reference. It was corrected automatically." };
    default:
      return { severity: "grey", text: kind.replace(/_/g, " ") };
  }
}

export const SEVERITY_STYLE: Record<Severity, { dot: string; label: string }> = {
  red: { dot: "bg-danger", label: "Callers affected" },
  amber: { dot: "bg-[#b7791f]", label: "Needs a look" },
  grey: { dot: "bg-border", label: "For information" },
};
