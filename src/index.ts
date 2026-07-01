#!/usr/bin/env node
import { Command } from 'commander';
import { loadDotEnv } from './lib/env';
import { ingestCommand } from './commands/ingest';
import { askCommand } from './commands/ask';
import { statusCommand } from './commands/status';

loadDotEnv();

const program = new Command();

program
  .name('brain')
  .description("CLI that ingests a GitHub repo's PRs and commits, then answers \"why was this built?\" questions with evidence links.")
  .version('0.1.0');

program
  .command('ingest')
  .description("Fetch a GitHub repo's PRs and commits and index them with embeddings")
  .argument('<github-repo-url>', 'GitHub repo URL, e.g. https://github.com/owner/repo')
  .option('--since <date>', 'only fetch PRs/commits created after this ISO date (e.g. 2024-01-01)')
  .action(async (repoUrl: string, opts: { since?: string }) => {
    await ingestCommand(repoUrl, { since: opts.since });
  });

program
  .command('ask')
  .description('Ask a natural language question about the indexed repo')
  .argument('<question>', 'question to ask')
  .option('--repo <url>', 'GitHub repo URL to query (defaults to the last ingested repo)')
  .action(async (question: string, opts: { repo?: string }) => {
    await askCommand(question, { repo: opts.repo });
  });

program
  .command('status')
  .description('Show how many PRs and commits are indexed for the current repo')
  .option('--repo <url>', 'GitHub repo URL to check (defaults to the last ingested repo)')
  .action(async (opts: { repo?: string }) => {
    await statusCommand({ repo: opts.repo });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
