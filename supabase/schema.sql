-- Engineering Brain MVP — Supabase schema
-- Run this in the Supabase SQL editor before first use (see README.md).

-- pgvector extension
create extension if not exists vector;

-- Main table storing indexed PRs and commits with their embeddings.
create table if not exists indexed_items (
  id          uuid primary key default gen_random_uuid(),
  repo_url    text not null,
  type        text not null check (type in ('pr', 'commit')),
  source_url  text not null,
  title       text,
  body        text,
  author      text,
  created_at  timestamptz,
  embedding   vector(1536),
  indexed_at  timestamptz default now(),
  unique (source_url)
);

-- This CLI is single-user with no auth layer (by design, per spec) and
-- authenticates to Supabase with the anon key. Supabase projects enable RLS
-- by default on new tables, which blocks anon inserts with no policy — so we
-- explicitly disable it here rather than adding an auth layer this MVP
-- doesn't need.
alter table indexed_items disable row level security;

-- Speeds up brain status / repo-scoped lookups.
create index if not exists indexed_items_repo_url_idx on indexed_items (repo_url);

-- Vector similarity index (cosine distance).
create index if not exists indexed_items_embedding_idx
  on indexed_items
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Similarity search RPC used by `brain ask`.
create or replace function match_items(
  query_embedding vector(1536),
  repo text,
  match_count int default 5
)
returns table (id uuid, type text, source_url text, title text, body text, similarity float)
language sql as $$
  select id, type, source_url, title, body,
    1 - (embedding <=> query_embedding) as similarity
  from indexed_items
  where repo_url = repo
  order by embedding <=> query_embedding
  limit match_count;
$$;
