import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

// Wraps the Agent SDK so the turn logic sees a small, testable event stream.

export type ModelEvent =
  | { type: "text"; text: string }
  /** Any sign the model is working (a token, thinking, a tool call starting). */
  | { type: "activity" }
  | { type: "tool_start"; tool: string }
  | { type: "tool_result"; tool: string; isError: boolean; text: string }
  | { type: "mcp_status"; server: string; status: string }
  | { type: "result"; isError: boolean; error: string | null; costUsd: number | null; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null };

export type ModelInput = {
  prompt: string;
  conversationId: string;
  turnIndex: number;
  abortController: AbortController;
  /** In-process search_knowledge_base, for follow-up or reworded searches. */
  searchKnowledge: (query: string) => Promise<string>;
};

export type ModelRunner = (input: ModelInput) => AsyncIterable<ModelEvent>;

export type ModelRunnerConfig = { model: string; mcpUrl: string; mcpToken: string };

const MAX_TURNS = 6;
// Hard ceiling per turn, well above a normal turn's cost; a runaway loop stops here.
const MAX_BUDGET_USD = 0.25;

const toolText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("");
  }
  return "";
};

export function createAgentSdkRunner(config: ModelRunnerConfig): ModelRunner {
  return async function* run(input) {
    const kb = createSdkMcpServer({
      name: "kb",
      version: "1.0.0",
      tools: [
        tool(
          "search_knowledge_base",
          "Search RelayPay's approved support knowledge. Use it when the knowledge provided for this turn doesn't cover the question, or the caller rephrased it.",
          { query: z.string() },
          async ({ query: q }) => ({ content: [{ type: "text", text: await input.searchKnowledge(q) }] }),
        ),
      ],
    });

    const toolNames = new Map<string, string>();

    const stream = query({
      prompt: input.prompt,
      options: {
        model: config.model,
        systemPrompt: SYSTEM_PROMPT,
        tools: [], // no built-in Claude Code tools (Bash, Read, …): our MCP tools only
        mcpServers: {
          relaypay: {
            type: "http",
            url: config.mcpUrl,
            // The conversation ID travels in a header the model can't change (design §5.1).
            headers: {
              authorization: `Bearer ${config.mcpToken}`,
              "x-conversation-id": input.conversationId,
              "x-turn-index": String(input.turnIndex),
            },
            // Above the MCP server's own 5s per-tool deadline, so the server always answers first.
            timeout: 10_000,
          },
          kb,
        },
        allowedTools: ["mcp__relaypay__*", "mcp__kb__search_knowledge_base"],
        permissionMode: "dontAsk",
        settingSources: [],
        persistSession: false,
        includePartialMessages: true,
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        // Short spoken replies: low effort keeps time-to-first-word down (design §4.1).
        thinking: { type: "adaptive" },
        effort: "low",
        abortController: input.abortController,
      },
    });

    // Aborting the controller alone doesn't reliably stop the CLI process: a tool can
    // still run after we've given up. close() terminates it (and its MCP transports).
    const kill = () => stream.close();
    if (input.abortController.signal.aborted) kill();
    input.abortController.signal.addEventListener("abort", kill, { once: true });

    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        for (const server of message.mcp_servers) yield { type: "mcp_status", server: server.name, status: server.status };
      } else if (message.type === "stream_event" && message.parent_tool_use_id === null) {
        const event = message.event;
        yield { type: "activity" };
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          yield { type: "tool_start", tool: event.content_block.name };
        }
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use") toolNames.set(block.id, block.name);
        }
      } else if (message.type === "user") {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              yield {
                type: "tool_result",
                tool: toolNames.get(block.tool_use_id) ?? "unknown",
                isError: Boolean(block.is_error),
                text: toolText(block.content),
              };
            }
          }
        }
      } else if (message.type === "result") {
        yield {
          type: "result",
          isError: message.is_error,
          error: message.subtype === "success" ? null : message.subtype,
          costUsd: message.total_cost_usd ?? null,
          inputTokens: message.usage?.input_tokens ?? null,
          outputTokens: message.usage?.output_tokens ?? null,
          cacheReadTokens: message.usage?.cache_read_input_tokens ?? null,
        };
      }
    }
  };
}
