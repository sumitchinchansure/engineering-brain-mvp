# Decisions

Assumptions made while building this MVP, per the spec's Blocker Protocol (make a reasonable assumption, document it, keep going).

## 1. No `openai` SDK dependency

The tech stack table lists `@octokit/rest` explicitly for GitHub but only names "OpenAI `text-embedding-3-small`" / "OpenAI `gpt-4o-mini`" for the LLM layer, without naming a client package. Since the spec says "if a library isn't listed, don't add it," `src/lib/embeddings.ts` and `src/lib/llm.ts` call the OpenAI REST API directly via Node 20's built-in `fetch` instead of adding the `openai` npm package. This keeps the dependency list to exactly what's in the tech stack table.

## 2. No `dotenv` dependency

Same reasoning as above — `dotenv` isn't listed. `src/lib/env.ts` includes a ~25-line hand-rolled `.env` parser (`loadDotEnv`) instead.

## 3. How `ask`/`status` know which repo to query

The spec's command signatures are `brain ask "<question>"` and `brain status` — neither takes a repo argument, but the data model is scoped per `repo_url`. Resolution:

- `brain ingest <url>` records the canonical repo URL it just indexed to a local pointer file, `.brain/state.json`.
- `brain ask` and `brain status` default to that last-ingested repo, overridable with an optional `--repo <url>` flag on either command.

This is a small local pointer, not a data cache — it stores one URL string, not any PR/commit content. It doesn't conflict with "Local DB cache: None — Supabase only," which is about not caching indexed data locally.

## 4. Relevance threshold for "not enough context"

`pgvector` cosine similarity search always returns the closest `N` rows even when nothing in the corpus is actually relevant (e.g. asking about Redis in a repo that never mentions it). To satisfy the acceptance criterion that irrelevant questions get "Not enough context..." instead of a hallucinated answer, `brain ask` discards matches with cosine similarity below `0.75` (`src/commands/ask.ts`) before sending anything to the LLM. If all 5 matches fall below that bar, it prints the fallback message and skips the LLM call entirely. This threshold is a heuristic and may need tuning per-repo; it isn't specified in the spec.

## 5. Canonical repo URL normalization

`parseRepoUrl` (`src/lib/github.ts`) normalizes any GitHub URL form (`https://`, `.git` suffix, trailing slash, or `git@github.com:owner/repo.git`) to `https://github.com/{owner}/{repo}` before storing/querying `repo_url`, so `ingest`/`ask`/`status` agree on the same key regardless of how the user typed the URL.

## 6. Unique constraint on `source_url`

The spec's file-structure comment says `ingest.ts` "fetches GitHub data, generates embeddings, and *upserts* to Supabase," but the schema in the spec body only defines `id uuid primary key`, with no conflict target for an upsert. Added `unique (source_url)` to `indexed_items` in `supabase/schema.sql` so re-running `ingest` on the same repo updates existing rows instead of duplicating them.

## 7. Embedding input truncation

PR bodies/commit messages are truncated to 20,000 characters before embedding (`src/lib/embeddings.ts`) as a conservative guard against `text-embedding-3-small`'s ~8,191 token limit, since the spec doesn't specify truncation behavior for oversized inputs.

## 8. Row-Level Security disabled on `indexed_items`

Found during manual end-to-end testing: Supabase enables RLS by default on new tables, and with no policy defined, every insert from the anon key was rejected ("new row violates row-level security policy"). Since the spec explicitly excludes an auth/role-based-access layer and the CLI only ever authenticates as a single anon-key user, `supabase/schema.sql` now explicitly runs `alter table indexed_items disable row level security;` rather than adding policies for a permission model this MVP doesn't have.

## P1 status

Per the Blocker Protocol, P0 was completed and committed first. The `--since` date flag fell out naturally from `fetchPRs`/`fetchCommits` already accepting an optional cutoff (needed internally either way), so it shipped in the same pass as P0 rather than as a separate deferred commit. `chalk` colour output is the one remaining P1 item, added in its own follow-up commit after the P0 commit.
