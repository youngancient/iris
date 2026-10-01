-- When a newer attempt takes a turn over (migration 011), the outcome events the replaced
-- attempt already logged for that turn (declined, clarification, ungrounded) are removed,
-- so the timeline and #errors only reflect the reply the caller actually got. Events tied to
-- real records (tickets, escalations) are kept: those records exist either way.

create or replace function claim_turn(
  p_conversation_id text,
  p_channel         text,
  p_turn_index      int,
  p_transcript      text
)
returns table (state text, response text, age_ms bigint)
language plpgsql
as $$
declare
  existing conversation_turns%rowtype;
begin
  insert into conversations (conversation_id, channel, caller_id)
  values (p_conversation_id, p_channel, p_conversation_id)
  on conflict (conversation_id) do nothing;

  insert into conversation_turns (conversation_id, turn_index, user_transcript, status)
  values (p_conversation_id, p_turn_index, p_transcript, 'in_progress')
  on conflict (conversation_id, turn_index) do nothing;

  if found then
    return query select 'claimed'::text, null::text, 0::bigint;
    return;
  end if;

  select * into existing from conversation_turns
  where conversation_id = p_conversation_id and turn_index = p_turn_index
  for update;

  -- A different transcript is a new attempt at this turn, not a retry: take it over.
  if existing.user_transcript is distinct from p_transcript then
    update conversation_turns
    set user_transcript = p_transcript, status = 'in_progress', assistant_response = null,
        error_message = null, updated_at = now()
    where id = existing.id;
    -- The replaced attempt's outcome no longer stands: the new attempt logs its own.
    delete from conversation_events
    where conversation_id = p_conversation_id
      and event_type in ('declined', 'clarification_requested', 'ungrounded_answer')
      and metadata->>'turn_index' = p_turn_index::text;
    return query select 'claimed'::text, null::text, 0::bigint;
    return;
  end if;

  return query select
    case existing.status when 'completed' then 'completed' when 'in_progress' then 'in_progress' else 'failed' end,
    existing.assistant_response,
    (extract(epoch from (now() - existing.updated_at)) * 1000)::bigint;
end;
$$;

revoke execute on function claim_turn(text, text, int, text) from public, anon, authenticated;
