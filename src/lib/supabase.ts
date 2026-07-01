import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { IndexedItem, MatchedItem } from '../types';

const TABLE = 'indexed_items';

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_ANON_KEY as string);
  }
  return client;
}

/**
 * Upserts one item. Failures are returned rather than thrown so the caller
 * can log-and-continue per the spec's error handling rules (don't abort the
 * whole ingest on a single write failure).
 */
export async function upsertItem(item: IndexedItem): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from(TABLE).upsert(item, { onConflict: 'source_url' });
  return { error: error ? error.message : null };
}

export async function searchSimilarItems(
  repoUrl: string,
  queryEmbedding: number[],
  matchCount = 5
): Promise<{ data: MatchedItem[]; error: string | null }> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('match_items', {
    query_embedding: queryEmbedding,
    repo: repoUrl,
    match_count: matchCount,
  });
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as MatchedItem[], error: null };
}

export async function getCounts(repoUrl: string): Promise<{ prs: number; commits: number }> {
  const supabase = getSupabaseClient();

  const [prResult, commitResult] = await Promise.all([
    supabase.from(TABLE).select('*', { count: 'exact', head: true }).eq('repo_url', repoUrl).eq('type', 'pr'),
    supabase.from(TABLE).select('*', { count: 'exact', head: true }).eq('repo_url', repoUrl).eq('type', 'commit'),
  ]);

  if (prResult.error) throw new Error(`Supabase count query failed: ${prResult.error.message}`);
  if (commitResult.error) throw new Error(`Supabase count query failed: ${commitResult.error.message}`);

  return { prs: prResult.count ?? 0, commits: commitResult.count ?? 0 };
}
