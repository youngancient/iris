# Iris: RelayPay voice support agent

Iris answers RelayPay customers by voice. She answers product and policy questions from the approved knowledge base, looks up customers, transactions and payouts through a custom MCP server, creates support tickets and escalations, and logs everything to Supabase for review.

**Live**

| What | URL |
| --- | --- |
| Call page (voice interface) | https://relaypayagent.vercel.app |
| Admin dashboard | https://relaypayagent.vercel.app/admin |
| MCP server (HTTP endpoint) | https://iris-production-2789.up.railway.app/mcp |

**Stack:** Vapi (voice), Claude Agent SDK with Claude Sonnet 5.5 (the agent), a custom MCP server (support tools), Supabase (seed data, logs, knowledge-base vectors), Voyage (embeddings), Next.js 16 on Vercel (web), Express 5 on Railway (agent and MCP server).

## How it works

```
Caller's browser ──voice──▶ Vapi ──(each turn)──▶ agent/  ──MCP over HTTP──▶ mcp-server/ ──▶ Supabase
  web/ call page              │  speech-to-text     Claude Agent SDK              6 support tools     seed data,
  (Next.js, Vercel)           │  text-to-speech     + knowledge-base search        + notifications     tickets, logs
                              └──end-of-call report──▶ agent/                       ├─▶ Discord (#errors, #escalations, #tickets)
                                                                                    └─▶ Brevo (emails to the support team)
```

1. **The call page** (`web/`) checks the caller's microphone, gets a signed, single-use call token from `/api/call-token` (it carries the signed-in customer, if any), and starts a Vapi web call.
2. **Vapi** turns speech into text and calls the agent's OpenAI-compatible `/chat/completions` endpoint on every turn, then speaks the streamed reply.
3. **The agent** (`agent/`) checks the call token, runs the turn through the Claude Agent SDK with the relevant knowledge-base sections already retrieved, and streams sentences back. A speech guard stops internal notes from being spoken, and each reply carries an outcome tag (answer, clarify, escalate, decline, social) that the code logs.
4. **The MCP server** (`mcp-server/`) serves the six support tools to the agent, enforces who may see what, writes every tool call to Supabase, and sends notifications.
5. **After the call**, Vapi's end-of-call report gives the agent the cost, duration and summary, and the call's final status is recorded.

**Identity.** Accounts, transactions and payouts are only shared with a caller who signed in on the call page (Supabase Auth); the sign-in travels inside the call token. A caller who isn't signed in gets general answers only: every lookup comes back as not found, so references and company names can't be guessed. Nothing a caller *says* (a company name, an email) unlocks anything, and a signed-in caller can't see another customer's records: to them, someone else's reference looks the same as one that doesn't exist.

## Repository

| Folder | What |
| --- | --- |
| `web/` | Next.js 16: the call page, customer sign-in, the admin dashboard, and `/api/call-token` |
| `agent/` | Express 5: the Vapi custom-LLM endpoint, the Claude Agent SDK turn loop, retrieval, evals and scripts |
| `mcp-server/` | Express 5: the MCP server (HTTP and stdio), its tools, and the notifier |
| `supabase/` | SQL migrations (`migrations/001` to `014`) and seed data (`seed.sql`) |
| `vapi/assistant.json` | The Vapi assistant config, pushed with `npm run vapi:sync` |

## MCP server

### Tools

These follow the tool spec exactly (names, inputs and outputs). Errors come back through MCP's `isError`, and empty values are `""`, never `null`. The three lookups only return records owned by the caller the call is signed in as; anything else is `found: false`.

| Tool | Does |
| --- | --- |
| `lookup_customer` | The signed-in customer's account, found by ID, email or company name. |
| `lookup_transaction` | Status, amount and estimated arrival for one of the signed-in customer's `TXN-…` references. |
| `lookup_payout` | Status of one of the signed-in customer's `PAY-…` payouts. |
| `create_support_ticket` | Logs an issue for follow-up. Calling it again for the same issue returns the same ticket. |
| `create_escalation` | Hands the caller to a specialist, with contact details and a callback time. One open escalation per call and category. |
| `log_conversation_event` | Records a notable decision (for example `caller_frustrated`). |

Every call is logged to `tool_calls` with a masked input and result summary, status, error and duration. Each tool answers within 5 seconds.

### Connect to the deployed server

The HTTP endpoint needs the server's bearer token (`MCP_TOKEN`). To use it from Claude Code:

```bash
claude mcp add --transport http relaypay https://iris-production-2789.up.railway.app/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

Any MCP client that supports Streamable HTTP works the same way: `POST /mcp` with an `Authorization: Bearer <MCP_TOKEN>` header. The agent also sends `X-Conversation-Id` and `X-Turn-Index`, which tie each tool call to a call and turn; without them, tool calls are logged without a conversation.

The HTTP endpoint is how calls reach the tools, so it protects customers: a direct request isn't a signed-in call, so it behaves like a caller who isn't signed in. Ticket and escalation tools work, but every lookup returns `found: false`. To see records, use stdio (below).

### Run it locally over stdio

For Claude Desktop or Claude Code on your own machine. stdio mode needs only the Supabase values, and sends no notifications. It's an operator tool, not a caller: it can only run where the database key already is, so its lookups see every record.

```bash
cd mcp-server && npm install && npm run build
```

Claude Code:

```bash
claude mcp add relaypay --env SUPABASE_URL=<url> --env SUPABASE_SERVICE_ROLE_KEY=<key> \
  -- node /absolute/path/to/iris/mcp-server/dist/index.js --stdio
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "relaypay": {
      "command": "node",
      "args": ["/absolute/path/to/iris/mcp-server/dist/index.js", "--stdio"],
      "env": { "SUPABASE_URL": "<url>", "SUPABASE_SERVICE_ROLE_KEY": "<key>" }
    }
  }
}
```

## Local setup

Requires Node 22 or later, a Supabase project, and accounts for Anthropic, Voyage and Vapi (plus Discord and Brevo if you turn notifications on).

1. **Install:** `npm install` in `agent/`, `mcp-server/` and `web/`.
2. **Environment:** `cp .env.example .env` (used by the agent and the MCP server) and `cp web/.env.example web/.env.local`. Each file documents its values. Shared secrets must match: `MCP_TOKEN` (agent and MCP server) and `CALL_TOKEN_SECRET` (agent and web). Generate secrets with `openssl rand -hex 32`.
3. **Database:** in the Supabase SQL editor, run `supabase/migrations/001` to `014` in order, then `supabase/seed.sql` (safe to re-run).
4. **Knowledge base:** `cd agent && npm run ingest-kb` chunks and embeds the knowledge base into `kb_chunks`.
5. **Logins** (Supabase dashboard → Authentication → Users): create the users, then give each one a role:
   ```sql
   insert into app_users (user_id, role) values ('<staff-user-id>', 'staff');
   insert into app_users (user_id, role, customer_id) values ('<customer-user-id>', 'customer', 'CUS-1006');
   ```
6. **Run:** `cd mcp-server && npm run dev` (port 8788), `cd agent && npm run dev` (port 8787), `cd web && npm run dev` (port 3000).
7. **Expose the agent to Vapi:** Vapi must reach it over https, for example with `ngrok http 8787`. Set `AGENT_URL` in `.env` to that URL, plus `VAPI_PRIVATE_KEY`, then run `cd agent && npm run vapi:sync`. The first sync prints the assistant ID: put it in `.env` as `VAPI_ASSISTANT_ID` and in `web/.env.local` as `NEXT_PUBLIC_VAPI_ASSISTANT_ID`.

## Deployment

| Service | Host | Settings |
| --- | --- | --- |
| `web/` | Vercel | Root directory `web`, Next.js preset. Env vars from `web/.env.example`. |
| `mcp-server/` | Railway | Root directory `/mcp-server`, build `npm run build`, start `npm start`, health check `/health`. Env vars: the Supabase, MCP and notification sections of `.env.example`. Don't set `PORT` or `MCP_PORT`. |
| `agent/` | Railway | Root directory `/agent`, build `npm run build`, start `npm start`, health check `/health`. Env vars: Supabase, Anthropic, Voyage, `VAPI_SECRET`, `CALL_TOKEN_SECRET`, `MCP_TOKEN`, and `MCP_URL=https://<mcp-domain>/mcp`. |

Deploy in this order: web (its URL is `DASHBOARD_URL`), then the MCP server (its URL is `MCP_URL`), then the agent. Finally set `AGENT_URL` to the agent's URL in your local `.env` and run `npm run vapi:sync` to point the Vapi assistant at it. `VAPI_PRIVATE_KEY` stays on your machine; it's never deployed.

## Testing

- **Unit and integration tests:** `npm test` in `agent/` and `mcp-server/`.
- **Evals:** `cd agent && npm run evals` runs scripted conversations through the real agent and tools, checks each one in code, grades it with a judge model, and stores the results in the `evaluations` table. They cover the PRD's test cases plus safety cases (prompt injection, guarantees, the identity lock, lookup limits). Eval calls are tagged `eval-…` and never send notifications.
- **Testing evidence:** `cd agent && npm run evidence` writes the latest run to `docs/testing-evidence.md`. The admin dashboard's Quality page also exports it as CSV.

## Operations

- **Admin dashboard** (staff login): the queue of escalations and tickets, conversation timelines, failures, quality checks, costs, performance, and settings.
- **Kill switch** (Settings, password re-check): stops Iris. Calls in progress hear "Support is temporarily unavailable" and end; the call page shows Iris as unavailable.
- **Notifications** (`NOTIFY=true`): Discord `#escalations` and `#tickets`, plus an email to `SUPPORT_TEAM_EMAIL`, for every escalation and ticket; Discord `#errors` for failures, kill-switch changes, and database outages. Delivery is tracked in the database, so an outage means a retry, never a lost or duplicated message.
- **Limits:** 5 call starts per visitor per hour, a model spending cap per call, and a 10-minute maximum call length.
