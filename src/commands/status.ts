import { getCounts } from '../lib/supabase';
import { loadLastRepo } from '../lib/state';
import { validateEnv } from '../lib/env';
import { parseRepoUrl } from '../lib/github';

export interface StatusOptions {
  repo?: string;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  validateEnv();

  const repoUrlInput = options.repo ?? loadLastRepo();
  if (!repoUrlInput) {
    console.error(
      'Error: no repo specified and none has been ingested yet. Run `brain ingest <github-repo-url>` first, or pass --repo <url>.'
    );
    process.exit(1);
  }

  try {
    const { canonicalUrl, owner, repo } = parseRepoUrl(repoUrlInput);
    const { prs, commits } = await getCounts(canonicalUrl);
    console.log(`Repo: ${owner}/${repo}`);
    console.log(`PRs indexed: ${prs}`);
    console.log(`Commits indexed: ${commits}`);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
