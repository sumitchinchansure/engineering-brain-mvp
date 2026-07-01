import { Octokit } from '@octokit/rest';
import type { CommitData, PullRequestData } from '../types';

const PR_LIMIT = 200;
const COMMIT_LIMIT = 500;
const PER_PAGE = 100;

export interface ParsedRepo {
  owner: string;
  repo: string;
  canonicalUrl: string;
}

export function parseRepoUrl(url: string): ParsedRepo {
  const match = url
    .trim()
    .match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!match) {
    throw new Error(`Could not parse a GitHub owner/repo from URL: ${url}`);
  }
  const [, owner, repo] = match;
  return { owner, repo, canonicalUrl: `https://github.com/${owner}/${repo}` };
}

export function createGithubClient(): Octokit {
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

export class GithubRateLimitError extends Error {
  constructor(public remaining: number, public resetAt: Date | null) {
    super(
      `GitHub API rate limit reached (remaining: ${remaining}).` +
        (resetAt ? ` Resets at ${resetAt.toISOString()}.` : '')
    );
    this.name = 'GithubRateLimitError';
  }
}

function toRateLimitError(err: unknown): GithubRateLimitError | null {
  const e = err as { status?: number; response?: { headers?: Record<string, string> } };
  const headers = e?.response?.headers;
  const isRateLimitStatus = e?.status === 403 || e?.status === 429;
  const remainingHeader = headers?.['x-ratelimit-remaining'];
  if (isRateLimitStatus && remainingHeader !== undefined && Number(remainingHeader) === 0) {
    const resetHeader = headers?.['x-ratelimit-reset'];
    const resetAt = resetHeader ? new Date(Number(resetHeader) * 1000) : null;
    return new GithubRateLimitError(0, resetAt);
  }
  return null;
}

export async function fetchPRs(
  octokit: Octokit,
  owner: string,
  repo: string,
  since?: string
): Promise<PullRequestData[]> {
  const prs: PullRequestData[] = [];
  let page = 1;

  try {
    while (prs.length < PR_LIMIT) {
      const { data } = await octokit.pulls.list({
        owner,
        repo,
        state: 'all',
        sort: 'created',
        direction: 'desc',
        per_page: PER_PAGE,
        page,
      });
      if (data.length === 0) break;

      for (const pr of data) {
        if (since && pr.created_at < since) {
          return prs;
        }
        prs.push({
          number: pr.number,
          title: pr.title,
          body: pr.body,
          mergedAt: pr.merged_at,
          createdAt: pr.created_at,
          url: pr.html_url,
          author: pr.user?.login ?? null,
        });
        if (prs.length >= PR_LIMIT) break;
      }

      if (data.length < PER_PAGE) break;
      page++;
    }
  } catch (err) {
    const rateLimitError = toRateLimitError(err);
    if (rateLimitError) throw rateLimitError;
    throw err;
  }

  return prs;
}

export async function fetchCommits(
  octokit: Octokit,
  owner: string,
  repo: string,
  since?: string
): Promise<CommitData[]> {
  const commits: CommitData[] = [];
  let page = 1;

  try {
    while (commits.length < COMMIT_LIMIT) {
      const { data } = await octokit.repos.listCommits({
        owner,
        repo,
        per_page: PER_PAGE,
        page,
        since,
      });
      if (data.length === 0) break;

      for (const commit of data) {
        commits.push({
          sha: commit.sha,
          message: commit.commit.message,
          url: commit.html_url,
          author: commit.author?.login ?? commit.commit.author?.name ?? null,
          date: commit.commit.author?.date ?? null,
        });
        if (commits.length >= COMMIT_LIMIT) break;
      }

      if (data.length < PER_PAGE) break;
      page++;
    }
  } catch (err) {
    const rateLimitError = toRateLimitError(err);
    if (rateLimitError) throw rateLimitError;
    throw err;
  }

  return commits;
}
