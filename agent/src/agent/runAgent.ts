import { query } from "@anthropic-ai/claude-agent-sdk";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt } from "./systemPrompt.js";
import { logTurn, startConversation } from "../logging/conversations.js";

const mcpServerEntry = fileURLToPath(new URL("../../../mcp-server/src/index.ts", import.meta.url));

type ChatMessage = { role: string; content?: string | null };

/** Runs one support turn and yields the assistant's reply text as it arrives. */
export async function* runAgent({ conversationId, messages }: { conversationId: string; messages: ChatMessage[] }) {
  await startConversation(conversationId, "web");

  const history = messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.content);
  const latest = history.at(-1)?.content ?? "";
  const transcript = history
    .slice(0, -1)
    .map((m) => `${m.role === "user" ? "Customer" : "Iris"}: ${m.content}`)
    .join("\n");

  const prompt = transcript ? `Conversation so far:\n${transcript}\n\nCustomer: ${latest}` : latest;

  let reply = "";
  for await (const message of query({
    prompt,
    options: {
      model: "claude-sonnet-5-5",
      systemPrompt: buildSystemPrompt(conversationId),
      tools: [], // no built-in Claude Code tools (Bash, Read, …) — MCP tools only
      mcpServers: {
        relaypay: {
          type: "stdio",
          command: "npx",
          args: ["tsx", mcpServerEntry],
          env: {
            SUPABASE_URL: process.env.SUPABASE_URL!,
            SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
          },
        },
      },
      allowedTools: ["mcp__relaypay__*"],
      settingSources: [],
      maxTurns: 8,
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          reply += block.text;
          yield block.text;
        }
      }
    }
  }

  // TODO: have the agent report answer_type (e.g. via log_conversation_event) instead of null
  await logTurn({ conversationId, userTranscript: latest, assistantResponse: reply, answerType: null });
}
