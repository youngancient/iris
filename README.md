# iris

Voice customer support agent for RelayPay (Vapi + Claude Agent SDK + custom MCP server + Supabase).

| Folder | What |
| --- | --- |
| `web/` | Vite + React voice page (Vapi Web SDK) |
| `agent/` | Express 5 backend — Vapi Custom LLM endpoint → Claude Agent SDK |
| `mcp-server/` | RelayPay support tools (MCP, stdio) |
| `supabase/migrations/` | Tables for seed data, runtime logs, KB vectors |
| `docs/` | One-page "how it works" |

## Setup

1. `cp .env.example .env` and fill it in.
2. Run the SQL in `supabase/migrations/` in order (SQL editor or `supabase db push`).
3. `npm install` in `mcp-server/`, `agent/`, and `web/`.
4. `cd agent && npm run seed` — loads customers, transactions, payouts.
5. `cd agent && npm run ingest-kb` — embeds the knowledge base.
6. `cd agent && npm run dev` and `cd web && npm run dev`.
7. In Vapi, set the assistant's model to **Custom LLM** pointing at `<agent-url>/chat/completions`,
   the server URL to `<agent-url>/vapi/events`, and send `x-vapi-secret` on both.
