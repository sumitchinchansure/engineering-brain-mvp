-- Engineering Brain — knowledge graph & decisions migration.
-- Additive to supabase/schema.sql. Safe to re-run. Run in the Supabase SQL editor.

create extension if not exists vector;

-- Extraction bookkeeping on existing items: extract processes only 'pending' rows.
alter table indexed_items
  add column if not exists extraction_status text not null default 'pending'
  check (extraction_status in ('pending', 'classified', 'extracted', 'skipped', 'failed'));

create index if not exists indexed_items_extraction_status_idx
  on indexed_items (repo_url, extraction_status);

create table if not exists entities (
  id              uuid primary key default gen_random_uuid(),
  repo_url        text not null,
  kind            text not null check (kind in ('person', 'service', 'component', 'technology', 'feature')),
  name            text not null,
  canonical_name  text not null,
  description     text,
  first_seen      timestamptz,
  last_seen       timestamptz,
  unique (repo_url, kind, canonical_name)
);
alter table entities disable row level security;
create index if not exists entities_repo_url_idx on entities (repo_url);

create table if not exists edges (
  id                 uuid primary key default gen_random_uuid(),
  repo_url           text not null,
  source_id          uuid not null references entities(id) on delete cascade,
  target_id          uuid not null references entities(id) on delete cascade,
  relation           text not null check (relation in ('works_on', 'part_of', 'uses', 'introduced', 'modified', 'decided_by', 'affects')),
  evidence_item_ids  uuid[] not null default '{}',
  weight             int not null default 1,
  unique (repo_url, source_id, target_id, relation)
);
alter table edges disable row level security;
create index if not exists edges_repo_url_idx on edges (repo_url);

create table if not exists decisions (
  id                 uuid primary key default gen_random_uuid(),
  repo_url           text not null,
  title              text not null,
  decision           text not null,
  reasoning          text,
  alternatives       jsonb not null default '[]',
  author             text,
  decided_at         timestamptz,
  confidence         float,
  evidence_item_ids  uuid[] not null default '{}',
  embedding          vector(1536),
  created_at         timestamptz default now()
);
alter table decisions disable row level security;
create index if not exists decisions_repo_url_idx on decisions (repo_url);
create index if not exists decisions_embedding_idx
  on decisions using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Similarity search over decisions, mirroring match_items.
create or replace function match_decisions(
  query_embedding vector(1536),
  repo text,
  match_count int default 5
)
returns table (
  id uuid, title text, decision text, reasoning text,
  alternatives jsonb, author text, evidence_item_ids uuid[], similarity float
)
language sql as $$
  select id, title, decision, reasoning, alternatives, author, evidence_item_ids,
    1 - (embedding <=> query_embedding) as similarity
  from decisions
  where repo_url = repo and embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
