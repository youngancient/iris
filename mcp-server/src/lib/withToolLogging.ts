import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import type { ToolCallInsert } from "../db/types.js";
import { maskDeep } from "./mask.js";

export type ToolOutcome =
  | { status: "success" | "not_found"; data: Record<string, unknown>; idempotencyKey?: string }
  /** Expected failure with a message for the agent (e.g. a missing field). */
  | { status: "invalid"; message: string };

type Options = {
  name: string;
  purpose: string;
  /** What the agent is told if the database or an unexpected error stops the tool. */
  failureMessage: string;
};

/**
 * Every tool call writes a tool_calls row (masked input and result, status,
 * duration). Failures come back through MCP's isError channel with a plain
 * message; the internal error is logged, never returned.
 */
export function withToolLogging<I extends Record<string, unknown>>(
  ctx: ToolContext,
  { name, purpose, failureMessage }: Options,
  handler: (input: I) => Promise<ToolOutcome>,
) {
  return async (input: I): Promise<CallToolResult> => {
    const started = Date.now();
    let outcome: ToolOutcome | null = null;
    let internalError: string | null = null;

    try {
      outcome = await handler(input);
    } catch (err) {
      internalError = err instanceof Error ? err.message : String(err);
    }

    const row: ToolCallInsert = {
      conversation_id: ctx.conversationId,
      turn_index: ctx.turnIndex,
      tool_name: name,
      purpose,
      input_summary: maskDeep(input),
      result_summary:
        outcome && outcome.status !== "invalid" ? maskDeep(outcome.data) : { error: outcome?.message ?? failureMessage },
      status: outcome && outcome.status !== "invalid" ? outcome.status : "error",
      error_message: internalError ?? (outcome?.status === "invalid" ? outcome.message : null),
      duration_ms: Date.now() - started,
      idempotency_key: outcome && outcome.status !== "invalid" ? (outcome.idempotencyKey ?? null) : null,
    };
    await logToolCall(ctx, row);

    if (!outcome) return errorResult(failureMessage);
    if (outcome.status === "invalid") return errorResult(outcome.message);
    return {
      content: [{ type: "text", text: JSON.stringify(outcome.data) }],
      structuredContent: outcome.data,
    };
  };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// One retry, then a structured stderr line (stdout is the MCP channel in stdio mode).
async function logToolCall(ctx: ToolContext, row: ToolCallInsert) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ctx.db.insertToolCall(row);
      return;
    } catch (err) {
      if (attempt === 1) {
        console.error(JSON.stringify({ level: "error", msg: "tool_calls insert failed", err: String(err), row }));
      }
    }
  }
}
