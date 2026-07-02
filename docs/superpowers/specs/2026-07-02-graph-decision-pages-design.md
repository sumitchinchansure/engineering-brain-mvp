# Design: Knowledge Graph + Decision Pages + Local Dashboard

**Date:** 2026-07-02
**Status:** Approved
**Slice:** First sub-project of "deepen the engine" phase (local, single-tenant — no auth/hosting/multi-tenancy)

---

## Context

The current repo is a working proof-of-concept CLI (~770 lines): `brain ingest` pulls a GitHub repo's PRs + commits into Supabase/pgvector, `brain ask` answers "why" questions via RAG (GPT-4o-mini), `brain status` counts rows.

The Engineering Brain PRD describes a much larger platform. The agreed next milestone is **deepen the engine, stay local**: make the intelligence dramatically better before adding connectors, auth, or hosting. The first slice is **knowledge graph + decision pages over the GitHub data we already ingest**, surfaced through a local web dashboard that becomes the seed of the future product UI.

## Decisions made during brainstorming

| Decision | Choice | Why |
|---|---|---|
| Next milestone | Deepen the engine, stay local | Defer auth/multi-tenancy/hosting; invest in intelligence |
| First slice | Graph + Decision Pages on existing GitHub data | The PRD's differentiator ("connected understanding"); needs zero new connector plumbing |
| Graph store | Postgres/Supabase tables | No new infra; PRD explicitly allows "Neo4j OR PostgreSQL graph"; fine at local scale |
| LLM provider | Claude for reasoning/extraction; keep OpenAI `text-embedding-3-small` for embeddings | Claude (Fable 5 / Haiku 4.5) for quality reasoning; Anthropic has no embeddings API, so OpenAI stays for vectors only |
| Output surface | `brain serve` → local Next.js dashboard in `/web` | Real React app that becomes the actual product dashboard later; nothing thrown away |
| Extraction pipeline | Two-stage (classify → deep extract) + linking pass | Best quality/cost; cheap pass filters "fix typo" noise before expensive extraction |

## Architecture

```
indexed_items (existing, Supabase)
      │
      ▼
brain extract  ──► Stage 1: Classify (Claude Haiku 4.5, cheap, batched ~20 items/call)
      │             "decision-bearing? which entities mentioned?"
      ▼
              ──► Stage 2: Deep extract (Claude Fable 5, decision-bearing items only)
      │             decision, reasoning, alternatives, entities, relationships
      ▼
              ──► Stage 3: Link & dedup
                    merge duplicate entities, wire edges, attach evidence
      │
      ▼
entities / edges / decisions tables (Supabase)
      │
      ▼
brain serve ──► Next.js dashboard (/web)
                Overview · Graph view · Decisions · Ask
```

The CLI gains two commands: `brain extract` (run after `ingest`) and `brain serve`. Everything stays local and single-tenant.

## Data model (new Supabase tables)

**`entities`**
```
id              uuid primary key default gen_random_uuid()
repo_url        text not null
kind            text not null   -- person | service | component | technology | feature
name            text not null
canonical_name  text not null   -- normalized for dedup
description     text
first_seen      timestamptz
last_seen       timestamptz
unique (repo_url, kind, canonical_name)
```

**`edges`**
```
id                 uuid primary key default gen_random_uuid()
repo_url           text not null
source_id          uuid not null references entities(id)
target_id          uuid not null references entities(id)
relation           text not null  -- works_on | part_of | uses | introduced | modified | decided_by | affects
evidence_item_ids  uuid[]         -- references into indexed_items
weight             int default 1  -- incremented when re-observed
unique (repo_url, source_id, target_id, relation)
```

**`decisions`**
```
id                 uuid primary key default gen_random_uuid()
repo_url           text not null
title              text not null
decision           text not null      -- what was decided
reasoning          text               -- why
alternatives       jsonb              -- [{option, why_rejected}]
author             text
decided_at         timestamptz
confidence         float              -- extractor's own confidence 0-1
evidence_item_ids  uuid[] not null    -- references into indexed_items
embedding          vector(1536)       -- so ask can retrieve decisions directly
created_at         timestamptz default now()
```

**`indexed_items`** gains one column:
```
extraction_status  text default 'pending'  -- pending | classified | extracted | skipped | failed
```
This makes extraction incremental and resumable: re-running `brain extract` only processes `pending` items.

All new tables: RLS disabled (same reasoning as `indexed_items` — single anon-key local user, no auth layer in this slice). Schema shipped as an additive migration file that is safe to re-run (`IF NOT EXISTS` / `OR REPLACE`), plus a `match_decisions` RPC mirroring `match_items`.

## Extraction pipeline detail

**Stage 1 — classify (Claude Haiku 4.5):**
- Batch ~20 items per call. Output per item: `is_decision_bearing: boolean`, `entity_mentions: [{kind, name}]`.
- Trivial items ("fix typo", version bumps) → `extraction_status = skipped`.
- Non-trivial but non-decision items → `classified` (their entity mentions still feed the graph).

**Stage 2 — deep extract (Claude Fable 5):**
- Runs only on decision-bearing items, one at a time, with related items (same-PR commits, similar titles) included as context.
- Structured output: `{title, decision, reasoning, alternatives[], entities[], relationships[]}`.
- Item → `extracted`.

**Stage 3 — link & dedup:**
- Person entities seeded directly from the `author` field (no LLM needed).
- Entity dedup: exact + normalized name matching first; ambiguous candidate pairs resolved by one Claude call.
- Edges upserted with `weight` incremented on re-observation; evidence item ids appended (deduped).
- Decisions embedded (OpenAI `text-embedding-3-small`) and inserted.

**Robustness rules (same spirit as ingest):**
- All Claude calls request strict JSON; malformed responses retried once, then item marked `failed` and skipped — a bad item never aborts the run.
- Progress output during long runs (chalk, same style as ingest).
- Rate-limit / API errors at the run level → human-readable message, exit 1, resumable on next run.

**New env var:** `ANTHROPIC_API_KEY` (added to `.env.example` and env validation). OpenAI key remains for embeddings only.

## `ask` upgrade

- `brain ask` searches **both** `indexed_items` and `decisions` vectors (two RPC calls, merged by similarity).
- Answer generation moves from GPT-4o-mini to **Claude Fable 5**.
- When a decision matches, its full structured record (decision + reasoning + alternatives + evidence) goes into context — "why X?" gets answered from an extracted decision, not just raw PR text.
- Evidence/source links always shown; the existing "not enough context" fallback behavior (RELEVANCE_FLOOR + LLM judgment, per DECISIONS.md #4) is preserved.

## Web dashboard (`/web`, Next.js)

A Next.js + React + TypeScript app in `/web`, launched via `brain serve` (spawns the Next dev server on localhost; dev mode is acceptable for this slice). API routes read Supabase using the same env vars as the CLI. No auth — localhost only.

Pages:
- **Overview** — repo stats (indexed/extracted counts), recent decisions, top entities by edge weight
- **Graph** — interactive force-directed graph (react-force-graph or similar); click node → side panel with details + evidence links; filter by entity kind
- **Decisions** — list view + detail page per decision: what / why / alternatives / author / date / evidence links to GitHub
- **Ask** — question box calling the same ask logic through an API route; answer + source links

The `/web` app is the seed of the future hosted product dashboard: when going hosted, this same app gets deployed with auth added.

## Testing

- **TDD (vitest)** for: extraction response parsing/validation, entity name normalization + dedup logic, edge upsert/weight logic, schema helpers.
- **Regression fixtures:** a small set of realistic PR/commit payloads with known expected decisions/entities — extraction quality is the primary product risk, so it gets fixture-based regression tests (LLM calls mocked with recorded responses).
- **End-to-end smoke:** ingest a small real repo → extract → assert decisions/entities/edges exist in Supabase → ask returns an answer with evidence.

## Out of scope (this slice)

- Jira / Slack / Notion connectors
- Auth, multi-tenancy, hosting, RBAC, audit
- Unified timeline view
- Notifications
- GitHub PR **review comments / issue comments** ingestion (strong candidate for the next slice — high signal for decision quality)
- Neo4j
- Production build/deploy of the web app
