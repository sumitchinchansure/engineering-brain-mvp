import chalk from 'chalk';
import { getCounts } from '../lib/supabase';
import { loadLastRepo } from '../lib/state';
import { validateEnv } from '../lib/env';
import { parseRepoUrl } from '../lib/github';
import { logError } from '../lib/log';

export interface StatusOptions {
  repo?: string;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  validateEnv();

  const repoUrlInput = options.repo ?? loadLastRepo();
  if (!repoUrlInput) {
    logError(
      'Error: no repo specified and none has been ingested yet. Run `brain ingest <github-repo-url>` first, or pass --repo <url>.'
    );
    process.exit(1);
  }

  try {
    const { canonicalUrl, owner, repo } = parseRepoUrl(repoUrlInput);
    const { prs, commits } = await getCounts(canonicalUrl);
    console.log(`${chalk.cyan('Repo:')} ${owner}/${repo}`);
    console.log(`${chalk.cyan('PRs indexed:')} ${chalk.bold(prs)}`);
    console.log(`${chalk.cyan('Commits indexed:')} ${chalk.bold(commits)}`);
  } catch (err) {
    logError(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
