# Knowledge Graph + Decision Pages + Local Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract entities, relationships, and decisions from already-ingested GitHub data into Supabase graph tables, upgrade `brain ask` to use them via Claude, and serve a local Next.js dashboard (`brain serve`).

**Architecture:** Two-stage extraction pipeline (Claude Haiku 4.5 classify → Claude Fable 5 deep-extract → link/dedup) writing to new `entities`/`edges`/`decisions` tables beside the existing `indexed_items`. `brain ask` searches items + decisions and answers with Claude Fable 5. A Next.js app in `/web` reads the same Supabase project through API routes.

**Tech Stack:** Node 20 + TypeScript (CommonJS, strict), commander, chalk@4, `@supabase/supabase-js`, `@anthropic-ai/sdk` (new), OpenAI embeddings via fetch (existing pattern), vitest (new, dev), Next.js 14 + React + `react-force-graph-2d` in `/web`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-02-graph-decision-pages-design.md`. Follow it exactly.
- Node >= 20; CLI stays CommonJS (`tsconfig.json` as-is). `/web` is its own package with its own tsconfig.
- Claude model IDs are exactly `claude-haiku-4-5` (classify) and `claude-fable-5` (deep extract + ask). Never append date suffixes. Fable rules: **omit the `thinking` parameter entirely**, never send `temperature`/`top_p`/`top_k`, include server-side fallbacks (`betas: ["server-side-fallback-2026-06-01"]`, `fallbacks: [{model: "claude-opus-4-8"}]`), and check `stop_reason === "refusal"` before reading content.
- Structured outputs via `output_config: {format: {type: "json_schema", schema}}` — never assistant prefill, never the deprecated top-level `output_format`.
- Error style: follow existing code — `logError` + `process.exit(1)` for run-level failures; per-item failures log and continue, never abort the run.
- New env var `ANTHROPIC_API_KEY` required; `OPENAI_API_KEY` stays (embeddings only).
- SQL must be re-runnable (`if not exists` / `or replace`); RLS disabled on all new tables (same rationale as `indexed_items`).
- Commit after every green test cycle. Never commit `.env`, `node_modules`, `web/node_modules`, `web/.next`.

## File Structure

```
supabase/schema-graph.sql        # NEW: additive migration (entities, edges, decisions, extraction_status, match_decisions)
src/types.ts                     # MODIFY: add Entity, Edge, Decision, extraction result types
src/lib/normalize.ts             # NEW: canonicalizeName()
src/lib/anthropic.ts             # NEW: Claude client — classifyBatch, deepExtract, judgeDuplicates, answerWithClaude
src/lib/graph.ts                 # NEW: Supabase graph helpers + pure mergeEvidence()
src/lib/env.ts                   # MODIFY: add ANTHROPIC_API_KEY
src/lib/llm.ts                   # DELETE (replaced by anthropic.ts answerWithClaude)
src/commands/extract.ts          # NEW: stage 1-3 orchestration
src/commands/ask.ts              # MODIFY: decisions search + Claude answer
src/commands/serve.ts            # NEW: spawn Next dev server
src/index.ts                     # MODIFY: register extract + serve
tests/normalize.test.ts          # NEW
tests/anthropic.test.ts          # NEW (parsing/validation, SDK mocked)
tests/graph.test.ts              # NEW (mergeEvidence)
tests/fixtures/extraction.ts     # NEW: realistic PR/commit payloads + expected outputs
vitest.config.ts                 # NEW
web/                             # NEW: Next.js app (see Tasks 9-11)
.env.example                     # MODIFY
README.md                        # MODIFY
```

---

### Task 1: Test infrastructure + dependencies

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `tests/smoke.test.ts` (temporary, deleted in Task 2)

**Interfaces:**
- Produces: `npm test` runs vitest; `@anthropic-ai/sdk` importable.

- [ ] **Step 1: Install deps**

```bash
npm install @anthropic-ai/sdk
npm install -D vitest
```

- [ ] **Step 2: Add test script to package.json**

In `package.json` `"scripts"`, add:

```json
"test": "vitest run"
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create a smoke test and verify the runner works**

`tests/smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('vitest wiring', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run: `npm test`
Expected: 1 passed.

- [ ] **Step 5: Verify build still passes**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts tests/smoke.test.ts
git commit -m "chore: add vitest + @anthropic-ai/sdk"
```

---

### Task 2: Schema migration + shared types

**Files:**
- Create: `supabase/schema-graph.sql`
- Modify: `src/types.ts`
- Delete: `tests/smoke.test.ts`

**Interfaces:**
- Produces (types consumed by all later tasks):
  - `EntityKind = 'person' | 'service' | 'component' | 'technology' | 'feature'`
  - `EdgeRelation = 'works_on' | 'part_of' | 'uses' | 'introduced' | 'modified' | 'decided_by' | 'affects'`
  - `Entity { id?: string; repo_url: string; kind: EntityKind; name: string; canonical_name: string; description: string | null; first_seen: string | null; last_seen: string | null }`
  - `Edge { id?: string; repo_url: string; source_id: string; target_id: string; relation: EdgeRelation; evidence_item_ids: string[]; weight: number }`
  - `DecisionAlternative { option: string; why_rejected: string }`
  - `Decision { id?: string; repo_url: string; title: string; decision: string; reasoning: string | null; alternatives: DecisionAlternative[]; author: string | null; decided_at: string | null; confidence: number; evidence_item_ids: string[]; embedding?: number[] }`
  - `MatchedDecision { id: string; title: string; decision: string; reasoning: string | null; alternatives: DecisionAlternative[]; author: string | null; evidence_item_ids: string[]; similarity: number }`
  - `ExtractionStatus = 'pending' | 'classified' | 'extracted' | 'skipped' | 'failed'`

- [ ] **Step 1: Write `supabase/schema-graph.sql`**

```sql
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
```

- [ ] **Step 2: Append the new types to `src/types.ts`**

Append to the end of `src/types.ts`:

```typescript
export type EntityKind = 'person' | 'service' | 'component' | 'technology' | 'feature';

export type EdgeRelation =
  | 'works_on'
  | 'part_of'
  | 'uses'
  | 'introduced'
  | 'modified'
  | 'decided_by'
  | 'affects';

export type ExtractionStatus = 'pending' | 'classified' | 'extracted' | 'skipped' | 'failed';

export interface Entity {
  id?: string;
  repo_url: string;
  kind: EntityKind;
  name: string;
  canonical_name: string;
  description: string | null;
  first_seen: string | null;
  last_seen: string | null;
}

export interface Edge {
  id?: string;
  repo_url: string;
  source_id: string;
  target_id: string;
  relation: EdgeRelation;
  evidence_item_ids: string[];
  weight: number;
}

export interface DecisionAlternative {
  option: string;
  why_rejected: string;
}

export interface Decision {
  id?: string;
  repo_url: string;
  title: string;
  decision: string;
  reasoning: string | null;
  alternatives: DecisionAlternative[];
  author: string | null;
  decided_at: string | null;
  confidence: number;
  evidence_item_ids: string[];
  embedding?: number[];
}

export interface MatchedDecision {
  id: string;
  title: string;
  decision: string;
  reasoning: string | null;
  alternatives: DecisionAlternative[];
  author: string | null;
  evidence_item_ids: string[];
  similarity: number;
}

/** Stage 1 output for one item. */
export interface ClassificationResult {
  is_decision_bearing: boolean;
  is_trivial: boolean;
  entity_mentions: { kind: EntityKind; name: string }[];
}

/** Stage 2 output for one decision-bearing item. */
export interface ExtractionResult {
  title: string;
  decision: string;
  reasoning: string | null;
  alternatives: DecisionAlternative[];
  confidence: number;
  entities: { kind: EntityKind; name: string; description: string | null }[];
  relationships: {
    source: { kind: EntityKind; name: string };
    target: { kind: EntityKind; name: string };
    relation: EdgeRelation;
  }[];
}
```

- [ ] **Step 3: Delete smoke test, verify build + tests**

```bash
rm tests/smoke.test.ts
npm run build && npm test
```

Expected: build exit 0; vitest reports no test files found is NOT acceptable — vitest exits 1 with no tests. Instead pass `--passWithNoTests` temporarily: run `npx vitest run --passWithNoTests`. Expected exit 0. (Real tests arrive in Task 3.)

- [ ] **Step 4: Commit**

```bash
git add supabase/schema-graph.sql src/types.ts
git rm tests/smoke.test.ts
git commit -m "feat: graph schema migration + shared graph types"
```

---

### Task 3: Name normalization (`src/lib/normalize.ts`)

**Files:**
- Create: `src/lib/normalize.ts`
- Test: `tests/normalize.test.ts`

**Interfaces:**
- Produces: `canonicalizeName(name: string): string` — lowercase, trim, collapse internal whitespace to single spaces, strip surrounding quotes/backticks, drop trailing punctuation, singularize a trailing plural "s" ONLY when the word is >3 chars (so "redis" stays "redis" but "queues" → "queue").

- [ ] **Step 1: Write the failing tests**

`tests/normalize.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { canonicalizeName } from '../src/lib/normalize';

describe('canonicalizeName', () => {
  it('lowercases and trims', () => {
    expect(canonicalizeName('  Auth Service ')).toBe('auth service');
  });
  it('collapses internal whitespace', () => {
    expect(canonicalizeName('auth   service')).toBe('auth service');
  });
  it('strips backticks and quotes', () => {
    expect(canonicalizeName('`Redis`')).toBe('redis');
    expect(canonicalizeName('"billing"')).toBe('billing');
  });
  it('drops trailing punctuation', () => {
    expect(canonicalizeName('auth service.')).toBe('auth service');
  });
  it('singularizes long plurals but not short words', () => {
    expect(canonicalizeName('queues')).toBe('queue');
    expect(canonicalizeName('redis')).toBe('redis');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/normalize.test.ts`
Expected: FAIL — cannot find module `../src/lib/normalize`.

- [ ] **Step 3: Implement `src/lib/normalize.ts`**

```typescript
/**
 * Normalizes an entity name so "Auth Service", "`auth-service`" and
 * "auth services" dedupe to the same canonical key. Deliberately simple:
 * exact matching handles most duplicates; the ambiguous remainder goes to
 * the LLM judge in the linking stage.
 */
export function canonicalizeName(name: string): string {
  let s = name.trim().toLowerCase();
  s = s.replace(/^[`'"]+|[`'"]+$/g, '');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/[.,;:!?]+$/g, '');
  const words = s.split(' ');
  const last = words[words.length - 1];
  if (last.length > 3 && last.endsWith('s') && !last.endsWith('ss')) {
    words[words.length - 1] = last.slice(0, -1);
  }
  return words.join(' ').trim();
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/normalize.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/normalize.ts tests/normalize.test.ts
git commit -m "feat: entity name canonicalization"
```

---

### Task 4: Claude client (`src/lib/anthropic.ts`) + env var

**Files:**
- Create: `src/lib/anthropic.ts`
- Modify: `src/lib/env.ts` (add `ANTHROPIC_API_KEY`)
- Modify: `.env.example`
- Test: `tests/anthropic.test.ts`

**Interfaces:**
- Consumes: `ClassificationResult`, `ExtractionResult`, `EntityKind`, `EdgeRelation` from `src/types.ts` (Task 2).
- Produces (used by Tasks 6-7):
  - `classifyBatch(items: ClassifyInput[]): Promise<ClassificationResult[]>` where `ClassifyInput = { id: string; type: string; title: string; body: string }` — one Haiku call per batch, results in input order.
  - `deepExtract(item: ClassifyInput, relatedContext: string): Promise<ExtractionResult | null>` — Fable call; `null` when the request was refused (caller marks item `failed`).
  - `judgeDuplicates(pairs: { kind: string; a: string; b: string }[]): Promise<boolean[]>` — one Fable call; `true` = same entity.
  - `answerWithClaude(question: string, context: string): Promise<string>` — Fable answer for `ask`.
  - Exported pure validators (unit-tested): `parseClassificationResults(raw: unknown, expectedCount: number): ClassificationResult[]`, `parseExtractionResult(raw: unknown): ExtractionResult`.

**API rules (from Global Constraints — repeated here because this is the only file that calls Claude):**
- Models: `claude-haiku-4-5` for `classifyBatch`; `claude-fable-5` for everything else. Never append date suffixes.
- Fable calls go through `client.beta.messages.create` with `betas: ['server-side-fallback-2026-06-01']` and `fallbacks: [{ model: 'claude-opus-4-8' }]`. **Never** send `thinking`, `temperature`, `top_p`, or `top_k`.
- Structured outputs via `output_config: { format: { type: 'json_schema', schema } }`. Every object schema needs `additionalProperties: false` and a `required` list. No `minLength`/`maximum`-style constraints (unsupported).
- Check `stop_reason === 'refusal'` before reading `content`. Haiku classify: treat refusal like a malformed response (retry once, then throw). Fable deepExtract: refusal after server-side fallback means the whole chain refused → return `null`.
- Malformed/unparseable JSON: retry the call once, then throw — the caller decides whether that aborts the run (rate limits) or fails the item.

- [ ] **Step 1: Write the failing tests**

`tests/anthropic.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseClassificationResults, parseExtractionResult } from '../src/lib/anthropic';

const validClassification = {
  results: [
    { is_decision_bearing: true, is_trivial: false, entity_mentions: [{ kind: 'technology', name: 'Redis' }] },
    { is_decision_bearing: false, is_trivial: true, entity_mentions: [] },
  ],
};

describe('parseClassificationResults', () => {
  it('accepts a valid payload and returns results in order', () => {
    const out = parseClassificationResults(validClassification, 2);
    expect(out).toHaveLength(2);
    expect(out[0].is_decision_bearing).toBe(true);
    expect(out[1].is_trivial).toBe(true);
  });
  it('rejects a count mismatch', () => {
    expect(() => parseClassificationResults(validClassification, 3)).toThrow(/expected 3/i);
  });
  it('rejects an invalid entity kind', () => {
    const bad = { results: [{ is_decision_bearing: false, is_trivial: false, entity_mentions: [{ kind: 'planet', name: 'Mars' }] }] };
    expect(() => parseClassificationResults(bad, 1)).toThrow(/kind/i);
  });
});

const validExtraction = {
  title: 'Use Redis for session cache',
  decision: 'Adopt Redis as the session cache backend.',
  reasoning: 'In-process cache did not survive restarts.',
  alternatives: [{ option: 'Memcached', why_rejected: 'No persistence.' }],
  confidence: 0.9,
  entities: [{ kind: 'technology', name: 'Redis', description: 'In-memory data store' }],
  relationships: [
    { source: { kind: 'component', name: 'session service' }, target: { kind: 'technology', name: 'Redis' }, relation: 'uses' },
  ],
};

describe('parseExtractionResult', () => {
  it('accepts a valid payload', () => {
    const out = parseExtractionResult(validExtraction);
    expect(out.title).toBe('Use Redis for session cache');
    expect(out.relationships[0].relation).toBe('uses');
  });
  it('rejects an invalid relation', () => {
    const bad = { ...validExtraction, relationships: [{ ...validExtraction.relationships[0], relation: 'loves' }] };
    expect(() => parseExtractionResult(bad)).toThrow(/relation/i);
  });
  it('clamps confidence into 0..1', () => {
    const out = parseExtractionResult({ ...validExtraction, confidence: 1.7 });
    expect(out.confidence).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/anthropic.test.ts`
Expected: FAIL — cannot find module `../src/lib/anthropic`.

- [ ] **Step 3: Implement `src/lib/anthropic.ts`**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import type {
  ClassificationResult,
  EdgeRelation,
  EntityKind,
  ExtractionResult,
} from '../types';

const CLASSIFY_MODEL = 'claude-haiku-4-5';
const REASONING_MODEL = 'claude-fable-5';
// Fable can decline benign-adjacent requests via safety classifiers; the
// server-side fallback transparently re-serves those on Opus 4.8.
const FABLE_BETAS = ['server-side-fallback-2026-06-01'];
const FABLE_FALLBACKS = [{ model: 'claude-opus-4-8' }];
const MAX_ITEM_CHARS = 4000;

const ENTITY_KINDS: EntityKind[] = ['person', 'service', 'component', 'technology', 'feature'];
const EDGE_RELATIONS: EdgeRelation[] = ['works_on', 'part_of', 'uses', 'introduced', 'modified', 'decided_by', 'affects'];

export interface ClassifyInput {
  id: string;
  type: string;
  title: string;
  body: string;
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return client;
}

// ---------- schemas (structured outputs) ----------

const entityMentionSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ENTITY_KINDS },
    name: { type: 'string' },
  },
  required: ['kind', 'name'],
  additionalProperties: false,
} as const;

const classificationSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          is_decision_bearing: { type: 'boolean' },
          is_trivial: { type: 'boolean' },
          entity_mentions: { type: 'array', items: entityMentionSchema },
        },
        required: ['is_decision_bearing', 'is_trivial', 'entity_mentions'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const;

const extractionSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    decision: { type: 'string' },
    reasoning: { type: ['string', 'null'] },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: { option: { type: 'string' }, why_rejected: { type: 'string' } },
        required: ['option', 'why_rejected'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'number' },
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ENTITY_KINDS },
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
        },
        required: ['kind', 'name', 'description'],
        additionalProperties: false,
      },
    },
    relationships: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: entityMentionSchema,
          target: entityMentionSchema,
          relation: { type: 'string', enum: EDGE_RELATIONS },
        },
        required: ['source', 'target', 'relation'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'decision', 'reasoning', 'alternatives', 'confidence', 'entities', 'relationships'],
  additionalProperties: false,
} as const;

const judgeSchema = {
  type: 'object',
  properties: { same: { type: 'array', items: { type: 'boolean' } } },
  required: ['same'],
  additionalProperties: false,
} as const;

// ---------- pure validators (unit-tested) ----------

function isEntityKind(v: unknown): v is EntityKind {
  return typeof v === 'string' && (ENTITY_KINDS as string[]).includes(v);
}

function isRelation(v: unknown): v is EdgeRelation {
  return typeof v === 'string' && (EDGE_RELATIONS as string[]).includes(v);
}

export function parseClassificationResults(raw: unknown, expectedCount: number): ClassificationResult[] {
  const results = (raw as { results?: unknown })?.results;
  if (!Array.isArray(results)) throw new Error('classification: missing results array');
  if (results.length !== expectedCount) {
    throw new Error(`classification: expected ${expectedCount} results, got ${results.length}`);
  }
  return results.map((r, i) => {
    const row = r as Record<string, unknown>;
    if (typeof row.is_decision_bearing !== 'boolean' || typeof row.is_trivial !== 'boolean') {
      throw new Error(`classification: result ${i} missing boolean flags`);
    }
    const mentions = Array.isArray(row.entity_mentions) ? row.entity_mentions : [];
    const entity_mentions = mentions.map((m) => {
      const mention = m as Record<string, unknown>;
      if (!isEntityKind(mention.kind)) throw new Error(`classification: result ${i} has invalid entity kind "${String(mention.kind)}"`);
      if (typeof mention.name !== 'string' || !mention.name.trim()) throw new Error(`classification: result ${i} has empty entity name`);
      return { kind: mention.kind, name: mention.name };
    });
    return { is_decision_bearing: row.is_decision_bearing, is_trivial: row.is_trivial, entity_mentions };
  });
}

export function parseExtractionResult(raw: unknown): ExtractionResult {
  const r = raw as Record<string, unknown>;
  if (typeof r?.title !== 'string' || typeof r?.decision !== 'string') {
    throw new Error('extraction: missing title/decision');
  }
  const alternatives = (Array.isArray(r.alternatives) ? r.alternatives : []).map((a) => {
    const alt = a as Record<string, unknown>;
    if (typeof alt.option !== 'string' || typeof alt.why_rejected !== 'string') throw new Error('extraction: invalid alternative');
    return { option: alt.option, why_rejected: alt.why_rejected };
  });
  const entities = (Array.isArray(r.entities) ? r.entities : []).map((e) => {
    const ent = e as Record<string, unknown>;
    if (!isEntityKind(ent.kind)) throw new Error(`extraction: invalid entity kind "${String(ent.kind)}"`);
    if (typeof ent.name !== 'string' || !ent.name.trim()) throw new Error('extraction: empty entity name');
    return { kind: ent.kind, name: ent.name, description: typeof ent.description === 'string' ? ent.description : null };
  });
  const relationships = (Array.isArray(r.relationships) ? r.relationships : []).map((rel) => {
    const rr = rel as Record<string, unknown>;
    const source = rr.source as Record<string, unknown>;
    const target = rr.target as Record<string, unknown>;
    if (!isRelation(rr.relation)) throw new Error(`extraction: invalid relation "${String(rr.relation)}"`);
    if (!isEntityKind(source?.kind) || typeof source?.name !== 'string') throw new Error('extraction: invalid relationship source');
    if (!isEntityKind(target?.kind) || typeof target?.name !== 'string') throw new Error('extraction: invalid relationship target');
    return {
      source: { kind: source.kind as EntityKind, name: source.name as string },
      target: { kind: target.kind as EntityKind, name: target.name as string },
      relation: rr.relation,
    };
  });
  const rawConfidence = typeof r.confidence === 'number' ? r.confidence : 0.5;
  return {
    title: r.title,
    decision: r.decision,
    reasoning: typeof r.reasoning === 'string' ? r.reasoning : null,
    alternatives,
    confidence: Math.min(1, Math.max(0, rawConfidence)),
    entities,
    relationships,
  };
}

// ---------- call helpers ----------

function textOf(response: Anthropic.Message | Anthropic.Beta.BetaMessage): string {
  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') throw new Error('Claude returned no text content');
  return block.text;
}

function truncate(s: string): string {
  return s.length > MAX_ITEM_CHARS ? s.slice(0, MAX_ITEM_CHARS) + '\n[truncated]' : s;
}

/** Calls fn, retrying once on malformed-output errors. */
async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Anthropic.APIError) throw err; // API errors are the caller's problem
    return await fn();
  }
}

// ---------- public API ----------

const CLASSIFY_SYSTEM =
  'You classify GitHub PRs and commits for a knowledge extraction pipeline. ' +
  'For each numbered item decide: is_trivial (typo fixes, version bumps, lockfile churn, formatting — nothing worth remembering), ' +
  'is_decision_bearing (the text records or implies an engineering decision: a choice between approaches, a technology adoption, an architectural change, a deliberate trade-off), ' +
  'and entity_mentions (services, components, technologies, features, or people explicitly mentioned). ' +
  'A trivial item is never decision-bearing. Return exactly one result per item, in input order.';

export async function classifyBatch(items: ClassifyInput[]): Promise<ClassificationResult[]> {
  const prompt = items
    .map((it, i) => `### Item ${i + 1} (${it.type})\nTitle: ${it.title}\n${truncate(it.body)}`)
    .join('\n\n');
  return withOneRetry(async () => {
    const response = await getClient().messages.create({
      model: CLASSIFY_MODEL,
      max_tokens: 8000,
      system: CLASSIFY_SYSTEM,
      output_config: { format: { type: 'json_schema', schema: classificationSchema } },
      messages: [{ role: 'user', content: `Classify these ${items.length} items:\n\n${prompt}` }],
    });
    if (response.stop_reason === 'refusal') throw new Error('classification refused');
    return parseClassificationResults(JSON.parse(textOf(response)), items.length);
  });
}

const EXTRACT_SYSTEM =
  'You extract engineering decisions and knowledge-graph facts from a GitHub PR or commit. ' +
  'Report only what the text actually supports: the decision made, the reasoning if stated, alternatives only if explicitly mentioned or rejected. ' +
  'Set confidence to how certain you are that this is a real, deliberate decision (1.0 = explicitly stated with rationale, 0.3 = implied). ' +
  'Entities are services, components, technologies, features, or people. Relationships connect entities you listed. Never invent information.';

export async function deepExtract(item: ClassifyInput, relatedContext: string): Promise<ExtractionResult | null> {
  const related = relatedContext ? `\n\nRelated items for context:\n${relatedContext}` : '';
  return withOneRetry(async () => {
    const response = await getClient().beta.messages.create({
      model: REASONING_MODEL,
      max_tokens: 16000,
      betas: FABLE_BETAS,
      fallbacks: FABLE_FALLBACKS,
      system: EXTRACT_SYSTEM,
      output_config: { format: { type: 'json_schema', schema: extractionSchema } },
      messages: [
        {
          role: 'user',
          content: `Extract the decision and graph facts from this ${item.type}:\n\nTitle: ${item.title}\n${truncate(item.body)}${related}`,
        },
      ],
    });
    if (response.stop_reason === 'refusal') return null; // whole fallback chain declined
    return parseExtractionResult(JSON.parse(textOf(response)));
  });
}

export async function judgeDuplicates(pairs: { kind: string; a: string; b: string }[]): Promise<boolean[]> {
  if (pairs.length === 0) return [];
  const list = pairs.map((p, i) => `${i + 1}. [${p.kind}] "${p.a}" vs "${p.b}"`).join('\n');
  return withOneRetry(async () => {
    const response = await getClient().beta.messages.create({
      model: REASONING_MODEL,
      max_tokens: 4000,
      betas: FABLE_BETAS,
      fallbacks: FABLE_FALLBACKS,
      output_config: { format: { type: 'json_schema', schema: judgeSchema } },
      messages: [
        {
          role: 'user',
          content:
            'For each pair of entity names from the same code repository, answer whether they refer to the same thing ' +
            `(true) or different things (false). Return one boolean per pair, in order.\n\n${list}`,
        },
      ],
    });
    if (response.stop_reason === 'refusal') throw new Error('duplicate judging refused');
    const parsed = JSON.parse(textOf(response)) as { same?: unknown };
    if (!Array.isArray(parsed.same) || parsed.same.length !== pairs.length) {
      throw new Error(`judge: expected ${pairs.length} booleans`);
    }
    return parsed.same.map((v) => v === true);
  });
}

// Preserves the retrieval-judgment rules from the old GPT-4o-mini prompt
// (DECISIONS.md #4): similarity scores are weak signals; refuse to
// over-generalize from narrow matches.
const ANSWER_SYSTEM =
  'You are an engineering assistant that explains why code changes were made, ' +
  'using only the provided context. Context items are PRs, commits, and extracted engineering decisions. ' +
  'Each item includes a cosine similarity score (0-1) — treat it as a weak, noisy signal, not proof of relevance. ' +
  'Extracted decisions are high-quality structured records: when one directly addresses the question, ground your answer in it. ' +
  'Answer in 2-5 sentences, but only if at least one context item directly and specifically addresses the question. ' +
  'Do not generalize from an item that only covers a narrow, tangential detail into a broader claim about the question. ' +
  'If the context items are only loosely related, or their similarity scores are all low and closely clustered with no clear standout, ' +
  'respond with exactly: "Not enough context in indexed data to answer this confidently." ' +
  'Never invent information that is not in the context.';

export async function answerWithClaude(question: string, context: string): Promise<string> {
  const response = await getClient().beta.messages.create({
    model: REASONING_MODEL,
    max_tokens: 2000,
    betas: FABLE_BETAS,
    fallbacks: FABLE_FALLBACKS,
    system: ANSWER_SYSTEM,
    messages: [{ role: 'user', content: `Question: ${question}\n\nContext:\n${context}` }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to answer this question (safety refusal).');
  }
  return textOf(response).trim();
}
```

- [ ] **Step 4: Add `ANTHROPIC_API_KEY` to env validation**

In `src/lib/env.ts`, change the `REQUIRED_ENV_VARS` array to:

```typescript
const REQUIRED_ENV_VARS = [
  'GITHUB_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
] as const;
```

Append to `.env.example`:

```
ANTHROPIC_API_KEY=
```

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run tests/anthropic.test.ts && npm run build`
Expected: 6 tests pass; build exit 0. If the SDK's `output_config` or `fallbacks` types cause TS errors, check the installed `@anthropic-ai/sdk` version is current (`npm install @anthropic-ai/sdk@latest`) before adding any casts.

- [ ] **Step 6: Commit**

```bash
git add src/lib/anthropic.ts src/lib/env.ts .env.example tests/anthropic.test.ts
git commit -m "feat: Claude client — classify, deep-extract, judge, answer"
```

---

### Task 5: Graph store helpers (`src/lib/graph.ts`)

**Files:**
- Create: `src/lib/graph.ts`
- Test: `tests/graph.test.ts`

**Interfaces:**
- Consumes: `getSupabaseClient()` from `src/lib/supabase.ts`; `Entity`, `Edge`, `Decision`, `MatchedDecision`, `ExtractionStatus` from `src/types.ts`; `canonicalizeName` from `src/lib/normalize.ts` (Task 3).
- Produces (used by Tasks 6-7 and the web API mirrors them):
  - `mergeEvidence(existing: string[], incoming: string[]): string[]` — pure: union, first-seen order, deduped.
  - `upsertEntity(entity: Omit<Entity, 'id' | 'canonical_name'>): Promise<{ id: string | null; error: string | null }>` — computes `canonical_name`, select-then-insert/update on `(repo_url, kind, canonical_name)`; widens `first_seen`/`last_seen`, fills `description` only if currently null.
  - `upsertEdge(edge: Omit<Edge, 'id' | 'weight'>): Promise<{ error: string | null }>` — insert with weight 1, or increment weight and merge evidence on the existing row.
  - `insertDecision(decision: Decision): Promise<{ error: string | null }>`
  - `fetchPendingItems(repoUrl: string, limit: number): Promise<{ data: PendingItem[]; error: string | null }>` where `PendingItem = { id: string; type: string; source_url: string; title: string; body: string; author: string | null; created_at: string | null }` — rows with `extraction_status = 'pending'`, ordered by `created_at`.
  - `setExtractionStatus(ids: string[], status: ExtractionStatus): Promise<{ error: string | null }>`
  - `searchSimilarDecisions(repoUrl: string, embedding: number[], count: number): Promise<{ data: MatchedDecision[]; error: string | null }>` — `match_decisions` RPC.
  - `fetchItemSourceUrls(ids: string[]): Promise<Map<string, string>>` — id → source_url lookup for evidence links.
  - `listEntities(repoUrl: string): Promise<{ data: Entity[]; error: string | null }>`
  - `mergeEntities(keepId: string, dropId: string): Promise<{ error: string | null }>` — repoint `dropId`'s edges to `keepId` (merging weight/evidence into an existing conflicting edge), then delete `dropId`.

All helpers return `{ error }` rather than throwing (same pattern as `upsertItem` in `src/lib/supabase.ts`) so the extract loop can log-and-continue.

- [ ] **Step 1: Write the failing tests (pure logic only — Supabase helpers are exercised by the e2e smoke in Task 11)**

`tests/graph.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mergeEvidence } from '../src/lib/graph';

describe('mergeEvidence', () => {
  it('unions and dedupes, preserving first-seen order', () => {
    expect(mergeEvidence(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });
  it('handles empty existing', () => {
    expect(mergeEvidence([], ['x'])).toEqual(['x']);
  });
  it('handles empty incoming', () => {
    expect(mergeEvidence(['x'], [])).toEqual(['x']);
  });
  it('dedupes within incoming', () => {
    expect(mergeEvidence([], ['a', 'a', 'b'])).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/graph.test.ts`
Expected: FAIL — cannot find module `../src/lib/graph`.

- [ ] **Step 3: Implement `src/lib/graph.ts`**

```typescript
import { getSupabaseClient } from './supabase';
import { canonicalizeName } from './normalize';
import type { Decision, Edge, Entity, ExtractionStatus, MatchedDecision } from '../types';

export interface PendingItem {
  id: string;
  type: string;
  source_url: string;
  title: string;
  body: string;
  author: string | null;
  created_at: string | null;
}

/** Union of evidence item ids, first-seen order, deduped. Pure. */
export function mergeEvidence(existing: string[], incoming: string[]): string[] {
  const out = [...existing];
  const seen = new Set(existing);
  for (const id of incoming) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export async function upsertEntity(
  entity: Omit<Entity, 'id' | 'canonical_name'>
): Promise<{ id: string | null; error: string | null }> {
  const supabase = getSupabaseClient();
  const canonical_name = canonicalizeName(entity.name);

  const { data: existing, error: selectError } = await supabase
    .from('entities')
    .select('id, description, first_seen, last_seen')
    .eq('repo_url', entity.repo_url)
    .eq('kind', entity.kind)
    .eq('canonical_name', canonical_name)
    .maybeSingle();
  if (selectError) return { id: null, error: selectError.message };

  if (existing) {
    const updates: Record<string, unknown> = {};
    if (!existing.description && entity.description) updates.description = entity.description;
    if (entity.first_seen && (!existing.first_seen || entity.first_seen < existing.first_seen)) {
      updates.first_seen = entity.first_seen;
    }
    if (entity.last_seen && (!existing.last_seen || entity.last_seen > existing.last_seen)) {
      updates.last_seen = entity.last_seen;
    }
    if (Object.keys(updates).length > 0) {
      const { error } = await supabase.from('entities').update(updates).eq('id', existing.id);
      if (error) return { id: null, error: error.message };
    }
    return { id: existing.id, error: null };
  }

  const { data, error } = await supabase
    .from('entities')
    .insert({ ...entity, canonical_name })
    .select('id')
    .single();
  if (error) {
    // Concurrent insert of the same canonical name: re-read instead of failing.
    const retry = await supabase
      .from('entities')
      .select('id')
      .eq('repo_url', entity.repo_url)
      .eq('kind', entity.kind)
      .eq('canonical_name', canonical_name)
      .maybeSingle();
    if (retry.data) return { id: retry.data.id, error: null };
    return { id: null, error: error.message };
  }
  return { id: data.id, error: null };
}

export async function upsertEdge(edge: Omit<Edge, 'id' | 'weight'>): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  const { data: existing, error: selectError } = await supabase
    .from('edges')
    .select('id, weight, evidence_item_ids')
    .eq('repo_url', edge.repo_url)
    .eq('source_id', edge.source_id)
    .eq('target_id', edge.target_id)
    .eq('relation', edge.relation)
    .maybeSingle();
  if (selectError) return { error: selectError.message };

  if (existing) {
    const { error } = await supabase
      .from('edges')
      .update({
        weight: existing.weight + 1,
        evidence_item_ids: mergeEvidence(existing.evidence_item_ids ?? [], edge.evidence_item_ids),
      })
      .eq('id', existing.id);
    return { error: error ? error.message : null };
  }

  const { error } = await supabase.from('edges').insert({ ...edge, weight: 1 });
  return { error: error ? error.message : null };
}

export async function insertDecision(decision: Decision): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('decisions').insert(decision);
  return { error: error ? error.message : null };
}

export async function fetchPendingItems(
  repoUrl: string,
  limit: number
): Promise<{ data: PendingItem[]; error: string | null }> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('indexed_items')
    .select('id, type, source_url, title, body, author, created_at')
    .eq('repo_url', repoUrl)
    .eq('extraction_status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as PendingItem[], error: null };
}

export async function setExtractionStatus(
  ids: string[],
  status: ExtractionStatus
): Promise<{ error: string | null }> {
  if (ids.length === 0) return { error: null };
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('indexed_items').update({ extraction_status: status }).in('id', ids);
  return { error: error ? error.message : null };
}

export async function searchSimilarDecisions(
  repoUrl: string,
  embedding: number[],
  count: number
): Promise<{ data: MatchedDecision[]; error: string | null }> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('match_decisions', {
    query_embedding: embedding,
    repo: repoUrl,
    match_count: count,
  });
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as MatchedDecision[], error: null };
}

export async function fetchItemSourceUrls(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const supabase = getSupabaseClient();
  const { data } = await supabase.from('indexed_items').select('id, source_url').in('id', ids);
  return new Map((data ?? []).map((row: { id: string; source_url: string }) => [row.id, row.source_url]));
}

export async function listEntities(repoUrl: string): Promise<{ data: Entity[]; error: string | null }> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('entities').select('*').eq('repo_url', repoUrl);
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as Entity[], error: null };
}

/** Repoints dropId's edges onto keepId (merging into conflicting edges), then deletes dropId. */
export async function mergeEntities(keepId: string, dropId: string): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  const { data: edges, error: edgeError } = await supabase
    .from('edges')
    .select('id, repo_url, source_id, target_id, relation, evidence_item_ids, weight')
    .or(`source_id.eq.${dropId},target_id.eq.${dropId}`);
  if (edgeError) return { error: edgeError.message };

  for (const edge of edges ?? []) {
    const newSource = edge.source_id === dropId ? keepId : edge.source_id;
    const newTarget = edge.target_id === dropId ? keepId : edge.target_id;
    if (newSource === newTarget) {
      // self-edge after merge — drop it
      await supabase.from('edges').delete().eq('id', edge.id);
      continue;
    }
    const { data: conflict } = await supabase
      .from('edges')
      .select('id, weight, evidence_item_ids')
      .eq('repo_url', edge.repo_url)
      .eq('source_id', newSource)
      .eq('target_id', newTarget)
      .eq('relation', edge.relation)
      .maybeSingle();
    if (conflict) {
      await supabase
        .from('edges')
        .update({
          weight: conflict.weight + edge.weight,
          evidence_item_ids: mergeEvidence(conflict.evidence_item_ids ?? [], edge.evidence_item_ids ?? []),
        })
        .eq('id', conflict.id);
      await supabase.from('edges').delete().eq('id', edge.id);
    } else {
      await supabase.from('edges').update({ source_id: newSource, target_id: newTarget }).eq('id', edge.id);
    }
  }

  const { error } = await supabase.from('entities').delete().eq('id', dropId);
  return { error: error ? error.message : null };
}
```

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/graph.test.ts && npm run build`
Expected: 4 tests pass; build exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/graph.ts tests/graph.test.ts
git commit -m "feat: Supabase graph helpers (entities, edges, decisions)"
```

---

### Task 6: `brain extract` command (3-stage pipeline)

**Files:**
- Create: `src/commands/extract.ts`
- Create: `tests/fixtures/extraction.ts`
- Modify: `src/index.ts` (register command)
- Test: `tests/extract.test.ts`

**Interfaces:**
- Consumes: `classifyBatch`, `deepExtract`, `judgeDuplicates`, `ClassifyInput` (Task 4); all graph helpers + `PendingItem` (Task 5); `embed` from `src/lib/embeddings.ts`; `canonicalizeName` (Task 3); `parseRepoUrl` from `src/lib/github.ts`; `loadLastRepo`, `validateEnv`, log helpers (existing).
- Produces: `extractCommand(options: { repo?: string }): Promise<void>`; exported pure helpers (unit-tested): `relatedKey(item: { type: string; source_url: string; title: string }): string | null` and `candidatePairs(entities: { id: string; kind: string; canonical_name: string }[]): { aId: string; bId: string; kind: string; a: string; b: string }[]`.

**Pipeline behavior (follow exactly):**
1. Resolve repo (same pattern as `askCommand`), `validateEnv()`.
2. Loop: `fetchPendingItems(repo, 200)`; stop when empty. Total-processed counter for progress.
3. **Stage 1** — chunk into batches of 20 → `classifyBatch`. Per batch result:
   - `is_trivial` → collect id for `skipped`.
   - decision-bearing → queue for stage 2.
   - otherwise → collect id for `classified`; its `entity_mentions` still become entities (upsert with `first_seen`/`last_seen` = item `created_at`, description null) and the item's author becomes a `person` entity with a `works_on` edge to each mentioned entity (evidence = item id).
   - A failed batch (throw after retry): if the error is an `Anthropic.APIError` with status 429 → `logError` + `process.exit(1)` (resumable); otherwise mark the whole batch `failed` and continue.
4. **Stage 2** — per decision-bearing item: build related context via `relatedKey` (PR number, see below): fetch up to 5 other items whose title contains `#<n>` (or, for a commit whose title references `#<n>`, the PR at `/pull/<n>`), format as `- (type) title` lines. Call `deepExtract`:
   - `null` (refused) or thrown error after retry → mark item `failed`, log, continue.
   - Success → upsert all `entities` (dates from item `created_at`); upsert all `relationships` as edges (skip any whose source/target entity upsert failed); author → `person` entity + `decided_by` edge from each non-person entity in the item to the person; embed `title + '\n' + decision + '\n' + (reasoning ?? '')` via `embed()`; `insertDecision` with `confidence`, `alternatives`, `author`, `decided_at` = item `created_at`, `evidence_item_ids` = [item id]. Mark item `extracted`.
   - OpenAI embed failure → `logError` + `process.exit(1)` (same as ingest).
5. Progress: `logInfo` every 20 items (`Classified X/Y...`, `Extracted decision: "<title>"` per decision, chalk-colored like ingest).
6. **Stage 3 (after all pages)** — `listEntities(repo)`; `candidatePairs` = same-kind pairs where one canonical name is a substring of the other, or they share a word longer than 3 chars, and the names are not equal (equal names already merged by the unique constraint). Cap at 40 pairs. One `judgeDuplicates` call → for each `true`, `mergeEntities(keep, drop)` keeping the entity with the shorter canonical name (likelier the canonical form). Judge failure → warn and skip dedup (never abort the run).
7. Summary line: `logSuccess('Extract complete: N classified, M skipped, K decisions, E entities, F failed')`.

**`relatedKey` definition:** for `type === 'pr'`, return the PR number parsed from `source_url` (`/pull/(\d+)`); for a commit, return the first `#(\d+)` match in the title; else `null`.

- [ ] **Step 1: Write fixtures**

`tests/fixtures/extraction.ts`:

```typescript
import type { ClassificationResult, ExtractionResult } from '../../src/types';

/** Realistic PR/commit payloads with the outputs a correct pipeline should produce. */
export const FIXTURE_ITEMS = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    type: 'pr',
    source_url: 'https://github.com/acme/shop/pull/42',
    title: 'Switch session storage from in-memory to Redis',
    body:
      'Our in-process session cache loses all sessions on deploy. This PR moves session storage to Redis.\n\n' +
      'We considered Memcached but it has no persistence, and sticky sessions at the LB level, ' +
      'which does not survive instance loss. Redis gives us persistence and TTLs out of the box.',
    author: 'alice',
    created_at: '2026-05-01T10:00:00Z',
  },
  {
    id: '00000000-0000-0000-0000-000000000002',
    type: 'commit',
    source_url: 'https://github.com/acme/shop/commit/abc123',
    title: 'fix typo in README',
    body: 'fix typo in README',
    author: 'bob',
    created_at: '2026-05-02T10:00:00Z',
  },
  {
    id: '00000000-0000-0000-0000-000000000003',
    type: 'commit',
    source_url: 'https://github.com/acme/shop/commit/def456',
    title: 'wire redis client into session service (#42)',
    body: 'wire redis client into session service (#42)',
    author: 'alice',
    created_at: '2026-05-01T11:00:00Z',
  },
];

/** What Haiku should say about the three items above (recorded-response shape). */
export const FIXTURE_CLASSIFICATION: ClassificationResult[] = [
  {
    is_decision_bearing: true,
    is_trivial: false,
    entity_mentions: [
      { kind: 'technology', name: 'Redis' },
      { kind: 'technology', name: 'Memcached' },
    ],
  },
  { is_decision_bearing: false, is_trivial: true, entity_mentions: [] },
  {
    is_decision_bearing: false,
    is_trivial: false,
    entity_mentions: [
      { kind: 'technology', name: 'Redis' },
      { kind: 'component', name: 'session service' },
    ],
  },
];

/** What Fable should extract from item 1 (recorded-response shape). */
export const FIXTURE_EXTRACTION: ExtractionResult = {
  title: 'Use Redis for session storage',
  decision: 'Move session storage from the in-process cache to Redis.',
  reasoning: 'In-memory sessions are lost on every deploy; Redis provides persistence and TTLs.',
  alternatives: [
    { option: 'Memcached', why_rejected: 'No persistence.' },
    { option: 'Sticky sessions', why_rejected: 'Does not survive instance loss.' },
  ],
  confidence: 0.95,
  entities: [
    { kind: 'technology', name: 'Redis', description: 'In-memory data store used for sessions' },
    { kind: 'component', name: 'session service', description: null },
  ],
  relationships: [
    {
      source: { kind: 'component', name: 'session service' },
      target: { kind: 'technology', name: 'Redis' },
      relation: 'uses',
    },
  ],
};
```

- [ ] **Step 2: Write the failing tests**

`tests/extract.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { relatedKey, candidatePairs } from '../src/commands/extract';
import { FIXTURE_ITEMS } from './fixtures/extraction';

describe('relatedKey', () => {
  it('extracts the PR number from a PR source_url', () => {
    expect(relatedKey(FIXTURE_ITEMS[0])).toBe('42');
  });
  it('extracts a referenced PR number from a commit title', () => {
    expect(relatedKey(FIXTURE_ITEMS[2])).toBe('42');
  });
  it('returns null when nothing is referenced', () => {
    expect(relatedKey(FIXTURE_ITEMS[1])).toBeNull();
  });
});

describe('candidatePairs', () => {
  const e = (id: string, kind: string, canonical_name: string) => ({ id, kind, canonical_name });
  it('pairs same-kind entities where one name contains the other', () => {
    const pairs = candidatePairs([e('1', 'component', 'session service'), e('2', 'component', 'session')]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ aId: '1', bId: '2' });
  });
  it('pairs same-kind entities sharing a word longer than 3 chars', () => {
    const pairs = candidatePairs([e('1', 'service', 'auth service'), e('2', 'service', 'auth api')]);
    expect(pairs).toHaveLength(1);
  });
  it('never pairs across kinds', () => {
    const pairs = candidatePairs([e('1', 'technology', 'redis'), e('2', 'component', 'redis client')]);
    expect(pairs).toHaveLength(0);
  });
  it('ignores short shared words', () => {
    const pairs = candidatePairs([e('1', 'feature', 'new ui'), e('2', 'feature', 'new billing')]);
    expect(pairs).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/extract.test.ts`
Expected: FAIL — cannot find module `../src/commands/extract`.

- [ ] **Step 4: Implement `src/commands/extract.ts`**

Implement per the pipeline behavior above. Skeleton with the exported pure helpers in full and the orchestration structure:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { classifyBatch, deepExtract, judgeDuplicates, ClassifyInput } from '../lib/anthropic';
import {
  fetchPendingItems, insertDecision, listEntities, mergeEntities,
  setExtractionStatus, upsertEdge, upsertEntity, PendingItem,
} from '../lib/graph';
import { embed } from '../lib/embeddings';
import { canonicalizeName } from '../lib/normalize';
import { getSupabaseClient } from '../lib/supabase';
import { parseRepoUrl } from '../lib/github';
import { loadLastRepo } from '../lib/state';
import { validateEnv } from '../lib/env';
import { logError, logInfo, logSuccess, logWarn } from '../lib/log';
import type { EntityKind } from '../types';

const PAGE_SIZE = 200;
const BATCH_SIZE = 20;
const MAX_JUDGE_PAIRS = 40;

export interface ExtractOptions {
  repo?: string;
}

/** PR number this item belongs to (PR url or "#123" in a commit title), or null. */
export function relatedKey(item: { type: string; source_url: string; title: string }): string | null {
  if (item.type === 'pr') {
    const m = item.source_url.match(/\/pull\/(\d+)/);
    return m ? m[1] : null;
  }
  const m = item.title.match(/#(\d+)/);
  return m ? m[1] : null;
}

/** Same-kind entity pairs that are plausible duplicates (substring or shared word > 3 chars). */
export function candidatePairs(
  entities: { id: string; kind: string; canonical_name: string }[]
): { aId: string; bId: string; kind: string; a: string; b: string }[] {
  const pairs: { aId: string; bId: string; kind: string; a: string; b: string }[] = [];
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];
      if (a.kind !== b.kind || a.canonical_name === b.canonical_name) continue;
      const substring = a.canonical_name.includes(b.canonical_name) || b.canonical_name.includes(a.canonical_name);
      const wordsA = new Set(a.canonical_name.split(' ').filter((w) => w.length > 3));
      const sharedWord = b.canonical_name.split(' ').some((w) => w.length > 3 && wordsA.has(w));
      if (substring || sharedWord) {
        pairs.push({ aId: a.id, bId: b.id, kind: a.kind, a: a.canonical_name, b: b.canonical_name });
      }
    }
  }
  return pairs;
}

// ---------- orchestration ----------

interface RunCounters {
  classified: number;
  skipped: number;
  decisions: number;
  failed: number;
  entities: Set<string>;
}

function toClassifyInput(item: PendingItem): ClassifyInput {
  return { id: item.id, type: item.type, title: item.title, body: item.body };
}

function exitIfRateLimited(err: unknown): void {
  if (err instanceof Anthropic.APIError && err.status === 429) {
    logError('Anthropic rate limit hit — re-run `brain extract` to resume where you left off.');
    process.exit(1);
  }
}

/** Titles of other items referencing the same PR number, as bullet lines. */
async function fetchRelatedContext(repoUrl: string, item: PendingItem): Promise<string> {
  const key = relatedKey(item);
  if (!key) return '';
  const supabase = getSupabaseClient();
  const { data } = await supabase
    .from('indexed_items')
    .select('type, title')
    .eq('repo_url', repoUrl)
    .neq('id', item.id)
    .ilike('title', `%#${key}%`)
    .limit(5);
  return (data ?? []).map((r: { type: string; title: string }) => `- (${r.type}) ${r.title}`).join('\n');
}

/** Upserts each mention; returns `${kind}:${canonical}` -> entity id for edge wiring. */
async function upsertItemEntities(
  repoUrl: string,
  item: PendingItem,
  mentions: { kind: EntityKind; name: string; description?: string | null }[],
  counters: RunCounters
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  for (const m of mentions) {
    const { id, error } = await upsertEntity({
      repo_url: repoUrl,
      kind: m.kind,
      name: m.name,
      description: m.description ?? null,
      first_seen: item.created_at,
      last_seen: item.created_at,
    });
    if (error || !id) {
      logError(`Failed to store entity "${m.name}": ${error}`);
      continue;
    }
    counters.entities.add(id);
    byKey.set(`${m.kind}:${canonicalizeName(m.name)}`, id);
  }
  return byKey;
}

/** Author -> person entity, plus works_on (person->entity) or decided_by (entity->person) edges. */
async function seedAuthor(
  repoUrl: string,
  item: PendingItem,
  targetIds: string[],
  relation: 'works_on' | 'decided_by',
  counters: RunCounters
): Promise<void> {
  if (!item.author) return;
  const { id: personId, error } = await upsertEntity({
    repo_url: repoUrl,
    kind: 'person',
    name: item.author,
    description: null,
    first_seen: item.created_at,
    last_seen: item.created_at,
  });
  if (error || !personId) {
    logError(`Failed to store person "${item.author}": ${error}`);
    return;
  }
  counters.entities.add(personId);
  for (const targetId of targetIds) {
    if (targetId === personId) continue;
    const ends =
      relation === 'works_on'
        ? { source_id: personId, target_id: targetId }
        : { source_id: targetId, target_id: personId };
    const { error: edgeError } = await upsertEdge({
      repo_url: repoUrl,
      ...ends,
      relation,
      evidence_item_ids: [item.id],
    });
    if (edgeError) logError(`Failed to store ${relation} edge: ${edgeError}`);
  }
}

async function processDecisionItem(repoUrl: string, item: PendingItem, counters: RunCounters): Promise<void> {
  let extraction;
  try {
    const related = await fetchRelatedContext(repoUrl, item);
    extraction = await deepExtract(toClassifyInput(item), related);
  } catch (err) {
    exitIfRateLimited(err);
    logError(`Extraction failed for "${item.title}": ${(err as Error).message}`);
    await setExtractionStatus([item.id], 'failed');
    counters.failed++;
    return;
  }
  if (!extraction) {
    logWarn(`Extraction refused for "${item.title}" — marking failed.`);
    await setExtractionStatus([item.id], 'failed');
    counters.failed++;
    return;
  }

  const entityIds = await upsertItemEntities(repoUrl, item, extraction.entities, counters);

  for (const rel of extraction.relationships) {
    const sourceId = entityIds.get(`${rel.source.kind}:${canonicalizeName(rel.source.name)}`);
    const targetId = entityIds.get(`${rel.target.kind}:${canonicalizeName(rel.target.name)}`);
    if (!sourceId || !targetId || sourceId === targetId) continue; // relationship names an entity that failed to store
    const { error } = await upsertEdge({
      repo_url: repoUrl,
      source_id: sourceId,
      target_id: targetId,
      relation: rel.relation,
      evidence_item_ids: [item.id],
    });
    if (error) logError(`Failed to store ${rel.relation} edge: ${error}`);
  }

  await seedAuthor(repoUrl, item, [...entityIds.values()], 'decided_by', counters);

  let embedding: number[];
  try {
    embedding = await embed(`${extraction.title}\n${extraction.decision}\n${extraction.reasoning ?? ''}`);
  } catch (err) {
    logError(`OpenAI API error while embedding decision "${extraction.title}": ${(err as Error).message}`);
    process.exit(1);
  }

  const { error: decisionError } = await insertDecision({
    repo_url: repoUrl,
    title: extraction.title,
    decision: extraction.decision,
    reasoning: extraction.reasoning,
    alternatives: extraction.alternatives,
    author: item.author,
    decided_at: item.created_at,
    confidence: extraction.confidence,
    evidence_item_ids: [item.id],
    embedding,
  });
  if (decisionError) {
    logError(`Failed to store decision "${extraction.title}": ${decisionError}`);
    await setExtractionStatus([item.id], 'failed');
    counters.failed++;
    return;
  }

  await setExtractionStatus([item.id], 'extracted');
  counters.decisions++;
  logInfo(`  Extracted decision: "${extraction.title}"`);
}

async function dedupEntities(repoUrl: string): Promise<void> {
  const { data: allEntities, error } = await listEntities(repoUrl);
  if (error) {
    logWarn(`Skipping dedup pass: could not list entities: ${error}`);
    return;
  }
  const pairs = candidatePairs(
    allEntities
      .filter((e): e is typeof e & { id: string } => Boolean(e.id))
      .map((e) => ({ id: e.id, kind: e.kind, canonical_name: e.canonical_name }))
  ).slice(0, MAX_JUDGE_PAIRS);
  if (pairs.length === 0) return;

  let verdicts: boolean[];
  try {
    verdicts = await judgeDuplicates(pairs.map((p) => ({ kind: p.kind, a: p.a, b: p.b })));
  } catch (err) {
    logWarn(`Skipping dedup pass: duplicate judging failed: ${(err as Error).message}`);
    return;
  }

  const merged = new Set<string>();
  for (const [i, same] of verdicts.entries()) {
    if (!same) continue;
    const p = pairs[i];
    if (merged.has(p.aId) || merged.has(p.bId)) continue; // already consumed by an earlier merge
    const keepId = p.a.length <= p.b.length ? p.aId : p.bId;
    const dropId = keepId === p.aId ? p.bId : p.aId;
    const { error: mergeError } = await mergeEntities(keepId, dropId);
    if (mergeError) {
      logWarn(`Could not merge "${p.a}" / "${p.b}": ${mergeError}`);
      continue;
    }
    merged.add(dropId);
    logInfo(`  Merged duplicate entities: "${p.a}" + "${p.b}"`);
  }
}

export async function extractCommand(options: ExtractOptions): Promise<void> {
  validateEnv();

  const repoUrlInput = options.repo ?? loadLastRepo();
  if (!repoUrlInput) {
    logError(
      'Error: no repo specified and none has been ingested yet. Run `brain ingest <github-repo-url>` first, or pass --repo <url>.'
    );
    process.exit(1);
  }

  try {
    const { canonicalUrl } = parseRepoUrl(repoUrlInput);
    const counters: RunCounters = { classified: 0, skipped: 0, decisions: 0, failed: 0, entities: new Set() };
    let processed = 0;

    logInfo('Extracting entities and decisions (Claude is called per batch/item, so this can take a while)...');

    while (true) {
      const { data: page, error } = await fetchPendingItems(canonicalUrl, PAGE_SIZE);
      if (error) {
        logError(`Error: could not fetch pending items: ${error}`);
        process.exit(1);
      }
      if (page.length === 0) break;

      for (let start = 0; start < page.length; start += BATCH_SIZE) {
        const batch = page.slice(start, start + BATCH_SIZE);

        let results;
        try {
          results = await classifyBatch(batch.map(toClassifyInput));
        } catch (err) {
          exitIfRateLimited(err);
          logError(`Classification failed for a batch of ${batch.length}: ${(err as Error).message}`);
          await setExtractionStatus(batch.map((b) => b.id), 'failed');
          counters.failed += batch.length;
          continue;
        }

        const skippedIds: string[] = [];
        const classifiedIds: string[] = [];
        const decisionItems: PendingItem[] = [];

        for (const [i, item] of batch.entries()) {
          const result = results[i];
          if (result.is_trivial) {
            skippedIds.push(item.id);
            continue;
          }
          if (result.is_decision_bearing) {
            decisionItems.push(item);
            continue;
          }
          classifiedIds.push(item.id);
          const entityIds = await upsertItemEntities(canonicalUrl, item, result.entity_mentions, counters);
          await seedAuthor(canonicalUrl, item, [...entityIds.values()], 'works_on', counters);
        }

        const { error: skipError } = await setExtractionStatus(skippedIds, 'skipped');
        if (skipError) logError(`Failed to mark items skipped: ${skipError}`);
        const { error: classifyError } = await setExtractionStatus(classifiedIds, 'classified');
        if (classifyError) logError(`Failed to mark items classified: ${classifyError}`);
        counters.skipped += skippedIds.length;
        counters.classified += classifiedIds.length;

        for (const item of decisionItems) {
          await processDecisionItem(canonicalUrl, item, counters);
        }

        processed += batch.length;
        if (processed % 20 === 0) logInfo(`  ${processed} items processed...`);
      }
    }

    if (processed === 0) {
      logSuccess('Nothing to extract — all items are already processed. Run `brain ingest` to fetch new items.');
      return;
    }

    logInfo('Linking pass: checking for duplicate entities...');
    await dedupEntities(canonicalUrl);

    logSuccess(
      `Extract complete: ${counters.classified} classified, ${counters.skipped} skipped, ` +
        `${counters.decisions} decisions, ${counters.entities.size} entities touched, ${counters.failed} failed`
    );
  } catch (err) {
    exitIfRateLimited(err);
    logError(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
```

- [ ] **Step 5: Register the command in `src/index.ts`**

After the `ask` command registration, add:

```typescript
program
  .command('extract')
  .description('Extract entities, relationships, and decisions from ingested items (run after ingest)')
  .option('--repo <url>', 'GitHub repo URL to extract (defaults to the last ingested repo)')
  .action(async (opts: { repo?: string }) => {
    const { extractCommand } = await import('./commands/extract');
    await extractCommand({ repo: opts.repo });
  });
```

(Static `import { extractCommand } from './commands/extract';` at the top is also fine — match the existing static-import style used for the other commands.)

- [ ] **Step 6: Run all tests + build**

Run: `npm test && npm run build`
Expected: all tests pass (normalize 5, anthropic 6, graph 4, extract 7); build exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/commands/extract.ts src/index.ts tests/extract.test.ts tests/fixtures/extraction.ts
git commit -m "feat: brain extract — classify, deep-extract, link/dedup pipeline"
```

---

### Task 7: `brain ask` upgrade — decisions search + Claude answers

**Files:**
- Modify: `src/commands/ask.ts`
- Delete: `src/lib/llm.ts`
- Test: `tests/ask.test.ts`

**Interfaces:**
- Consumes: `answerWithClaude` (Task 4); `searchSimilarDecisions`, `fetchItemSourceUrls` (Task 5); existing `embed`, `searchSimilarItems`, `loadLastRepo`, `parseRepoUrl`, `validateEnv`, log helpers; `MatchedItem`, `MatchedDecision` types.
- Produces: `askCommand` (same signature as today); exported pure helper (unit-tested): `buildContext(items: MatchedItem[], decisions: MatchedDecision[]): { context: string; ordered: { kind: 'item' | 'decision'; similarity: number }[] }`.

**Behavior changes (everything else — repo resolution, RELEVANCE_FLOOR, NOT_ENOUGH_CONTEXT message + suppressed sources, error style — stays exactly as it is today):**
1. After embedding the question, run **two** searches: `searchSimilarItems(repo, emb, 5)` and `searchSimilarDecisions(repo, emb, 3)`.
2. A decisions-search error is a warning, not fatal (`logWarn` + treat as zero decisions) — the decisions table may not exist yet if the user hasn't run the migration; items-search errors stay fatal.
3. Filter both lists by `RELEVANCE_FLOOR` (0.15). If both are empty → existing NOT_ENOUGH_CONTEXT path.
4. Build context with `buildContext`: decisions first (they're structured, higher-signal), then items, each numbered sequentially. Decision block format:

```
[N] (decision, similarity 0.72) Use Redis for session storage
Decision: Move session storage from the in-process cache to Redis.
Reasoning: In-memory sessions are lost on every deploy.
Alternatives considered: Memcached (No persistence.); Sticky sessions (Does not survive instance loss.)
Author: alice
```

   Item block format is unchanged from today's `ask.ts`.
5. Call `answerWithClaude(question, context)` instead of the old `answer(...)`.
6. Sources: item source_urls as today, plus for each surviving decision resolve `evidence_item_ids` via `fetchItemSourceUrls` and print those URLs (deduped against the item URLs).
7. Delete `src/lib/llm.ts` and its import.

- [ ] **Step 1: Write the failing tests**

`tests/ask.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildContext } from '../src/commands/ask';
import type { MatchedDecision, MatchedItem } from '../src/types';

const item: MatchedItem = {
  id: 'i1',
  type: 'pr',
  source_url: 'https://github.com/acme/shop/pull/42',
  title: 'Switch session storage to Redis',
  body: 'Moves sessions to Redis.',
  similarity: 0.41,
};

const decision: MatchedDecision = {
  id: 'd1',
  title: 'Use Redis for session storage',
  decision: 'Move session storage from the in-process cache to Redis.',
  reasoning: 'In-memory sessions are lost on every deploy.',
  alternatives: [{ option: 'Memcached', why_rejected: 'No persistence.' }],
  author: 'alice',
  evidence_item_ids: ['i1'],
  similarity: 0.72,
};

describe('buildContext', () => {
  it('puts decisions before items and numbers sequentially', () => {
    const { context } = buildContext([item], [decision]);
    expect(context.indexOf('[1] (decision')).toBeGreaterThanOrEqual(0);
    expect(context.indexOf('[2] (pr')).toBeGreaterThan(context.indexOf('[1] (decision'));
  });
  it('includes decision structure', () => {
    const { context } = buildContext([], [decision]);
    expect(context).toContain('Decision: Move session storage');
    expect(context).toContain('Alternatives considered: Memcached (No persistence.)');
    expect(context).toContain('Author: alice');
  });
  it('omits empty sections gracefully', () => {
    const bare: MatchedDecision = { ...decision, reasoning: null, alternatives: [], author: null };
    const { context } = buildContext([], [bare]);
    expect(context).not.toContain('Reasoning:');
    expect(context).not.toContain('Alternatives considered:');
    expect(context).not.toContain('Author:');
  });
  it('works with items only', () => {
    const { context } = buildContext([item], []);
    expect(context).toContain('[1] (pr, similarity 0.41)');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/ask.test.ts`
Expected: FAIL — `buildContext` is not exported.

- [ ] **Step 3: Rewrite `src/commands/ask.ts`**

```typescript
import chalk from 'chalk';
import { embed } from '../lib/embeddings';
import { answerWithClaude } from '../lib/anthropic';
import { searchSimilarItems } from '../lib/supabase';
import { fetchItemSourceUrls, searchSimilarDecisions } from '../lib/graph';
import { loadLastRepo } from '../lib/state';
import { validateEnv } from '../lib/env';
import { parseRepoUrl } from '../lib/github';
import { logError, logWarn } from '../lib/log';
import type { MatchedDecision, MatchedItem } from '../types';

export interface AskOptions {
  repo?: string;
}

const NOT_ENOUGH_CONTEXT_MESSAGE = 'Not enough context in indexed data to answer this confidently.';
const ITEM_MATCH_COUNT = 5;
const DECISION_MATCH_COUNT = 3;
// See DECISIONS.md #4: absolute similarity is not a reliable relevance signal;
// this floor only filters near-zero noise — the LLM judges actual relevance.
const RELEVANCE_FLOOR = 0.15;

/** Numbered context: structured decisions first, then raw PR/commit items. */
export function buildContext(
  items: MatchedItem[],
  decisions: MatchedDecision[]
): { context: string; ordered: { kind: 'item' | 'decision'; similarity: number }[] } {
  const blocks: string[] = [];
  const ordered: { kind: 'item' | 'decision'; similarity: number }[] = [];
  let n = 0;

  for (const d of decisions) {
    n++;
    ordered.push({ kind: 'decision', similarity: d.similarity });
    const lines = [`[${n}] (decision, similarity ${d.similarity.toFixed(2)}) ${d.title}`, `Decision: ${d.decision}`];
    if (d.reasoning) lines.push(`Reasoning: ${d.reasoning}`);
    if (d.alternatives.length > 0) {
      lines.push(
        `Alternatives considered: ${d.alternatives.map((a) => `${a.option} (${a.why_rejected})`).join('; ')}`
      );
    }
    if (d.author) lines.push(`Author: ${d.author}`);
    blocks.push(lines.join('\n'));
  }

  for (const m of items) {
    n++;
    ordered.push({ kind: 'item', similarity: m.similarity });
    blocks.push(
      `[${n}] (${m.type}, similarity ${m.similarity.toFixed(2)}) ${m.title}\n${m.body}\nSource: ${m.source_url}`
    );
  }

  return { context: blocks.join('\n\n'), ordered };
}

export async function askCommand(question: string, options: AskOptions): Promise<void> {
  validateEnv();

  const repoUrlInput = options.repo ?? loadLastRepo();
  if (!repoUrlInput) {
    logError(
      'Error: no repo specified and none has been ingested yet. Run `brain ingest <github-repo-url>` first, or pass --repo <url>.'
    );
    process.exit(1);
  }

  try {
    const { canonicalUrl } = parseRepoUrl(repoUrlInput);
    const questionEmbedding = await embed(question);

    const [itemResult, decisionResult] = await Promise.all([
      searchSimilarItems(canonicalUrl, questionEmbedding, ITEM_MATCH_COUNT),
      searchSimilarDecisions(canonicalUrl, questionEmbedding, DECISION_MATCH_COUNT),
    ]);
    if (itemResult.error) {
      logError(`Error: vector search failed: ${itemResult.error}`);
      process.exit(1);
    }
    if (decisionResult.error) {
      // decisions table may not exist yet (migration not run) — degrade to items-only
      logWarn(`Warning: decision search unavailable (${decisionResult.error}); answering from PRs/commits only.`);
    }

    const relevantItems = itemResult.data.filter((m) => m.similarity >= RELEVANCE_FLOOR);
    const relevantDecisions = (decisionResult.error ? [] : decisionResult.data).filter(
      (d) => d.similarity >= RELEVANCE_FLOOR
    );

    if (relevantItems.length === 0 && relevantDecisions.length === 0) {
      logWarn(NOT_ENOUGH_CONTEXT_MESSAGE);
      return;
    }

    const { context } = buildContext(relevantItems, relevantDecisions);
    const responseText = await answerWithClaude(question, context);
    console.log(responseText);

    if (!responseText.includes(NOT_ENOUGH_CONTEXT_MESSAGE)) {
      const urls = new Set<string>(relevantItems.map((m) => m.source_url));
      const evidenceIds = relevantDecisions.flatMap((d) => d.evidence_item_ids);
      const evidenceUrls = await fetchItemSourceUrls(evidenceIds);
      for (const url of evidenceUrls.values()) urls.add(url);

      console.log('');
      console.log(chalk.cyan('Sources:'));
      for (const url of urls) {
        console.log(chalk.blue(`- ${url}`));
      }
    }
  } catch (err) {
    logError(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Delete `src/lib/llm.ts`**

```bash
git rm src/lib/llm.ts
```

- [ ] **Step 5: Run all tests + build**

Run: `npm test && npm run build`
Expected: all suites pass; build exit 0 (build failure here usually means a leftover import of `../lib/llm`).

- [ ] **Step 6: Manual spot-check (needs a previously ingested repo + migration run)**

Run: `node dist/index.js ask "why does this project exist?"`
Expected: an answer or the not-enough-context message — no stack trace; if the migration hasn't been run, the decisions-search warning appears and the command still answers.

- [ ] **Step 7: Commit**

```bash
git add src/commands/ask.ts tests/ask.test.ts
git commit -m "feat: ask searches decisions + answers with Claude Fable"
```

---

### Task 8: Web app scaffold + API routes (`/web`)

**Files:**
- Create: `web/` (Next.js 14 app scaffold via create-next-app)
- Create: `web/lib/supabase.ts`, `web/lib/repo.ts`
- Create: `web/app/api/stats/route.ts`, `web/app/api/graph/route.ts`, `web/app/api/decisions/route.ts`, `web/app/api/decisions/[id]/route.ts`

**Interfaces:**
- Consumes: the same Supabase project via env vars `SUPABASE_URL` / `SUPABASE_ANON_KEY`, and `BRAIN_REPO_URL` (injected by `brain serve` in Task 11; for standalone `next dev`, put all three in `web/.env.local`).
- Produces (consumed by pages in Tasks 9-10):
  - `GET /api/stats` → `{ repo: string; items: { total: number; pending: number; extracted: number; skipped: number; failed: number; classified: number }; decisions: number; entities: number; topEntities: { id: string; name: string; kind: string; weight: number }[]; recentDecisions: { id: string; title: string; author: string | null; decided_at: string | null }[] }`
  - `GET /api/graph` → `{ nodes: { id: string; name: string; kind: string }[]; links: { source: string; target: string; relation: string; weight: number }[] }`
  - `GET /api/decisions` → `{ decisions: { id: string; title: string; author: string | null; decided_at: string | null; confidence: number | null }[] }`
  - `GET /api/decisions/:id` → full decision row + `evidence: { id: string; source_url: string; title: string }[]`
  - All accept `?repo=<url>` override; default is `BRAIN_REPO_URL`.

**No auth, localhost only, dev mode only (per spec).** API routes are server-side (Node runtime) — the anon key never ships to the browser as NEXT_PUBLIC.

- [ ] **Step 1: Scaffold the app**

```bash
npx create-next-app@14 web --typescript --eslint --app --no-src-dir --no-tailwind --import-alias "@/*" --use-npm
cd web && npm install @supabase/supabase-js @anthropic-ai/sdk && cd ..
```

Expected: `web/` exists with `app/`, `package.json`, its own `tsconfig.json` and `.gitignore` (covering `node_modules` and `.next`).

- [ ] **Step 2: Create `web/lib/supabase.ts` and `web/lib/repo.ts`**

`web/lib/supabase.ts`:

```typescript
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not set — start via `brain serve` or add web/.env.local');
  }
  if (!client) {
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
  return client;
}
```

`web/lib/repo.ts`:

```typescript
import { NextRequest } from 'next/server';

/** Repo scope for a request: ?repo= override, else the repo `brain serve` was started for. */
export function resolveRepo(request: NextRequest): string | null {
  return request.nextUrl.searchParams.get('repo') ?? process.env.BRAIN_REPO_URL ?? null;
}

export function repoError(): Response {
  return Response.json(
    { error: 'No repo in scope. Start the dashboard with `brain serve` after ingesting, or pass ?repo=<url>.' },
    { status: 400 }
  );
}
```

- [ ] **Step 3: Create `web/app/api/stats/route.ts`**

```typescript
import { NextRequest } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { resolveRepo, repoError } from '@/lib/repo';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const repo = resolveRepo(request);
  if (!repo) return repoError();
  const supabase = getSupabase();

  const statuses = ['pending', 'classified', 'extracted', 'skipped', 'failed'] as const;
  const counts: Record<string, number> = {};
  for (const status of statuses) {
    const { count } = await supabase
      .from('indexed_items')
      .select('*', { count: 'exact', head: true })
      .eq('repo_url', repo)
      .eq('extraction_status', status);
    counts[status] = count ?? 0;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const [{ count: decisions }, { count: entities }] = await Promise.all([
    supabase.from('decisions').select('*', { count: 'exact', head: true }).eq('repo_url', repo),
    supabase.from('entities').select('*', { count: 'exact', head: true }).eq('repo_url', repo),
  ]);

  // Top entities by summed edge weight (source or target side).
  const { data: edges } = await supabase
    .from('edges')
    .select('source_id, target_id, weight')
    .eq('repo_url', repo);
  const weightById = new Map<string, number>();
  for (const e of edges ?? []) {
    weightById.set(e.source_id, (weightById.get(e.source_id) ?? 0) + e.weight);
    weightById.set(e.target_id, (weightById.get(e.target_id) ?? 0) + e.weight);
  }
  const topIds = [...weightById.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const { data: topRows } = topIds.length
    ? await supabase.from('entities').select('id, name, kind').in('id', topIds.map(([id]) => id))
    : { data: [] };
  const topEntities = topIds
    .map(([id, weight]) => {
      const row = (topRows ?? []).find((r) => r.id === id);
      return row ? { id, name: row.name, kind: row.kind, weight } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const { data: recentDecisions } = await supabase
    .from('decisions')
    .select('id, title, author, decided_at')
    .eq('repo_url', repo)
    .order('created_at', { ascending: false })
    .limit(5);

  return Response.json({
    repo,
    items: { total, ...counts },
    decisions: decisions ?? 0,
    entities: entities ?? 0,
    topEntities,
    recentDecisions: recentDecisions ?? [],
  });
}
```

- [ ] **Step 4: Create `web/app/api/graph/route.ts`**

```typescript
import { NextRequest } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { resolveRepo, repoError } from '@/lib/repo';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const repo = resolveRepo(request);
  if (!repo) return repoError();
  const supabase = getSupabase();

  const [{ data: entities, error: e1 }, { data: edges, error: e2 }] = await Promise.all([
    supabase.from('entities').select('id, name, kind').eq('repo_url', repo),
    supabase.from('edges').select('source_id, target_id, relation, weight, evidence_item_ids').eq('repo_url', repo),
  ]);
  if (e1 || e2) return Response.json({ error: (e1 ?? e2)!.message }, { status: 500 });

  // Resolve edge evidence ids -> GitHub source URLs so the side panel can link to them.
  const evidenceIds = [...new Set((edges ?? []).flatMap((e) => e.evidence_item_ids ?? []))];
  const { data: evidenceRows } = evidenceIds.length
    ? await supabase.from('indexed_items').select('id, source_url').in('id', evidenceIds)
    : { data: [] };
  const urlById = new Map((evidenceRows ?? []).map((r) => [r.id, r.source_url]));

  return Response.json({
    nodes: (entities ?? []).map((e) => ({ id: e.id, name: e.name, kind: e.kind })),
    links: (edges ?? []).map((e) => ({
      source: e.source_id,
      target: e.target_id,
      relation: e.relation,
      weight: e.weight,
      evidence_urls: (e.evidence_item_ids ?? [])
        .map((id: string) => urlById.get(id))
        .filter((u: string | undefined): u is string => Boolean(u)),
    })),
  });
}
```

- [ ] **Step 5: Create the decisions routes**

`web/app/api/decisions/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { resolveRepo, repoError } from '@/lib/repo';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const repo = resolveRepo(request);
  if (!repo) return repoError();
  const { data, error } = await getSupabase()
    .from('decisions')
    .select('id, title, author, decided_at, confidence')
    .eq('repo_url', repo)
    .order('decided_at', { ascending: false, nullsFirst: false });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ decisions: data ?? [] });
}
```

`web/app/api/decisions/[id]/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = getSupabase();
  const { data: decision, error } = await supabase
    .from('decisions')
    .select('id, repo_url, title, decision, reasoning, alternatives, author, decided_at, confidence, evidence_item_ids')
    .eq('id', params.id)
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!decision) return Response.json({ error: 'Decision not found' }, { status: 404 });

  const ids: string[] = decision.evidence_item_ids ?? [];
  const { data: evidence } = ids.length
    ? await supabase.from('indexed_items').select('id, source_url, title').in('id', ids)
    : { data: [] };

  return Response.json({ ...decision, evidence: evidence ?? [] });
}
```

- [ ] **Step 6: Verify the API boots**

```bash
cd web && SUPABASE_URL=$(grep '^SUPABASE_URL=' ../.env | cut -d= -f2-) \
  SUPABASE_ANON_KEY=$(grep '^SUPABASE_ANON_KEY=' ../.env | cut -d= -f2-) \
  BRAIN_REPO_URL=placeholder npm run dev &
sleep 8
curl -s http://localhost:3000/api/stats | head -c 300
kill %1
```

Expected: JSON (zero counts are fine for a placeholder repo), not an HTML error page.

- [ ] **Step 7: Commit**

```bash
git add web
git commit -m "feat: Next.js dashboard scaffold + stats/graph/decisions API routes"
```

(Verify `git status` shows no `web/node_modules` or `web/.next` staged — create-next-app's `web/.gitignore` should cover both.)

---

### Task 9: Dashboard pages — layout, Overview, Decisions

**Files:**
- Modify: `web/app/layout.tsx`, `web/app/globals.css` (replace scaffold boilerplate)
- Modify: `web/app/page.tsx` (Overview)
- Create: `web/app/decisions/page.tsx`, `web/app/decisions/[id]/page.tsx`

**Interfaces:**
- Consumes: `/api/stats`, `/api/decisions`, `/api/decisions/:id` (Task 8).
- Produces: nav layout with links Overview `/` · Graph `/graph` · Decisions `/decisions` · Ask `/ask` (Graph and Ask 404 until Task 10 — fine).

All pages are **server components** fetching from the API routes with `cache: 'no-store'` so the dashboard always shows current data. Keep styling minimal: one dark-neutral inline design system in `globals.css` (system font stack, max-width container, simple card class) — no Tailwind, no component library.

- [ ] **Step 1: Replace `web/app/layout.tsx`**

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Engineering Brain',
  description: 'Knowledge graph and decisions for your repo',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="nav">
          <span className="brand">🧠 Engineering Brain</span>
          <nav>
            <Link href="/">Overview</Link>
            <Link href="/graph">Graph</Link>
            <Link href="/decisions">Decisions</Link>
            <Link href="/ask">Ask</Link>
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Replace `web/app/globals.css`**

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #0f1115; color: #e6e8ee; }
a { color: #7aa2f7; text-decoration: none; }
a:hover { text-decoration: underline; }
.nav { display: flex; align-items: center; gap: 2rem; padding: 1rem 2rem; border-bottom: 1px solid #23262f; }
.nav .brand { font-weight: 700; }
.nav nav { display: flex; gap: 1.25rem; }
.container { max-width: 960px; margin: 0 auto; padding: 2rem; }
h1 { font-size: 1.5rem; margin-bottom: 1rem; }
h2 { font-size: 1.1rem; margin: 1.5rem 0 0.75rem; color: #a9b1c6; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; }
.card { background: #161922; border: 1px solid #23262f; border-radius: 8px; padding: 1rem; }
.card .num { font-size: 1.6rem; font-weight: 700; }
.card .label { color: #a9b1c6; font-size: 0.85rem; }
.list { display: flex; flex-direction: column; gap: 0.5rem; }
.row { background: #161922; border: 1px solid #23262f; border-radius: 8px; padding: 0.75rem 1rem; }
.muted { color: #8a91a5; font-size: 0.85rem; }
.kind { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 99px; font-size: 0.75rem; background: #23262f; margin-right: 0.5rem; }
.error { color: #f7768e; }
textarea, input { width: 100%; background: #161922; color: #e6e8ee; border: 1px solid #23262f; border-radius: 8px; padding: 0.75rem; font: inherit; }
button { background: #7aa2f7; color: #0f1115; border: 0; border-radius: 8px; padding: 0.6rem 1.2rem; font-weight: 600; cursor: pointer; margin-top: 0.75rem; }
button:disabled { opacity: 0.5; cursor: default; }
```

- [ ] **Step 3: Replace `web/app/page.tsx` (Overview)**

```tsx
const BASE = 'http://localhost:3000';

async function getStats() {
  const res = await fetch(`${BASE}/api/stats`, { cache: 'no-store' });
  if (!res.ok) throw new Error((await res.json()).error ?? 'stats failed');
  return res.json();
}

export default async function Overview() {
  let stats;
  try {
    stats = await getStats();
  } catch (err) {
    return <p className="error">Could not load stats: {(err as Error).message}</p>;
  }

  return (
    <>
      <h1>Overview</h1>
      <p className="muted">{stats.repo}</p>
      <h2>Indexed items</h2>
      <div className="cards">
        <div className="card"><div className="num">{stats.items.total}</div><div className="label">total</div></div>
        <div className="card"><div className="num">{stats.items.extracted}</div><div className="label">decisions extracted</div></div>
        <div className="card"><div className="num">{stats.items.classified}</div><div className="label">classified</div></div>
        <div className="card"><div className="num">{stats.items.pending}</div><div className="label">pending</div></div>
        <div className="card"><div className="num">{stats.entities}</div><div className="label">entities</div></div>
        <div className="card"><div className="num">{stats.decisions}</div><div className="label">decisions</div></div>
      </div>
      <h2>Recent decisions</h2>
      <div className="list">
        {stats.recentDecisions.length === 0 && <p className="muted">None yet — run `brain extract`.</p>}
        {stats.recentDecisions.map((d: { id: string; title: string; author: string | null; decided_at: string | null }) => (
          <a key={d.id} className="row" href={`/decisions/${d.id}`}>
            {d.title}
            <div className="muted">{d.author ?? 'unknown'}{d.decided_at ? ` · ${d.decided_at.slice(0, 10)}` : ''}</div>
          </a>
        ))}
      </div>
      <h2>Top entities</h2>
      <div className="list">
        {stats.topEntities.map((e: { id: string; name: string; kind: string; weight: number }) => (
          <div key={e.id} className="row">
            <span className="kind">{e.kind}</span>{e.name}
            <span className="muted"> · weight {e.weight}</span>
          </div>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 4: Create `web/app/decisions/page.tsx`**

```tsx
const BASE = 'http://localhost:3000';

export default async function Decisions() {
  const res = await fetch(`${BASE}/api/decisions`, { cache: 'no-store' });
  const data = await res.json();
  if (!res.ok) return <p className="error">{data.error}</p>;

  return (
    <>
      <h1>Decisions</h1>
      <div className="list">
        {data.decisions.length === 0 && <p className="muted">No decisions extracted yet — run `brain extract`.</p>}
        {data.decisions.map((d: { id: string; title: string; author: string | null; decided_at: string | null; confidence: number | null }) => (
          <a key={d.id} className="row" href={`/decisions/${d.id}`}>
            {d.title}
            <div className="muted">
              {d.author ?? 'unknown'}
              {d.decided_at ? ` · ${d.decided_at.slice(0, 10)}` : ''}
              {d.confidence != null ? ` · confidence ${(d.confidence * 100).toFixed(0)}%` : ''}
            </div>
          </a>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 5: Create `web/app/decisions/[id]/page.tsx`**

```tsx
const BASE = 'http://localhost:3000';

interface Alternative { option: string; why_rejected: string }
interface Evidence { id: string; source_url: string; title: string }

export default async function DecisionDetail({ params }: { params: { id: string } }) {
  const res = await fetch(`${BASE}/api/decisions/${params.id}`, { cache: 'no-store' });
  const d = await res.json();
  if (!res.ok) return <p className="error">{d.error}</p>;

  return (
    <>
      <h1>{d.title}</h1>
      <p className="muted">
        {d.author ?? 'unknown'}
        {d.decided_at ? ` · ${d.decided_at.slice(0, 10)}` : ''}
        {d.confidence != null ? ` · confidence ${(d.confidence * 100).toFixed(0)}%` : ''}
      </p>
      <h2>What was decided</h2>
      <div className="row">{d.decision}</div>
      {d.reasoning && (
        <>
          <h2>Why</h2>
          <div className="row">{d.reasoning}</div>
        </>
      )}
      {(d.alternatives ?? []).length > 0 && (
        <>
          <h2>Alternatives considered</h2>
          <div className="list">
            {d.alternatives.map((a: Alternative, i: number) => (
              <div key={i} className="row">
                <strong>{a.option}</strong>
                <div className="muted">{a.why_rejected}</div>
              </div>
            ))}
          </div>
        </>
      )}
      <h2>Evidence</h2>
      <div className="list">
        {(d.evidence ?? []).map((e: Evidence) => (
          <a key={e.id} className="row" href={e.source_url} target="_blank" rel="noreferrer">
            {e.title}
            <div className="muted">{e.source_url}</div>
          </a>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 6: Verify pages render**

Same env-injected `npm run dev` as Task 8 Step 6, then open `http://localhost:3000/` and `/decisions` in a browser (or `curl -s localhost:3000 | grep -c Overview`).
Expected: Overview renders cards (zeros are fine); `/decisions` renders the empty state; no hydration errors in the console. Also run `cd web && npx tsc --noEmit` — exit 0.

- [ ] **Step 7: Commit**

```bash
git add web/app
git commit -m "feat: dashboard overview + decisions pages"
```

---

### Task 10: Graph view + Ask page

**Files:**
- Create: `web/app/graph/page.tsx`, `web/app/graph/GraphView.tsx`
- Create: `web/app/api/ask/route.ts`, `web/app/ask/page.tsx`, `web/app/ask/AskForm.tsx`

**Interfaces:**
- Consumes: `/api/graph` (Task 8); Supabase RPCs `match_items` + `match_decisions`; env `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (available because `brain serve` inherits the CLI env).
- Produces: `POST /api/ask` with body `{ question: string }` → `{ answer: string; sources: string[] }`.

The ask route **mirrors** the CLI ask logic (Task 7) in the web package — `/web` is its own package and cannot import from `../src` without cross-package tsconfig surgery, which the spec doesn't ask for. Keep the two in sync when either changes (same floor, same system-prompt rules, same Fable call shape).

- [ ] **Step 1: Install the graph library**

```bash
cd web && npm install react-force-graph-2d && cd ..
```

- [ ] **Step 2: Create `web/app/graph/GraphView.tsx` (client component)**

```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

interface GraphNode { id: string; name: string; kind: string }
interface GraphLink { source: string; target: string; relation: string; weight: number; evidence_urls: string[] }

const KIND_COLORS: Record<string, string> = {
  person: '#f7768e',
  service: '#7aa2f7',
  component: '#9ece6a',
  technology: '#e0af68',
  feature: '#bb9af7',
};
const KINDS = Object.keys(KIND_COLORS);

export default function GraphView() {
  const [data, setData] = useState<{ nodes: GraphNode[]; links: GraphLink[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabledKinds, setEnabledKinds] = useState<Set<string>>(new Set(KINDS));
  const [selected, setSelected] = useState<GraphNode | null>(null);

  useEffect(() => {
    fetch('/api/graph')
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? 'graph fetch failed');
        setData(body);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const filtered = useMemo(() => {
    if (!data) return { nodes: [], links: [] };
    const nodes = data.nodes.filter((n) => enabledKinds.has(n.kind));
    const ids = new Set(nodes.map((n) => n.id));
    const links = data.links.filter((l) => ids.has(l.source) && ids.has(l.target));
    // react-force-graph mutates its input; hand it copies
    return { nodes: nodes.map((n) => ({ ...n })), links: links.map((l) => ({ ...l })) };
  }, [data, enabledKinds]);

  const selectedLinks = useMemo(() => {
    if (!data || !selected) return [];
    return data.links.filter((l) => l.source === selected.id || l.target === selected.id);
  }, [data, selected]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading graph…</p>;
  if (data.nodes.length === 0) return <p className="muted">No entities yet — run `brain extract`.</p>;

  const nameOf = (id: string) => data.nodes.find((n) => n.id === id)?.name ?? id;

  return (
    <div style={{ display: 'flex', gap: '1rem' }}>
      <div style={{ flex: 1, border: '1px solid #23262f', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '0.5rem 1rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          {KINDS.map((kind) => (
            <label key={kind} style={{ color: KIND_COLORS[kind], fontSize: '0.85rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={enabledKinds.has(kind)}
                onChange={() => {
                  const next = new Set(enabledKinds);
                  if (next.has(kind)) next.delete(kind);
                  else next.add(kind);
                  setEnabledKinds(next);
                }}
              />{' '}
              {kind}
            </label>
          ))}
        </div>
        <ForceGraph2D
          graphData={filtered}
          width={640}
          height={520}
          backgroundColor="#0f1115"
          nodeLabel={(n) => `${(n as GraphNode).name} (${(n as GraphNode).kind})`}
          nodeColor={(n) => KIND_COLORS[(n as GraphNode).kind] ?? '#8a91a5'}
          linkColor={() => '#3b4048'}
          linkWidth={(l) => Math.min(4, (l as GraphLink).weight)}
          onNodeClick={(n) => setSelected(n as GraphNode)}
        />
      </div>
      <aside style={{ width: 280 }}>
        {selected ? (
          <>
            <h2 style={{ marginTop: 0 }}>
              <span className="kind">{selected.kind}</span>
              {selected.name}
            </h2>
            <div className="list">
              {selectedLinks.map((l, i) => (
                <div key={i} className="row muted">
                  {nameOf(l.source)} —{l.relation}→ {nameOf(l.target)} (w{l.weight})
                  {l.evidence_urls.map((url) => (
                    <div key={url}>
                      <a href={url} target="_blank" rel="noreferrer">evidence ↗</a>
                    </div>
                  ))}
                </div>
              ))}
              {selectedLinks.length === 0 && <p className="muted">No edges.</p>}
            </div>
          </>
        ) : (
          <p className="muted">Click a node to see its connections.</p>
        )}
      </aside>
    </div>
  );
}
```

- [ ] **Step 3: Create `web/app/graph/page.tsx`**

```tsx
import GraphView from './GraphView';

export default function GraphPage() {
  return (
    <>
      <h1>Knowledge graph</h1>
      <GraphView />
    </>
  );
}
```

- [ ] **Step 4: Create `web/app/api/ask/route.ts`**

```typescript
import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabase } from '@/lib/supabase';
import { resolveRepo, repoError } from '@/lib/repo';

export const dynamic = 'force-dynamic';

// Mirrors src/commands/ask.ts — keep the two in sync.
const RELEVANCE_FLOOR = 0.15;
const NOT_ENOUGH = 'Not enough context in indexed data to answer this confidently.';
const ANSWER_SYSTEM =
  'You are an engineering assistant that explains why code changes were made, ' +
  'using only the provided context. Context items are PRs, commits, and extracted engineering decisions. ' +
  'Each item includes a cosine similarity score (0-1) — treat it as a weak, noisy signal, not proof of relevance. ' +
  'Extracted decisions are high-quality structured records: when one directly addresses the question, ground your answer in it. ' +
  'Answer in 2-5 sentences, but only if at least one context item directly and specifically addresses the question. ' +
  'Do not generalize from an item that only covers a narrow, tangential detail into a broader claim about the question. ' +
  'If the context items are only loosely related, or their similarity scores are all low and closely clustered with no clear standout, ' +
  `respond with exactly: "${NOT_ENOUGH}" Never invent information that is not in the context.`;

async function embed(text: string): Promise<number[]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 20000) || ' ' }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings API error (${res.status})`);
  return (await res.json()).data[0].embedding;
}

export async function POST(request: NextRequest) {
  const repo = resolveRepo(request);
  if (!repo) return repoError();
  const { question } = await request.json();
  if (!question || typeof question !== 'string') {
    return Response.json({ error: 'Missing question' }, { status: 400 });
  }

  try {
    const supabase = getSupabase();
    const emb = await embed(question);

    const [items, decisions] = await Promise.all([
      supabase.rpc('match_items', { query_embedding: emb, repo, match_count: 5 }),
      supabase.rpc('match_decisions', { query_embedding: emb, repo, match_count: 3 }),
    ]);
    const relevantItems = (items.data ?? []).filter((m: { similarity: number }) => m.similarity >= RELEVANCE_FLOOR);
    const relevantDecisions = (decisions.data ?? []).filter(
      (d: { similarity: number }) => d.similarity >= RELEVANCE_FLOOR
    );
    if (relevantItems.length === 0 && relevantDecisions.length === 0) {
      return Response.json({ answer: NOT_ENOUGH, sources: [] });
    }

    let n = 0;
    const blocks: string[] = [];
    for (const d of relevantDecisions) {
      n++;
      const lines = [`[${n}] (decision, similarity ${d.similarity.toFixed(2)}) ${d.title}`, `Decision: ${d.decision}`];
      if (d.reasoning) lines.push(`Reasoning: ${d.reasoning}`);
      if ((d.alternatives ?? []).length > 0) {
        lines.push(
          `Alternatives considered: ${d.alternatives
            .map((a: { option: string; why_rejected: string }) => `${a.option} (${a.why_rejected})`)
            .join('; ')}`
        );
      }
      if (d.author) lines.push(`Author: ${d.author}`);
      blocks.push(lines.join('\n'));
    }
    for (const m of relevantItems) {
      n++;
      blocks.push(`[${n}] (${m.type}, similarity ${m.similarity.toFixed(2)}) ${m.title}\n${m.body}\nSource: ${m.source_url}`);
    }

    const anthropic = new Anthropic();
    const response = await anthropic.beta.messages.create({
      model: 'claude-fable-5',
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-06-01'],
      fallbacks: [{ model: 'claude-opus-4-8' }],
      system: ANSWER_SYSTEM,
      messages: [{ role: 'user', content: `Question: ${question}\n\nContext:\n${blocks.join('\n\n')}` }],
    });
    if (response.stop_reason === 'refusal') {
      return Response.json({ error: 'Claude declined to answer this question.' }, { status: 502 });
    }
    const textBlock = response.content.find((b) => b.type === 'text');
    const answer = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : NOT_ENOUGH;

    const sources = new Set<string>(relevantItems.map((m: { source_url: string }) => m.source_url));
    const evidenceIds = relevantDecisions.flatMap((d: { evidence_item_ids: string[] }) => d.evidence_item_ids ?? []);
    if (evidenceIds.length > 0 && !answer.includes(NOT_ENOUGH)) {
      const { data: rows } = await supabase.from('indexed_items').select('source_url').in('id', evidenceIds);
      for (const row of rows ?? []) sources.add(row.source_url);
    }

    return Response.json({ answer, sources: answer.includes(NOT_ENOUGH) ? [] : [...sources] });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 5: Create `web/app/ask/AskForm.tsx` and `web/app/ask/page.tsx`**

`web/app/ask/AskForm.tsx`:

```tsx
'use client';

import { useState } from 'react';

export default function AskForm() {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim() || loading) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'ask failed');
      setAnswer(body.answer);
      setSources(body.sources ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <form onSubmit={submit}>
        <textarea
          rows={3}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Why was X built? Why did we choose Y?"
        />
        <button type="submit" disabled={loading || !question.trim()}>
          {loading ? 'Thinking…' : 'Ask'}
        </button>
      </form>
      {error && <p className="error" style={{ marginTop: '1rem' }}>{error}</p>}
      {answer && (
        <>
          <h2>Answer</h2>
          <div className="row" style={{ whiteSpace: 'pre-wrap' }}>{answer}</div>
          {sources.length > 0 && (
            <>
              <h2>Sources</h2>
              <div className="list">
                {sources.map((url) => (
                  <a key={url} className="row" href={url} target="_blank" rel="noreferrer">{url}</a>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
```

`web/app/ask/page.tsx`:

```tsx
import AskForm from './AskForm';

export default function AskPage() {
  return (
    <>
      <h1>Ask</h1>
      <AskForm />
    </>
  );
}
```

- [ ] **Step 6: Verify**

Boot dev server with env injected (Task 8 Step 6 pattern, plus `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from `../.env`). Open `/graph` (renders canvas or the empty state) and `/ask` (submit a question — answer or not-enough-context, and errors render in red, not as a crash). Then `cd web && npx tsc --noEmit` — exit 0.

- [ ] **Step 7: Commit**

```bash
git add web/app web/package.json web/package-lock.json
git commit -m "feat: graph view + ask page"
```

---

### Task 11: `brain serve` + README + end-to-end smoke

**Files:**
- Create: `src/commands/serve.ts`
- Modify: `src/index.ts` (register command)
- Modify: `README.md`

**Interfaces:**
- Consumes: `loadLastRepo`, `validateEnv`, log helpers; the `web/` app (Tasks 8-10).
- Produces: `serveCommand(options: { repo?: string; port?: string }): Promise<void>` — spawns the Next dev server with the CLI's env plus `BRAIN_REPO_URL` and `PORT`.

- [ ] **Step 1: Implement `src/commands/serve.ts`**

```typescript
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadLastRepo } from '../lib/state';
import { validateEnv } from '../lib/env';
import { parseRepoUrl } from '../lib/github';
import { logError, logInfo, logSuccess } from '../lib/log';

export interface ServeOptions {
  repo?: string;
  port?: string;
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  validateEnv();

  const repoUrlInput = options.repo ?? loadLastRepo();
  if (!repoUrlInput) {
    logError(
      'Error: no repo specified and none has been ingested yet. Run `brain ingest <github-repo-url>` first, or pass --repo <url>.'
    );
    process.exit(1);
  }

  let canonicalUrl: string;
  try {
    canonicalUrl = parseRepoUrl(repoUrlInput).canonicalUrl;
  } catch (err) {
    logError(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  // dist/commands -> project root/web
  const webDir = path.resolve(__dirname, '..', '..', 'web');
  if (!fs.existsSync(path.join(webDir, 'package.json'))) {
    logError(`Error: web app not found at ${webDir}. Reinstall or re-clone the repo.`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(webDir, 'node_modules'))) {
    logInfo('First run: installing web dependencies (npm install in /web)...');
    const install = spawn('npm', ['install'], { cwd: webDir, stdio: 'inherit' });
    const code = await new Promise<number>((resolve) => install.on('close', (c) => resolve(c ?? 1)));
    if (code !== 0) {
      logError('Error: npm install failed in /web.');
      process.exit(1);
    }
  }

  const port = options.port ?? '3000';
  logSuccess(`Dashboard for ${canonicalUrl}`);
  logInfo(`Starting Next.js dev server on http://localhost:${port} (Ctrl-C to stop)...`);

  const child = spawn('npm', ['run', 'dev', '--', '--port', port], {
    cwd: webDir,
    stdio: 'inherit',
    env: { ...process.env, BRAIN_REPO_URL: canonicalUrl },
  });
  child.on('close', (code) => process.exit(code ?? 0));
}
```

- [ ] **Step 2: Register in `src/index.ts`**

```typescript
import { serveCommand } from './commands/serve';

program
  .command('serve')
  .description('Start the local dashboard (Next.js dev server) for the indexed repo')
  .option('--repo <url>', 'GitHub repo URL to browse (defaults to the last ingested repo)')
  .option('--port <port>', 'port for the dev server', '3000')
  .action(async (opts: { repo?: string; port?: string }) => {
    await serveCommand(opts);
  });
```

- [ ] **Step 3: Verify serve boots**

```bash
npm run build && node dist/index.js serve &
sleep 12
curl -s http://localhost:3000/api/stats | head -c 200
kill %1
```

Expected: JSON with the last-ingested repo's counts.

- [ ] **Step 4: Update README.md**

Add/update these sections (match the README's existing tone):
- **Setup**: `ANTHROPIC_API_KEY` in the env table; "run `supabase/schema-graph.sql` in the Supabase SQL editor after `schema.sql`".
- **Commands**: `brain extract` (run after ingest; incremental/resumable via `extraction_status`) and `brain serve` (local dashboard: overview, graph, decisions, ask).
- **Architecture** note: two-stage extraction (Haiku classify → Fable deep-extract → link/dedup), decisions searched by `ask`.

- [ ] **Step 5: End-to-end smoke (real APIs — needs `.env` populated and the migration run)**

```bash
node dist/index.js ingest https://github.com/sumitchinchansure/engineering-brain-mvp --since 2026-06-01
node dist/index.js extract
node dist/index.js status
node dist/index.js ask "why was the fixed similarity cutoff replaced?"
```

Expected: extract reports classified/skipped/decision counts with no stack traces; re-running `extract` immediately reports nothing to extract (incremental); `ask` answers with sources (ideally citing an extracted decision). Then `node dist/index.js serve` and eyeball all four pages against the same data.

- [ ] **Step 6: Full test + build gate**

Run: `npm test && npm run build && cd web && npx tsc --noEmit && cd ..`
Expected: everything green.

- [ ] **Step 7: Commit**

```bash
git add src/commands/serve.ts src/index.ts README.md
git commit -m "feat: brain serve — local dashboard launcher + docs"
```

---

## Post-plan checklist (for the executor)

- The Supabase migration (`supabase/schema-graph.sql`, Task 2) must be run manually in the SQL editor before Task 6's smoke test or Task 11's e2e — it is not applied automatically.
- Never commit `.env`, `node_modules`, `web/node_modules`, `web/.next`.
- If any Claude call shape fails type-checking or 400s, re-read the Global Constraints block — model IDs, `output_config`, `betas`/`fallbacks`, and the no-`thinking`/no-sampling rules are exact.
