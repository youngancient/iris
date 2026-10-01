import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import type { ToolCallInsert } from "../db/types.js";
import { maskDeep } from "./mask.js";
import { log } from "../logger.js";

export type ToolOutcome =
  | { status: "success" | "not_found"; data: Record<string, unknown>; idempotencyKey?: string }
  /** Expected failure with a message for the agent (e.g. a missing field). */
  | { status: "invalid"; message: string };

type Options = {
  name: string;
  purpose: string;
  /** What the agent is told if the database or an unexpected error stops the tool. */
  failureMessage: string;
  /** Create tools are idempotent, so after a timeout the agent can safely call again. */
  retrySafe?: boolean;
};

// Every tool answers within this, well inside the agent SDK's own MCP timeout (10s),
// so the agent always gets our definite result rather than the SDK giving up first.
export const TOOL_DEADLINE_MS = 5000;

class DeadlineExceeded extends Error {}

/**
 * Every tool call writes a tool_calls row (masked input and result, status,
 * duration). Failures come back through MCP's isError channel with a plain
 * message; the internal error is logged, never returned.
 */
export function withToolLogging<I extends Record<string, unknown>>(
  ctx: ToolContext,
  { name, purpose, failureMessage, retrySafe = false }: Options,
  handler: (input: I) => Promise<ToolOutcome>,
) {
  return async (input: I): Promise<CallToolResult> => {
    const started = Date.now();
    let outcome: ToolOutcome | null = null;
    let internalError: string | null = null;

    const buildRow = (o: ToolOutcome | null, errorText: string | null, note?: string): ToolCallInsert => ({
      conversation_id: ctx.conversationId,
      turn_index: ctx.turnIndex,
      tool_name: name,
      purpose,
      input_summary: maskDeep(input),
      result_summary: o && o.status !== "invalid" ? maskDeep(o.data) : { error: o?.message ?? failureMessage },
      status: o && o.status !== "invalid" ? o.status : "error",
      error_message: [errorText ?? (o?.status === "invalid" ? o.message : null), note].filter(Boolean).join("; ") || null,
      duration_ms: Date.now() - started,
      idempotency_key: o && o.status !== "invalid" ? (o.idempotencyKey ?? null) : null,
    });

    const work = handler(input);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineExceeded()), ctx.deadlineMs ?? TOOL_DEADLINE_MS);
    });
    try {
      outcome = await Promise.race([work, deadline]);
    } catch (err) {
      if (err instanceof DeadlineExceeded) {
        log.warn({ tool: name, conversation_id: ctx.conversationId, turn_index: ctx.turnIndex, deadline_ms: ctx.deadlineMs ?? TOOL_DEADLINE_MS }, "tool missed its deadline");
        // The work carries on in the background; log what it really did once it finishes.
        void work
          .then((late) => logToolCall(ctx, buildRow(late, null, `finished after the ${ctx.deadlineMs ?? TOOL_DEADLINE_MS}ms deadline`)))
          .catch((lateErr) => logToolCall(ctx, buildRow(null, String(lateErr), "failed after the deadline")));
        return errorResult(
          retrySafe
            ? `${failureMessage} Instruction for the agent, not for the caller: the tool timed out, so the record may or may not exist. Calling this tool again with the same details is harmless, because it returns the existing record instead of a duplicate.`
            : failureMessage,
        );
      }
      internalError = err instanceof Error ? err.message : String(err);
      log.error({ tool: name, conversation_id: ctx.conversationId, turn_index: ctx.turnIndex, err }, "tool failed");
    } finally {
      clearTimeout(timer);
    }

    const row = buildRow(outcome, internalError);
    // Written after replying, so logging never adds a round-trip to the tool call.
    void logToolCall(ctx, row);

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
        log.error({ err, row }, "tool_calls insert failed");
        ctx.onRecordFailed?.(row.tool_name, err);
      }
    }
  }
}
