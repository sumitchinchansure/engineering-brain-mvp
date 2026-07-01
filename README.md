# Engineering Brain — GitHub Memory CLI

CLI tool that ingests a GitHub repo's PRs and commits, then answers "why was this built?" questions with evidence links.

## Prerequisites

- Node.js 20+
- A GitHub personal access token (read access to the repos you want to index)
- An OpenAI API key
- A Supabase project with the `pgvector` extension available

## 1. Install dependencies

```bash
npm install
```

## 2. Set up Supabase

1. Open your Supabase project's **SQL Editor**.
2. Paste and run the contents of [`supabase/schema.sql`](supabase/schema.sql). This creates the `indexed_items` table, the `pgvector` similarity index, and the `match_items` RPC function used for search. It is safe to re-run (uses `IF NOT EXISTS`/`OR REPLACE`).

## 3. Configure environment variables

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | GitHub personal access token |
| `OPENAI_API_KEY` | OpenAI API key |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Your Supabase anon/public API key |

## 4. Build

```bash
npm run build
```

## 5. Run

```bash
node dist/index.js ingest https://github.com/vercel/next.js
node dist/index.js ask "why was the app router introduced?"
node dist/index.js status
```

Or link it as a global `brain` command:

```bash
npm link
brain ingest https://github.com/vercel/next.js
brain ask "why was the app router introduced?"
brain status
```

## Commands

### `brain ingest <github-repo-url>`

Fetches the last 200 PRs and last 500 commits from the given GitHub repo, generates embeddings for each (OpenAI `text-embedding-3-small`), and stores them in Supabase. Prints `Indexed X PRs, Y commits` on success.

Options:
- `--since <date>` — only fetch PRs/commits created after this ISO date, e.g. `--since 2024-01-01`

### `brain ask "<question>"`

Embeds the question, finds the 5 most relevant indexed PRs/commits for the current repo via `pgvector` cosine similarity, and asks GPT-4o-mini to answer using only that context. Prints a short answer followed by source links. If nothing relevant is found, prints `Not enough context in indexed data to answer this confidently.` instead of guessing.

Options:
- `--repo <url>` — GitHub repo to query (defaults to the most recently ingested repo)

### `brain status`

Prints the repo name and how many PRs and commits are currently indexed for it.

Options:
- `--repo <url>` — GitHub repo to check (defaults to the most recently ingested repo)

## Notes

- Only one repo needs `--repo` if you've ingested more than one; otherwise `ask`/`status` default to whichever repo you last ran `ingest` on (tracked in a local `.brain/state.json` pointer file — no PR/commit data is cached locally, only Supabase stores that).
- Missing environment variables are detected before any network call and printed as a clear list, not a stack trace.

See [DECISIONS.md](DECISIONS.md) for assumptions made during the build.
