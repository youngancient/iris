-- Records the system creates while it runs

create table conversations (
  conversation_id  text primary key,            -- Vapi call id
  channel          text not null default 'web', -- web | phone | eval
  caller_id        text,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  final_status     text,                        -- resolved | escalated | ticketed | abandoned
  summary          text
);

create table conversation_turns (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   text not null references conversations (conversation_id),
  user_transcript   text,
  assistant_response text,
  answer_type       text check (answer_type in ('answer', 'clarify', 'escalate', 'decline')),
  confidence_note   text,
  created_at        timestamptz not null default now()
);

create table retrieval_logs (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  text references conversations (conversation_id),
  query            text not null,
  chunk_ids        bigint[],
  source_titles    text[],
  source_summary   text,
  created_at       timestamptz not null default now()
);

create table tool_calls (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  text,
  tool_name        text not null,
  purpose          text,
  input_summary    jsonb,
  result_summary   jsonb,
  status           text not null check (status in ('success', 'not_found', 'error')),
  error_message    text,
  created_at       timestamptz not null default now()
);

create table support_tickets (
  ticket_id        text primary key default 'TKT-' || upper(substr(md5(random()::text), 1, 8)),
  conversation_id  text,
  customer_id      text references customers (customer_id),
  transaction_id   text references transactions (transaction_id),
  category         text not null,
  priority         text not null check (priority in ('low', 'medium', 'high', 'urgent')),
  summary          text not null,
  status           text not null default 'open' check (status in ('open', 'in progress', 'closed')),
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
  created_at       timestamptz not null default now()
);

create table conversation_events (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  text,
  event_type       text not null,
  summary          text,
  metadata         jsonb not null default '{}',
  created_at       timestamptz not null default now()
);

create table evaluations (
  id                 uuid primary key default gen_random_uuid(),
  run_id             text not null,
  scenario           text not null,
  conversation_id    text,
  expected_behavior  text not null,
  actual_behavior    text,
  passed             boolean,
  notes              text,
  created_at         timestamptz not null default now()
);

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
