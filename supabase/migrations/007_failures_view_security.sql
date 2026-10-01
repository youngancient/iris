-- Security signals from the identity limits (design §5.2) show up in v_failures.

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
                       'lookup_rate_limited')
    and created_at > now() - interval '24 hours';
