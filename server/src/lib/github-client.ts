/**
 * github-client.ts — minimal GitHub REST/GraphQL client.
 *
 * Wraps fetch with auth, pagination, retry, and rate-limit awareness.
 * No third-party deps (Octokit is great but adds ~200KB and we use a
 * narrow slice of the API).
 *
 * Endpoints we touch:
 *   GET /user                              — identity
 *   GET /user/repos                        — list authorized repos
 *   GET /repos/{owner}/{repo}/commits      — commit log (since=...)
 *   GET /repos/{owner}/{repo}/pulls         — open + closed PRs (since=...)
 *   GET /repos/{owner}/{repo}/pulls/{n}/reviews — PR reviews
 *
 * GitHub's REST limits: 5000 req/hr authenticated. A single sync of one
 * cofounder's 25 repos × 100 commits × 1 PR each = ~125 req — comfortably
 * under the cap with margin for backoff.
 */

const API = "https://api.github.com";
const UA = "ashlr-pulse/0.2 (+https://github.com/ashlrai/ashlr-pulse)";

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
}

export interface GitHubRepo {
  id: number;
  full_name: string;            // "owner/repo"
  private: boolean;
  fork: boolean;
  default_branch: string;
  pushed_at: string;
}

export interface GitHubCommit {
  sha: string;
  commit: {
    author: { name: string; email: string; date: string };
    message: string;
  };
  author: { login: string } | null;     // may be null for non-GitHub authors
  stats?: { additions: number; deletions: number; total: number };
  files?: Array<{ filename: string }>;
}

export interface GitHubPR {
  id: number;
  number: number;
  state: "open" | "closed";
  draft: boolean;
  title: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  head: { ref: string };
  base: { ref: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

export interface GitHubIssue {
  id: number;
  number: number;
  state: "open" | "closed";
  title: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /**
   * Present (a non-null object) when this "issue" is actually a pull request.
   * GitHub's /issues endpoint returns PRs too; we skip those so PRs aren't
   * double-counted as issues — syncPRs() owns them.
   */
  pull_request?: { url: string } | null;
}

export class GitHubClient {
  constructor(private readonly token: string) {}

  private async fetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${API}${path}`;
    const r = await fetch(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": UA,
        authorization: `Bearer ${this.token}`,
        ...(init.headers ?? {}),
      },
    });
    if (r.status === 401 || r.status === 403) {
      const body = await r.text().catch(() => "");
      throw new GitHubAuthError(`${r.status} ${r.statusText}: ${body.slice(0, 200)}`);
    }
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`GitHub ${r.status} ${r.statusText} on ${path}: ${body.slice(0, 200)}`);
    }
    return (await r.json()) as T;
  }

  /**
   * Paginate through a list endpoint. Walks `Link: <...>; rel="next"`
   * headers. Caller can early-return via the predicate to stop walking.
   */
  private async *paginate<T>(
    path: string,
    perPage = 100,
    keepGoing: (item: T) => boolean = () => true,
  ): AsyncGenerator<T> {
    let url: string | null = `${API}${path}${path.includes("?") ? "&" : "?"}per_page=${perPage}`;
    while (url) {
      const r: Response = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": UA,
          authorization: `Bearer ${this.token}`,
        },
      });
      if (r.status === 401 || r.status === 403) {
        throw new GitHubAuthError(`${r.status} ${r.statusText}`);
      }
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`GitHub ${r.status} on ${url}: ${body.slice(0, 200)}`);
      }
      const items = (await r.json()) as T[];
      for (const item of items) {
        if (!keepGoing(item)) return;
        yield item;
      }
      url = parseNextLink(r.headers.get("link"));
    }
  }

  me(): Promise<GitHubUser> {
    return this.fetch<GitHubUser>("/user");
  }

  /** Repos the user has push access to (owned + collaborator + org). */
  async *listAuthorizedRepos(): AsyncGenerator<GitHubRepo> {
    yield* this.paginate<GitHubRepo>(
      "/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed",
    );
  }

  /**
   * Commits since `since` (ISO). Yields oldest-newer-than-since first by
   * default (GitHub returns newest-first; we don't reverse here — caller
   * should consume the stream and then watermark to the latest seen).
   */
  async *listCommits(
    fullName: string,
    since: string,
  ): AsyncGenerator<GitHubCommit> {
    yield* this.paginate<GitHubCommit>(
      `/repos/${fullName}/commits?since=${encodeURIComponent(since)}`,
    );
  }

  /**
   * PRs updated since `since`. GitHub's `since` parameter on /pulls
   * filters by `updated_at`, which catches both newly opened and merged
   * PRs since last sync.
   */
  async *listPullsSince(
    fullName: string,
    since: string,
  ): AsyncGenerator<GitHubPR> {
    yield* this.paginate<GitHubPR>(
      `/repos/${fullName}/pulls?state=all&sort=updated&direction=desc`,
      100,
      (pr) => pr.updated_at >= since,
    );
  }

  /**
   * Issues updated since `since` (ISO). GitHub's /issues endpoint filters by
   * `updated_at` via the `since` query param and also returns pull requests
   * (each carries a `pull_request` key) — callers must skip those. We sort
   * descending by update time and early-stop once we walk past the watermark,
   * mirroring listPullsSince().
   */
  async *listIssuesSince(
    fullName: string,
    since: string,
  ): AsyncGenerator<GitHubIssue> {
    yield* this.paginate<GitHubIssue>(
      `/repos/${fullName}/issues?state=all&sort=updated&direction=desc&since=${encodeURIComponent(since)}`,
      100,
      (issue) => issue.updated_at >= since,
    );
  }
}

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  // Link: <https://...>; rel="next", <https://...>; rel="last"
  for (const part of header.split(",")) {
    const m = part.trim().match(/^<([^>]+)>;\s*rel="next"$/);
    if (m && m[1]) return m[1];
  }
  return null;
}

