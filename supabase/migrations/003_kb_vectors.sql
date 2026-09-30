-- Knowledge base chunks for retrieval (voyage-3-lite = 512 dims)

create extension if not exists vector;

create table kb_chunks (
  id         bigserial primary key,
  section    text not null,   -- e.g. "Frequently Asked Questions"
  title      text not null,   -- e.g. "How Does RelayPay Charge Fees?"
  content    text not null,
  embedding  vector(512) not null
);

alter table kb_chunks enable row level security;

create or replace function match_kb_chunks(query_embedding vector(512), match_count int default 4)
returns table (id bigint, section text, title text, content text, similarity float)
language sql stable
as $$
  select id, section, title, content, 1 - (embedding <=> query_embedding) as similarity
  from kb_chunks
  order by embedding <=> query_embedding
  limit match_count;
$$;
