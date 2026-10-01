-- Admin dashboard (design §15): staff workflow on tickets and escalations, an audit
-- trail of every staff action, the kill switch, and per-call Vapi cost.

-- Tickets and escalations: who changed what, and a note for the next person.
alter table support_tickets
  add column status_updated_at timestamptz,
  add column staff_note        text;

alter table escalations
  add column status_updated_at timestamptz,
  add column staff_note        text;

-- Vapi's end-of-call report: what the call cost Vapi-side, and how long it lasted.
alter table conversations
  add column vapi_cost_usd numeric(10, 4),
  add column duration_s    int;

-- Every staff action, written by the dashboard's server code only.
create table admin_actions (
  id           uuid primary key default gen_random_uuid(),
  admin_email  text not null,
  action       text not null,   -- ticket_status | escalation_status | kill_switch_on | kill_switch_off | reauth_failed | failure_acknowledged
  record_id    text,
  before_value text,
  after_value  text,
  reason       text,
  created_at   timestamptz not null default now()
);

create index admin_actions_recent on admin_actions (created_at desc);
create index admin_actions_reauth on admin_actions (admin_email, action, created_at);

-- Single-row settings. maintenance = the kill switch (design §15 operations item 1).
create table app_settings (
  id          boolean primary key default true check (id),  -- only one row can exist
  maintenance boolean not null default false,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

insert into app_settings (id) values (true) on conflict (id) do nothing;

-- Failures a staff member has acknowledged in the dashboard.
create table failure_acks (
  kind            text not null,
  conversation_id text not null default '',  -- '' when the failure has no conversation
  occurred_at     timestamptz not null,
  acked_by        text not null,
  acked_at        timestamptz not null default now(),
  primary key (kind, occurred_at, conversation_id)
);

-- Indexes the dashboard's queries rely on (design §15: every query is indexed and bounded).
create index conversations_started on conversations (started_at desc);
create index conversations_channel_started on conversations (channel, started_at desc);
create index conversation_turns_created on conversation_turns (created_at desc);
create index support_tickets_status_created on support_tickets (status, created_at desc);
create index escalations_status_created on escalations (status, created_at desc);

alter table admin_actions enable row level security;
alter table app_settings  enable row level security;
alter table failure_acks  enable row level security;

-- Dashboard aggregates (Costs and Performance pages). Summed in Postgres so the
-- dashboard never pulls every turn to add them up. traffic = real | eval | canary.

create view v_call_costs with (security_invoker = true) as
  select c.conversation_id, c.started_at, c.final_status,
         case when c.channel = 'web' then 'real' else c.channel end as traffic,
         coalesce(t.model_cost, 0)::numeric(12, 6)                                 as model_cost_usd,
         coalesce(c.vapi_cost_usd, 0)::numeric(12, 6)                              as vapi_cost_usd,
         (coalesce(t.model_cost, 0) + coalesce(c.vapi_cost_usd, 0))::numeric(12, 6) as total_cost_usd,
         coalesce(t.turns, 0) as turns,
         c.duration_s
  from conversations c
  left join (
    select conversation_id, sum(cost_usd) as model_cost, count(*) as turns
    from conversation_turns group by conversation_id
  ) t using (conversation_id);

create view v_turn_daily with (security_invoker = true) as
  select (t.created_at at time zone 'utc')::date as day,
         case when c.channel = 'web' then 'real' else c.channel end as traffic,
         count(*)                                                     as turns,
         count(*) filter (where t.model is null)                      as turns_without_model,
         percentile_cont(0.5)  within group (order by (t.timings->>'first_spoken')::numeric) as p50_first_spoken_ms,
         percentile_cont(0.95) within group (order by (t.timings->>'first_spoken')::numeric) as p95_first_spoken_ms,
         sum(t.input_tokens)       as input_tokens,
         sum(t.output_tokens)      as output_tokens,
         sum(t.cache_read_tokens)  as cache_read_tokens,
         count(*) filter (where t.status = 'failed') as failed_turns
  from conversation_turns t
  join conversations c using (conversation_id)
  group by 1, 2;

create view v_events_daily with (security_invoker = true) as
  select (e.created_at at time zone 'utc')::date as day,
         case when e.conversation_id like 'eval-%' then 'eval' else 'real' end as traffic,
         e.event_type, count(*) as events
  from conversation_events e
  group by 1, 2, 3;
