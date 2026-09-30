-- Records the system creates while it runs

create table conversations (
  conversation_id        text primary key,            -- Vapi call id
  channel                text not null default 'web', -- web | eval | canary
  caller_id              text,
  started_at             timestamptz not null default now(),
  ended_at               timestamptz,
  final_status           text,                        -- resolved | escalated | ticketed | abandoned
  summary                text,
  -- Server-side identity for the call (design §5.2). Never exposed through a tool.
  identified_customer_id text references customers (customer_id)
);

-- One row per (conversation, turn_index), so a Vapi retry replays instead of re-running (design §6).
create table conversation_turns (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    text not null references conversations (conversation_id),
  turn_index         int not null,
  status             text not null default 'in_progress'
                     check (status in ('in_progress', 'completed', 'failed')),
  user_transcript    text,
  assistant_response text,
  answer_type        text check (answer_type in ('answer', 'clarify', 'escalate', 'decline')),
  confidence_note    text,
  error_message      text,
  retrieval_used     boolean not null default false,
  latency_ms         int,
  cost_usd           numeric(10, 6),
  model              text,
  prompt_version     text,
  input_tokens       int,
  output_tokens      int,
  cache_read_tokens  int,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (conversation_id, turn_index)
);

create table retrieval_logs (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  text references conversations (conversation_id),
  turn_index       int,
  query            text not null,
  chunk_ids        bigint[],
  source_titles    text[],
  source_summary   text,
  top_similarity   float,
  matched          boolean not null default false,
  method           text not null default 'vector' check (method in ('vector', 'fts_fallback')),
  created_at       timestamptz not null default now()
);

create table tool_calls (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  text,
  turn_index       int,
  tool_name        text not null,
  purpose          text,
  input_summary    jsonb,
  result_summary   jsonb,
  status           text not null check (status in ('success', 'not_found', 'error')),
  error_message    text,
  duration_ms      int,
  idempotency_key  text,
  created_at       timestamptz not null default now()
);

create index tool_calls_conversation on tool_calls (conversation_id, created_at);

-- idempotency_key: a retried create returns the existing record.
create table support_tickets (
  ticket_id        text primary key default 'TKT-' || upper(substr(md5(random()::text), 1, 8)),
  conversation_id  text,
  customer_id      text references customers (customer_id),
  transaction_id   text references transactions (transaction_id),
  category         text not null,
  priority         text not null check (priority in ('low', 'medium', 'high', 'urgent')),
  summary          text not null,
  status           text not null default 'open' check (status in ('open', 'in progress', 'closed')),
  idempotency_key  text unique,
  created_at       timestamptz not null default now()
);

create table escalations (
  escalation_id    text primary key default 'ESC-' || upper(substr(md5(random()::text), 1, 8)),
  conversation_id  text,
  ticket_id        text references support_tickets (ticket_id),
  customer_id      text references customers (customer_id),
  user_name        text,
  user_email       text,
  category         text not null check (category in ('compliance', 'account', 'dispute', 'payment', 'other')),
  reason           text not null,
  call_booked      boolean not null default false,
  preferred_time   text,
  status           text not null default 'open' check (status in ('open', 'in progress', 'closed')),
  idempotency_key  text unique,
  created_at       timestamptz not null default now()
);

-- One open escalation per issue per call, however many times the agent tries.
create unique index escalations_one_open_per_category
  on escalations (conversation_id, category)
  where status <> 'closed';

create table conversation_events (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  text,
  event_type       text not null,
  summary          text,
  metadata         jsonb not null default '{}',
  created_at       timestamptz not null default now()
);

create index conversation_events_conversation on conversation_events (conversation_id, created_at);

create table evaluations (
  id                 uuid primary key default gen_random_uuid(),
  run_id             text not null,
  scenario_id        text,
  scenario           text not null,
  conversation_id    text,
  expected_behavior  text not null,
  actual_behavior    text,
  passed             boolean,
  checks             jsonb not null default '{}',  -- per-check pass/fail
  judge_model        text,
  notes              text,
  created_at         timestamptz not null default now()
);

create index evaluations_run on evaluations (run_id, scenario_id);

-- Server-only access: RLS on with no policies blocks anon/authenticated keys.
-- The backend and MCP server use the service role key, which bypasses RLS.
alter table customers           enable row level security;
alter table transactions        enable row level security;
alter table payouts             enable row level security;
alter table conversations       enable row level security;
alter table conversation_turns  enable row level security;
alter table retrieval_logs      enable row level security;
alter table tool_calls          enable row level security;
alter table support_tickets     enable row level security;
alter table escalations         enable row level security;
alter table conversation_events enable row level security;
alter table evaluations         enable row level security;

-- Review views ---------------------------------------------------------------
-- security_invoker: views run with the caller's permissions, so RLS still applies.

-- "What happened on call X?": every record for a conversation in time order.
create view v_conversation_timeline with (security_invoker = true) as
  select conversation_id, created_at, 'turn' as kind,
         jsonb_build_object(
           'turn_index', turn_index, 'status', status,
           'user', user_transcript, 'assistant', assistant_response,
           'answer_type', answer_type, 'confidence', confidence_note) as detail
  from conversation_turns
  union all
  select conversation_id, created_at, 'retrieval',
         jsonb_build_object(
           'query', query, 'sources', source_titles, 'top_similarity', top_similarity,
           'matched', matched, 'method', method)
  from retrieval_logs
  union all
  select conversation_id, created_at, 'tool_call',
         jsonb_build_object(
           'tool', tool_name, 'status', status, 'input', input_summary,
           'result', result_summary, 'error', error_message, 'duration_ms', duration_ms)
  from tool_calls
  union all
  select conversation_id, created_at, 'event',
         jsonb_build_object('type', event_type, 'summary', summary, 'metadata', metadata)
  from conversation_events;

-- Everything that went wrong in the last 24h.
create view v_failures with (security_invoker = true) as
  select created_at, 'tool_error' as kind, conversation_id,
         tool_name as source, error_message as detail
  from tool_calls
  where status = 'error' and created_at > now() - interval '24 hours'
  union all
  select created_at, 'turn_failed', conversation_id,
         'agent', error_message
  from conversation_turns
  where status = 'failed' and created_at > now() - interval '24 hours'
  union all
  select created_at, event_type, conversation_id,
         'event', summary
  from conversation_events
  where event_type in ('missed_followup', 'internal_text_blocked', 'guarantee_blocked',
                       'mcp_unavailable', 'ungrounded_answer', 'conversation_id_mismatch')
    and created_at > now() - interval '24 hours';

-- The PRD testing evidence table, for the latest eval run.
create view v_testing_evidence with (security_invoker = true) as
  select scenario as test_scenario, expected_behavior, actual_behavior,
         case when passed then 'pass' when passed is false then 'fail' end as result,
         notes, run_id, created_at
  from evaluations
  where run_id = (select run_id from evaluations order by created_at desc limit 1)
  order by scenario_id;
