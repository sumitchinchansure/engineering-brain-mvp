import chalk from 'chalk';
import { embed } from '../lib/embeddings';
import { answer } from '../lib/llm';
import { searchSimilarItems } from '../lib/supabase';
import { loadLastRepo } from '../lib/state';
import { validateEnv } from '../lib/env';
import { parseRepoUrl } from '../lib/github';
import { logError, logWarn } from '../lib/log';
import type { MatchedItem } from '../types';

export interface AskOptions {
  repo?: string;
}

const NOT_ENOUGH_CONTEXT_MESSAGE = 'Not enough context in indexed data to answer this confidently.';
const MATCH_COUNT = 5;
// Below this cosine similarity, top results are treated as irrelevant noise
// rather than real signal (vector search always returns *something*).
const RELEVANCE_THRESHOLD = 0.75;

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
    const { data: matches, error } = await searchSimilarItems(canonicalUrl, questionEmbedding, MATCH_COUNT);
    if (error) {
      logError(`Error: vector search failed: ${error}`);
      process.exit(1);
    }

    const relevant = matches.filter((m: MatchedItem) => m.similarity >= RELEVANCE_THRESHOLD);
    if (relevant.length === 0) {
      logWarn(NOT_ENOUGH_CONTEXT_MESSAGE);
      return;
    }

    const context = relevant
      .map((m, i) => `[${i + 1}] (${m.type}) ${m.title}\n${m.body}\nSource: ${m.source_url}`)
      .join('\n\n');

    const responseText = await answer(question, context);
    console.log(responseText);
    console.log('');
    console.log(chalk.cyan('Sources:'));
    for (const m of relevant) {
      console.log(chalk.blue(`- ${m.source_url}`));
    }
  } catch (err) {
    logError(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
