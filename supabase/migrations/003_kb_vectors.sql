-- Knowledge base chunks for retrieval (Voyage embeddings at 512 dimensions)

create extension if not exists vector;

create table kb_chunks (
  id             bigserial primary key,
  section        text not null,   -- e.g. "Frequently Asked Questions"
  title          text not null,   -- e.g. "How Does RelayPay Charge Fees?"
  content        text not null,
  summary        text,            -- one-line description written at ingestion (PRD "source summary")
  content_hash   text unique,     -- re-ingestion only embeds new or changed chunks
  source_version text,
  embedding      vector(512) not null,
  fts            tsvector generated always as (to_tsvector('english', title || ' ' || content)) stored
);

create index kb_chunks_fts on kb_chunks using gin (fts);

alter table kb_chunks enable row level security;

create or replace function match_kb_chunks(query_embedding vector(512), match_count int default 4)
returns table (id bigint, section text, title text, content text, summary text, similarity float)
language sql stable
as $$
  select id, section, title, content, summary, 1 - (embedding <=> query_embedding) as similarity
  from kb_chunks
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- Fallback when the embedding provider is down (design §7.1).
create or replace function search_kb_chunks_fts(query text, match_count int default 4)
returns table (id bigint, section text, title text, content text, summary text, rank float)
language sql stable
as $$
  select id, section, title, content, summary,
         ts_rank(fts, websearch_to_tsquery('english', query))::float as rank
  from kb_chunks
  where fts @@ websearch_to_tsquery('english', query)
  order by rank desc
  limit match_count;
$$;
