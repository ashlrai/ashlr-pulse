/**
 * github-sync.ts — pull commits + PRs for one github_account into github_event.
 *
 * Idempotent and watermarked: each repo tracks commits_synced_until and
 * prs_synced_until; subsequent syncs only fetch what's new. ON CONFLICT
 * DO NOTHING handles any duplicate events from racing syncs.
 *
 * Privacy: never store commit body, PR description, review comment text,
 * or issue body. Only metadata (counts, state enums, refs, first line of
 * commit message / issue title).
 */

import { GitHubAuthError, GitHubClient } from "./github-client";
import {
  getAccessTokenForAccount,
  insertEvent,
  listEnabledRepos,
  recordSyncError,
  recordSyncSuccess,
  setCommitsWatermark,
  setIssuesWatermark,
  setPRsWatermark,
  upsertRepo,
  type GitHubAccountRow,
} from "./github-account-db";
import { sql } from "./db";

export interface SyncResult {
  account_id: string;
  github_login: string;
  reposScanned: number;
  commitsAdded: number;
  prsAdded: number;
  issuesAdded: number;
  errors: string[];
}

const FIRST_SYNC_LOOKBACK_DAYS = 30;

export async function syncAccount(account: GitHubAccountRow): Promise<SyncResult> {
  const result: SyncResult = {
    account_id: account.id,
    github_login: account.github_login,
    reposScanned: 0,
    commitsAdded: 0,
    prsAdded: 0,
    issuesAdded: 0,
    errors: [],
  };

  const token = await getAccessTokenForAccount(account.id);
  if (!token) {
    result.errors.push("no access token on file");
    await recordSyncError(account.id, "missing token");
    return result;
  }

  const gh = new GitHubClient(token);

  try {
    // Refresh the user's authorized repo list. Mason can also opt repos
    // in/out via the /github page; this just keeps the catalog fresh.
    await refreshRepoCatalog(gh, account.id);
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      const msg = `github auth failed (token revoked?): ${err.message}`;
      result.errors.push(msg);
      await recordSyncError(account.id, msg);
      return result;
    }
    result.errors.push(`refreshRepoCatalog: ${err instanceof Error ? err.message : String(err)}`);
  }

  const repos = await listEnabledRepos(account.id);
  result.reposScanned = repos.length;

  const lookback = new Date(Date.now() - FIRST_SYNC_LOOKBACK_DAYS * 86400_000).toISOString();

  for (const repo of repos) {
    try {
      const commitsSince = repo.commits_synced_until ?? lookback;
      const commitsAdded = await syncCommits(gh, account.id, repo.id, repo.full_name, commitsSince);
      result.commitsAdded += commitsAdded;
      // Watermark to "now" — we just consumed everything up to this moment.
      await setCommitsWatermark(repo.id, new Date().toISOString());
    } catch (err) {
      result.errors.push(`commits[${repo.full_name}]: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const prsSince = repo.prs_synced_until ?? lookback;
      const prsAdded = await syncPRs(gh, account.id, repo.id, repo.full_name, prsSince);
      result.prsAdded += prsAdded;
      await setPRsWatermark(repo.id, new Date().toISOString());
    } catch (err) {
      result.errors.push(`prs[${repo.full_name}]: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const issuesSince = repo.issues_synced_until ?? lookback;
      const issuesAdded = await syncIssues(gh, account.id, repo.id, repo.full_name, issuesSince);
      result.issuesAdded += issuesAdded;
      await setIssuesWatermark(repo.id, new Date().toISOString());
    } catch (err) {
      result.errors.push(`issues[${repo.full_name}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (result.errors.length === 0) {
    await recordSyncSuccess(account.id);
  } else {
    await recordSyncError(account.id, result.errors.slice(0, 3).join(" | "));
  }
  return result;
}

async function refreshRepoCatalog(gh: GitHubClient, accountId: string): Promise<void> {
  for await (const r of gh.listAuthorizedRepos()) {
    await upsertRepo({
      account_id: accountId,
      github_repo_id: r.id,
      full_name: r.full_name,
      default_branch: r.default_branch ?? null,
      is_private: r.private,
      is_fork: r.fork,
    });
  }
}

async function syncCommits(
  gh: GitHubClient,
  accountId: string,
  repoId: string,
  fullName: string,
  since: string,
): Promise<number> {
  let added = 0;
  for await (const c of gh.listCommits(fullName, since)) {
    const inserted = await insertEvent({
      account_id: accountId,
      repo_id: repoId,
      kind: "commit",
      ts: c.commit.author.date,
      actor_login: c.author?.login ?? c.commit.author.email ?? "unknown",
      external_id: c.sha,
      // Stats only available when fetching individual commits; the list
      // endpoint omits them. We accept partial data — bytes-of-diff
      // isn't required for the MVP dashboard.
      message_first_line: c.commit.message.split("\n")[0]?.slice(0, 200) ?? null,
      // Omit raw — list-endpoint commits don't include diff anyway and
      // we don't want to bloat the event row.
    });
    if (inserted) added++;
  }
  return added;
}

async function syncPRs(
  gh: GitHubClient,
  accountId: string,
  repoId: string,
  fullName: string,
  since: string,
): Promise<number> {
  let added = 0;
  for await (const pr of gh.listPullsSince(fullName, since)) {
    // Emit one event per state transition we observe. v0.2 simplification:
    // we just emit `pr_opened` keyed on PR id at created_at, and
    // `pr_merged`/`pr_closed` keyed at the close ts. Re-running picks up
    // any new transitions via the unique (repo_id, kind, external_id).
    const baseAttrs = {
      account_id: accountId,
      repo_id: repoId,
      actor_login: pr.user.login,
      external_id: String(pr.number),
      branch: pr.head.ref,
      pr_number: pr.number,
      pr_state: pr.state,
      pr_is_draft: pr.draft,
      additions: pr.additions ?? null,
      deletions: pr.deletions ?? null,
      changed_files: pr.changed_files ?? null,
      message_first_line: pr.title.slice(0, 200),
    };

    if (await insertEvent({ ...baseAttrs, kind: "pr_opened", ts: pr.created_at })) {
      added++;
    }
    if (pr.merged_at) {
      if (await insertEvent({ ...baseAttrs, kind: "pr_merged", ts: pr.merged_at })) {
        added++;
      }
    } else if (pr.closed_at) {
      if (await insertEvent({ ...baseAttrs, kind: "pr_closed", ts: pr.closed_at })) {
        added++;
      }
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------
// Uses GitHubClient.listIssuesSince(), which paginates the /issues endpoint.
// That endpoint returns PRs too (they carry a `pull_request` key) — we skip
// those so PRs aren't double-counted as issues.

/**
 * Sync issues for one repo. Emits `issue_opened` at created_at and, when the
 * issue is closed, `issue_closed` at closed_at. Idempotent via the unique
 * (repo_id, kind, external_id). actor_login is the issue author (the
 * contributor) — captured so the graph can draw contributes_to edges.
 */
async function syncIssues(
  gh: GitHubClient,
  accountId: string,
  repoId: string,
  fullName: string,
  since: string,
): Promise<number> {
  let added = 0;
  for await (const issue of gh.listIssuesSince(fullName, since)) {
    // Skip PRs surfaced by the /issues endpoint — they're handled by syncPRs.
    if (issue.pull_request) continue;

    const actor = issue.user?.login ?? "unknown";
    const baseAttrs = {
      account_id: accountId,
      repo_id: repoId,
      actor_login: actor,
      external_id: String(issue.number),
      pr_number: issue.number, // reuse the numeric ref column for the issue number
      pr_state: issue.state,
      message_first_line: issue.title.slice(0, 200), // title only, never the body
    };

    if (await insertEvent({ ...baseAttrs, kind: "issue_opened", ts: issue.created_at })) {
      added++;
    }
    if (issue.closed_at) {
      if (await insertEvent({ ...baseAttrs, kind: "issue_closed", ts: issue.closed_at })) {
        added++;
      }
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// Proposal-linked commit lookup (fleet proposal drill-down)
// ---------------------------------------------------------------------------

export interface ProposalCommit {
  sha: string;
  messageFirstLine: string | null;
  actorLogin: string | null;
  ts: string;
  changedFiles: number | null;
}

/**
 * Fetch up to `limit` commits for a repo that fall within a proposal window
 * [windowStart, windowEnd]. Org-scoped via membership JOIN on github_account.
 *
 * PRIVACY FLOOR: only structured metadata columns are returned (sha,
 * message_first_line ≤200 chars, actor_login, ts, changed_files). No diff,
 * no commit body, no file contents.
 */
export async function getCommitsForProposalWindow(
  orgId: string,
  repoFullName: string,
  windowStart: string,
  windowEnd: string,
  limit = 3,
): Promise<ProposalCommit[]> {
  const safeLimit = Math.min(20, Math.max(1, limit));
  const db = sql();

  interface Row {
    external_id: string;
    message_first_line: string | null;
    actor_login: string | null;
    ts: string;
    changed_files: number | null;
  }

  const rows = await db<Row[]>`
    SELECT
      ge.external_id,
      ge.message_first_line,
      ge.actor_login,
      ge.ts::text AS ts,
      ge.changed_files
    FROM github_event ge
    JOIN github_repo gr   ON gr.id  = ge.repo_id
    JOIN github_account ga ON ga.id = gr.account_id
    JOIN membership m      ON m.user_id = ga.user_id
      AND m.org_id = ${orgId}::uuid
    WHERE ge.kind      = 'commit'
      AND gr.full_name = ${repoFullName}
      AND ge.ts >= ${windowStart}::timestamptz
      AND ge.ts <= ${windowEnd}::timestamptz
    ORDER BY ge.ts DESC
    LIMIT ${safeLimit}
  `;

  return rows.map((r) => ({
    sha: r.external_id,
    messageFirstLine: r.message_first_line?.slice(0, 200) ?? null,
    actorLogin: r.actor_login,
    ts: r.ts,
    changedFiles: r.changed_files,
  }));
}
