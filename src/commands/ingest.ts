import { createGithubClient, fetchCommits, fetchPRs, GithubRateLimitError, parseRepoUrl } from '../lib/github';
import { embed } from '../lib/embeddings';
import { upsertItem } from '../lib/supabase';
import { saveLastRepo } from '../lib/state';
import { validateEnv } from '../lib/env';
import type { IndexedItem } from '../types';

export interface IngestOptions {
  since?: string;
}

export async function ingestCommand(repoUrl: string, options: IngestOptions): Promise<void> {
  validateEnv();

  let parsed;
  try {
    parsed = parseRepoUrl(repoUrl);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  const { owner, repo, canonicalUrl } = parsed;
  const octokit = createGithubClient();

  try {
    console.log(`Fetching PRs and commits for ${owner}/${repo}...`);

    const [prs, commits] = await Promise.all([
      fetchPRs(octokit, owner, repo, options.since),
      fetchCommits(octokit, owner, repo, options.since),
    ]);

    let indexedPRs = 0;
    let indexedCommits = 0;

    for (const pr of prs) {
      const text = `${pr.title}\n\n${pr.body ?? ''}`;
      let embedding: number[];
      try {
        embedding = await embed(text);
      } catch (err) {
        console.error(`OpenAI API error while embedding PR #${pr.number}: ${(err as Error).message}`);
        process.exit(1);
      }

      const item: IndexedItem = {
        repo_url: canonicalUrl,
        type: 'pr',
        source_url: pr.url,
        title: pr.title,
        body: pr.body ?? '',
        author: pr.author,
        created_at: pr.mergedAt ?? pr.createdAt,
        embedding,
      };

      const { error } = await upsertItem(item);
      if (error) {
        console.error(`Failed to store PR #${pr.number} (${pr.url}): ${error}`);
        continue;
      }
      indexedPRs++;
    }

    for (const commit of commits) {
      const firstLine = commit.message.split('\n')[0];
      let embedding: number[];
      try {
        embedding = await embed(commit.message);
      } catch (err) {
        console.error(`OpenAI API error while embedding commit ${commit.sha.slice(0, 7)}: ${(err as Error).message}`);
        process.exit(1);
      }

      const item: IndexedItem = {
        repo_url: canonicalUrl,
        type: 'commit',
        source_url: commit.url,
        title: firstLine,
        body: commit.message,
        author: commit.author,
        created_at: commit.date,
        embedding,
      };

      const { error } = await upsertItem(item);
      if (error) {
        console.error(`Failed to store commit ${commit.sha.slice(0, 7)} (${commit.url}): ${error}`);
        continue;
      }
      indexedCommits++;
    }

    saveLastRepo(canonicalUrl);
    console.log(`Indexed ${indexedPRs} PRs, ${indexedCommits} commits`);
  } catch (err) {
    if (err instanceof GithubRateLimitError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
