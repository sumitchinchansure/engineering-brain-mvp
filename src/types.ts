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
