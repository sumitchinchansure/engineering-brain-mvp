export interface PullRequestData {
  number: number;
  title: string;
  body: string | null;
  mergedAt: string | null;
  createdAt: string;
  url: string;
  author: string | null;
}

export interface CommitData {
  sha: string;
  message: string;
  url: string;
  author: string | null;
  date: string | null;
}

export type IndexedItemType = 'pr' | 'commit';

export interface IndexedItem {
  repo_url: string;
  type: IndexedItemType;
  source_url: string;
  title: string;
  body: string;
  author: string | null;
  created_at: string | null;
  embedding: number[];
}

export interface MatchedItem {
  id: string;
  type: IndexedItemType;
  source_url: string;
  title: string;
  body: string;
  similarity: number;
}

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
