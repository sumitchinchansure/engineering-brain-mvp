# MVP Spec: Engineering Brain — GitHub Memory CLI

> **One-line summary:** CLI tool that ingests a GitHub repo's PRs and commits, then answers "why was this built?" questions with evidence links.

---

## Context

**Why this exists:**
Engineers waste hours tracing why a decision was made — digging through PRs, Slack, and tribal knowledge. This MVP proves that a repo's own PRs and commits contain enough signal to answer most "why" questions, automatically.

**Where it fits in the codebase:**
Greenfield repo. Standalone CLI. Start from scratch.

**Repo:** github.com/fujicoder/engineering-brain-mvp
**Branch to work on:** `claude/github-memory-cli` (don't touch main)
**Open a PR when done:** Yes

---

## Tech Stack

> Do not deviate from this. If a library isn't listed, don't add it.

| Layer | Choice |
|---|---|
| Runtime | Node 20 + TypeScript |
| CLI framework | `commander` |
| GitHub data | GitHub REST API via `@octokit/rest` |
| Embeddings | OpenAI `text-embedding-3-small` |
| Vector store | `pgvector` via Supabase (use `supabase-js`) |
| LLM for answers | OpenAI `gpt-4o-mini` |
| Local DB cache | None — Supabase only |
| Env vars | Listed in `.env.example` section below |

---

## What to Build

### Features (in priority order)

**Must have (P0) — build these, or this is a failure:**
- [ ] `brain ingest <github-repo-url>` — fetches last 200 PRs (title, body, merged_at, url) and last 500 commits (message, sha, url, author) from a GitHub repo and stores them in Supabase with embeddings
- [ ] `brain ask "<question>"` — takes a natural language question, finds the 5 most relevant PRs/commits via vector similarity search, sends them + question to GPT-4o-mini, returns an answer with source links
- [ ] `brain status` — shows how many PRs and commits are indexed for the current repo

**Nice to have (P1) — only if P0 is done:**
- [ ] `brain ingest --since 2024-01-01` date filter flag
- [ ] Colour-coded terminal output (use `chalk`)

**Do NOT build:**
- No web UI or dashboard
- No Slack, Jira, Linear, or Notion connectors
- No Neo4j or knowledge graph
- No multi-tenant or org-level features
- No auth layer or role-based access
- No streaming responses
- No pagination UI — just fetch the fixed limits above and stop

---

## Acceptance Criteria

```
GIVEN a valid GitHub repo URL and all env vars set
WHEN I run: brain ingest https://github.com/vercel/next.js
THEN the command exits 0, prints "Indexed X PRs, Y commits" and records exist in Supabase

GIVEN an indexed repo
WHEN I run: brain ask "why was the app router introduced?"
THEN the CLI prints a 2-5 sentence answer followed by 2-5 source links (PR or commit URLs)

GIVEN an indexed repo
WHEN I run: brain ask "why are we using Redis?"
THEN if no relevant results exist, Claude says "Not enough context found" rather than hallucinating

GIVEN no env vars set
WHEN I run any brain command
THEN the CLI prints a clear error listing which env vars are missing, not a raw JS exception

GIVEN brain status is run after ingest
THEN it prints the repo name, PR count, and commit count stored in Supabase
```

---

## File Structure

```
/engineering-brain-mvp/
├── src/
│   ├── index.ts           # CLI entry point, commander setup
│   ├── commands/
│   │   ├── ingest.ts      # fetches GitHub data, generates embeddings, upserts to Supabase
│   │   ├── ask.ts         # vector search + GPT-4o-mini answer generation
│   │   └── status.ts      # counts indexed records
│   ├── lib/
│   │   ├── github.ts      # octokit wrapper — fetchPRs(), fetchCommits()
│   │   ├── embeddings.ts  # OpenAI embedding wrapper — embed(text): number[]
│   │   ├── supabase.ts    # supabase client init + upsert/search helpers
│   │   └── llm.ts         # GPT-4o-mini wrapper — answer(question, context): string
│   └── types.ts           # shared types: PR, Commit, IndexedItem
├── supabase/
│   └── schema.sql         # CREATE TABLE and pgvector index — must be runnable as-is
├── .env.example
├── package.json
├── tsconfig.json
├── DECISIONS.md
└── README.md
```

---

## Environment Variables

```env
# .env.example
GITHUB_TOKEN=
OPENAI_API_KEY=
SUPABASE_URL=
SUPABASE_ANON_KEY=
```

---

## Data Model

**Supabase table: `indexed_items`**
```sql
id          uuid primary key default gen_random_uuid()
repo_url    text not null
type        text not null         -- 'pr' or 'commit'
source_url  text not null         -- link back to GitHub
title       text                  -- PR title or first line of commit message
body        text                  -- PR body or full commit message
author      text
created_at  timestamptz
embedding   vector(1536)          -- text-embedding-3-small output
indexed_at  timestamptz default now()
```

```sql
-- vector similarity index
CREATE INDEX ON indexed_items
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
```

Supabase RPC function for similarity search:
```sql
CREATE OR REPLACE FUNCTION match_items(
  query_embedding vector(1536),
  repo text,
  match_count int DEFAULT 5
)
RETURNS TABLE (id uuid, type text, source_url text, title text, body text, similarity float)
LANGUAGE sql AS $$
  SELECT id, type, source_url, title, body,
    1 - (embedding <=> query_embedding) AS similarity
  FROM indexed_items
  WHERE repo_url = repo
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
```

> Claude: put the full schema + RPC in `supabase/schema.sql`. The README must tell the user to run this in Supabase SQL editor before first use.

---

## Error Handling Rules

- Missing env vars → print list of missing vars and exit 1 before doing any API call
- GitHub API rate limit hit → print remaining rate limit and exit 1 with a helpful message
- OpenAI API error → log error message and exit 1
- Supabase write fails → log the failed item and continue to next (don't abort the whole ingest)
- No results from vector search → respond with "Not enough context in indexed data to answer this confidently." — never hallucinate
- Never let a raw stack trace reach the user — catch all errors at command level and print human-readable messages

---

## Blocker Protocol

> Claude: if you hit ambiguity or a blocker, follow this priority order:

1. Check existing code patterns in the repo first
2. Make a reasonable assumption — document it in `DECISIONS.md`
3. Skip the blocked sub-feature — add a `// TODO:` comment and keep going
4. Never stop the whole build — partial working > perfect incomplete

---

## Definition of Done

- [ ] `brain ingest <url>` works end-to-end on a real public GitHub repo
- [ ] `brain ask "<question>"` returns an answer + source links
- [ ] `brain status` shows indexed counts
- [ ] `supabase/schema.sql` is complete and runnable
- [ ] `.env.example` has all 4 required vars
- [ ] README has: prerequisites, env setup, `npm install`, schema setup step, and example commands
- [ ] `DECISIONS.md` documents any assumptions made
- [ ] No hardcoded repo URLs, API keys, or magic strings
- [ ] PR opened: `feat: engineering brain github memory cli — overnight build`