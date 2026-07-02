import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

const REQUIRED_ENV_VARS = [
  'GITHUB_TOKEN',
  'OPENAI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
] as const;

/**
 * Minimal .env file loader. The tech stack doesn't list a dotenv dependency,
 * so this reads KEY=VALUE lines from a .env file in the cwd without adding one.
 */
export function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  const contents = fs.readFileSync(envPath, 'utf-8');
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Validates required env vars are present. Exits 1 with a human-readable
 * list before any API call is made, per the spec's error handling rules.
 */
export function validateEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(chalk.red('Missing required environment variables:'));
    for (const key of missing) {
      console.error(chalk.red(`  - ${key}`));
    }
    console.error(chalk.yellow('\nSet these in a .env file (see .env.example) or your shell environment.'));
    process.exit(1);
  }
}
