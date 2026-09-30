import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { supabase } from "../supabase.js";

export type ToolOutcome = {
  status: "success" | "not_found" | "error";
  data: Record<string, unknown>;
};

/**
 * Wraps a tool handler so every call writes a tool_calls row, and failures
 * come back as structured errors instead of crashing the server.
 */
export function withToolLogging<I extends { conversation_id?: string }>(
  toolName: string,
  purpose: string,
  handler: (input: I) => Promise<ToolOutcome>,
) {
  return async (input: I): Promise<CallToolResult> => {
    let outcome: ToolOutcome;
    let errorMessage: string | null = null;

    try {
      outcome = await handler(input);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      outcome = { status: "error", data: { error: "Tool failed. The failure has been logged." } };
    }

    const { error: logError } = await supabase.from("tool_calls").insert({
      conversation_id: input.conversation_id ?? null,
      tool_name: toolName,
      purpose,
      input_summary: input,
      result_summary: outcome.data,
      status: outcome.status,
      error_message: errorMessage,
    });
    if (logError) console.error(`[${toolName}] failed to log tool call:`, logError.message);

    return {
      content: [{ type: "text", text: JSON.stringify(outcome.data) }],
      structuredContent: outcome.data,
      isError: outcome.status === "error",
    };
  };
}
