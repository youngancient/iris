-- Greetings, thanks and goodbyes get their own outcome type, so they're never
-- counted as answers that need knowledge or a tool result behind them.

alter table conversation_turns drop constraint if exists conversation_turns_answer_type_check;
alter table conversation_turns
  add constraint conversation_turns_answer_type_check
  check (answer_type in ('answer', 'clarify', 'escalate', 'decline', 'social'));
