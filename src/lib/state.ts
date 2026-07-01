import * as fs from 'fs';
import * as path from 'path';

interface BrainState {
  lastRepoUrl: string;
}

const STATE_DIR = path.resolve(process.cwd(), '.brain');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

/**
 * The spec's `ask`/`status` commands take no repo argument, only `ingest` does.
 * We record the most recently ingested repo locally so `ask`/`status` know
 * which repo to query by default (overridable with --repo). This is a small
 * pointer file, not a data cache — see DECISIONS.md.
 */
export function saveLastRepo(repoUrl: string): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  const state: BrainState = { lastRepoUrl: repoUrl };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function loadLastRepo(): string | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw) as BrainState;
    return state.lastRepoUrl ?? null;
  } catch {
    return null;
  }
}
