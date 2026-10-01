-- Ticket notifications: each new ticket is posted to Discord #tickets and emailed to the
-- support team, with the same delivery tracking as escalations (migration 008), so a
-- crash or outage means a retry, never a loss or a duplicate.

alter table support_tickets
  add column notified_at            timestamptz,          -- posted to #tickets
  add column notify_attempts        int not null default 0,
  add column emailed_at             timestamptz,          -- emailed to the support team
  add column email_attempts         int not null default 0,
  add column undelivered_alerted_at timestamptz;          -- #errors told it's stuck

-- Tickets from before this migration count as delivered, so turning this on doesn't
-- post the whole backlog.
update support_tickets set notified_at = now(), emailed_at = now() where notified_at is null;

create index support_tickets_undelivered on support_tickets (created_at)
  where notified_at is null or emailed_at is null;

-- Stuck tickets are failures too (same view as 008, plus ticket_undelivered).
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
                       'lookup_rate_limited', 'escalation_undelivered', 'ticket_undelivered')
    and created_at > now() - interval '24 hours';
