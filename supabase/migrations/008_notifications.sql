-- Notifications (design §7.2): Discord #errors and #escalations, and a Brevo email to
-- the support team per escalation. Delivery state lives here, so a crash or an outage
-- never loses a notification and a retry never sends one twice.

alter table escalations
  add column notified_at            timestamptz,          -- posted to #escalations
  add column notify_attempts        int not null default 0,
  add column emailed_at             timestamptz,          -- emailed to the support team
  add column email_attempts         int not null default 0,
  add column undelivered_alerted_at timestamptz;          -- #errors told it's stuck

create index escalations_undelivered on escalations (created_at)
  where notified_at is null or emailed_at is null;

-- Single row: how far the notifier has posted, so each failure / kill-switch change is posted once.
create table alert_cursor (
  id                   boolean primary key default true check (id),
  last_failure_at      timestamptz,
  last_admin_action_at timestamptz,
  updated_at           timestamptz not null default now()
);

insert into alert_cursor (id) values (true) on conflict (id) do nothing;

alter table alert_cursor enable row level security;

-- Stuck escalations are failures too.
create or replace view v_failures with (security_invoker = true) as
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
                       'mcp_unavailable', 'ungrounded_answer', 'conversation_id_mismatch',
                       'tool_error_seen', 'identity_attempts_exceeded', 'identity_switch_blocked',
                       'lookup_rate_limited', 'escalation_undelivered')
    and created_at > now() - interval '24 hours';
