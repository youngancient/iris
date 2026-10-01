-- Call-start token and per-call spending cap (design §8).

-- A token starts exactly one call: its nonce is claimed by that call and can't be reused.
alter table conversations
  add column call_token_nonce text unique,
  add column call_verified    boolean not null default false;

-- Tokens issued per visitor, for the per-IP rate limit. The IP is stored only as a keyed hash.
create table call_token_issues (
  id         bigserial primary key,
  ip_hash    text not null,
  created_at timestamptz not null default now()
);

create index call_token_issues_recent on call_token_issues (ip_hash, created_at desc);

alter table call_token_issues enable row level security;

-- Turns cost per conversation, read before each turn to enforce the cap.
create index conversation_turns_conversation on conversation_turns (conversation_id);
