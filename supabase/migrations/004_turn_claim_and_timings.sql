-- Latency work (step 5): one database round-trip to start a turn instead of two,
-- and per-phase timings on every turn so we can see where the time goes.

alter table conversation_turns
  add column timings jsonb not null default '{}';  -- ms per phase: claim, retrieval, sdk_init, first_activity, first_text, tools, total

-- Creates the conversation if needed, then claims (conversation, turn_index).
-- Returns what an earlier attempt left if the turn already exists, so Vapi
-- retries replay instead of re-running (design §6).
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
  where conversation_id = p_conversation_id and turn_index = p_turn_index;

  return query select
    case existing.status when 'completed' then 'completed' when 'in_progress' then 'in_progress' else 'failed' end,
    existing.assistant_response,
    (extract(epoch from (now() - existing.updated_at)) * 1000)::bigint;
end;
$$;

-- Only the service role may call it (same rule as the tables: no anon or authenticated access).
revoke execute on function claim_turn(text, text, int, text) from public, anon, authenticated;
