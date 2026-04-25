/**
 * github-account-db.ts — typed DB access for github_account, github_repo,
 * github_event.
 *
 * Tokens are encrypted on the way in and decrypted only when needed for
 * API calls. The dashboard never sees raw tokens.
 */

import { sql } from "./db";
import { encryptToken, decryptToken } from "./token-crypto";

export interface GitHubAccountRow {
  id: string;
  user_id: string;
  github_user_id: number;
  github_login: string;
  avatar_url: string | null;
  scopes: string[];
  last_synced_at: string | null;
  sync_error: string | null;
  created_at: string;
}

export interface UpsertAccountInput {
  user_id: string;
  github_user_id: number;
  github_login: string;
  avatar_url: string | null;
  scopes: string[];
  access_token: string;
}

export async function upsertAccount(input: UpsertAccountInput): Promise<GitHubAccountRow> {
  const db = sql();
  const enc = encryptToken(input.access_token);
  const [row] = await db<GitHubAccountRow[]>`
    INSERT INTO github_account (
      user_id, github_user_id, github_login, avatar_url, scopes, access_token_enc
    )
    VALUES (
      ${input.user_id}, ${input.github_user_id}, ${input.github_login},
      ${input.avatar_url}, ${input.scopes}, ${enc}
    )
    ON CONFLICT (user_id, github_user_id) DO UPDATE SET
      github_login    = EXCLUDED.github_login,
      avatar_url      = EXCLUDED.avatar_url,
      scopes          = EXCLUDED.scopes,
      access_token_enc = EXCLUDED.access_token_enc,
      sync_error      = NULL,
      updated_at      = NOW()
    RETURNING
      id::text AS id, user_id::text AS user_id,
      github_user_id, github_login, avatar_url, scopes,
      last_synced_at, sync_error, created_at
  `;
  return row;
}

export async function getAccountForUser(userId: string): Promise<GitHubAccountRow | null> {
  const db = sql();
  const [row] = await db<GitHubAccountRow[]>`
    SELECT
      id::text AS id, user_id::text AS user_id,
      github_user_id, github_login, avatar_url, scopes,
      last_synced_at, sync_error, created_at
    FROM github_account
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return row ?? null;
}

export async function getAccessTokenForAccount(accountId: string): Promise<string | null> {
  const db = sql();
  const [row] = await db<{ access_token_enc: Buffer }[]>`
    SELECT access_token_enc FROM github_account WHERE id = ${accountId} LIMIT 1
  `;
  if (!row) return null;
  return decryptToken(row.access_token_enc);
}

export async function recordSyncError(accountId: string, error: string): Promise<void> {
  const db = sql();
  await db`UPDATE github_account SET sync_error = ${error}, updated_at = NOW() WHERE id = ${accountId}`;
}

export async function recordSyncSuccess(accountId: string): Promise<void> {
  const db = sql();
  await db`UPDATE github_account SET last_synced_at = NOW(), sync_error = NULL, updated_at = NOW() WHERE id = ${accountId}`;
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

export interface GitHubRepoRow {
  id: string;
  account_id: string;
  github_repo_id: number;
  full_name: string;
  default_branch: string | null;
  is_private: boolean | null;
  is_fork: boolean | null;
  enabled: boolean;
  commits_synced_until: string | null;
  prs_synced_until: string | null;
}

export async function upsertRepo(input: {
  account_id: string;
  github_repo_id: number;
  full_name: string;
  default_branch: string | null;
  is_private: boolean;
  is_fork: boolean;
}): Promise<GitHubRepoRow> {
  const db = sql();
  const [row] = await db<GitHubRepoRow[]>`
    INSERT INTO github_repo (
      account_id, github_repo_id, full_name, default_branch, is_private, is_fork
    )
    VALUES (
      ${input.account_id}, ${input.github_repo_id}, ${input.full_name},
      ${input.default_branch}, ${input.is_private}, ${input.is_fork}
    )
    ON CONFLICT (account_id, github_repo_id) DO UPDATE SET
      full_name      = EXCLUDED.full_name,
      default_branch = EXCLUDED.default_branch,
      is_private     = EXCLUDED.is_private,
      is_fork        = EXCLUDED.is_fork,
      updated_at     = NOW()
    RETURNING
      id::text AS id, account_id::text AS account_id,
      github_repo_id, full_name, default_branch,
      is_private, is_fork, enabled,
      commits_synced_until, prs_synced_until
  `;
  return row;
}

export async function listEnabledRepos(accountId: string): Promise<GitHubRepoRow[]> {
  const db = sql();
  return db<GitHubRepoRow[]>`
    SELECT
      id::text AS id, account_id::text AS account_id,
      github_repo_id, full_name, default_branch,
      is_private, is_fork, enabled,
      commits_synced_until, prs_synced_until
    FROM github_repo
    WHERE account_id = ${accountId} AND enabled = TRUE
    ORDER BY full_name
  `;
}

export async function setRepoEnabled(repoId: string, accountId: string, enabled: boolean): Promise<boolean> {
  const db = sql();
  const r = await db`
    UPDATE github_repo SET enabled = ${enabled}, updated_at = NOW()
    WHERE id = ${repoId} AND account_id = ${accountId}
  `;
  return r.count === 1;
}

export async function setCommitsWatermark(repoId: string, ts: string): Promise<void> {
  const db = sql();
  await db`UPDATE github_repo SET commits_synced_until = ${ts}, updated_at = NOW() WHERE id = ${repoId}`;
}

export async function setPRsWatermark(repoId: string, ts: string): Promise<void> {
  const db = sql();
  await db`UPDATE github_repo SET prs_synced_until = ${ts}, updated_at = NOW() WHERE id = ${repoId}`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface GitHubEventInput {
  account_id: string;
  repo_id: string;
  kind: string;
  ts: string;
  actor_login: string;
  external_id: string;
  branch?: string | null;
  pr_number?: number | null;
  pr_state?: string | null;
  pr_is_draft?: boolean | null;
  additions?: number | null;
  deletions?: number | null;
  changed_files?: number | null;
  message_first_line?: string | null;
  raw?: unknown;
}

/** Insert (or skip-on-conflict) a single event. Returns true if inserted. */
export async function insertEvent(input: GitHubEventInput): Promise<boolean> {
  const db = sql();
  const r = await db`
    INSERT INTO github_event (
      account_id, repo_id, kind, ts, actor_login, external_id,
      branch, pr_number, pr_state, pr_is_draft,
      additions, deletions, changed_files, message_first_line, raw
    )
    VALUES (
      ${input.account_id}, ${input.repo_id}, ${input.kind}, ${input.ts},
      ${input.actor_login}, ${input.external_id},
      ${input.branch ?? null}, ${input.pr_number ?? null},
      ${input.pr_state ?? null}, ${input.pr_is_draft ?? null},
      ${input.additions ?? null}, ${input.deletions ?? null},
      ${input.changed_files ?? null}, ${input.message_first_line ?? null},
      ${input.raw ? JSON.stringify(input.raw) : null}
    )
    ON CONFLICT (repo_id, kind, external_id) DO NOTHING
  `;
  return r.count === 1;
}

export interface TodayGitHubRow {
  kind: string;
  events: number;
}

/** Aggregate event counts by kind for an account in a window. */
export async function summarizeForAccount(
  accountId: string,
  windowHours: number,
): Promise<TodayGitHubRow[]> {
  const db = sql();
  return db<TodayGitHubRow[]>`
    SELECT kind, COUNT(*)::int AS events
    FROM github_event
    WHERE account_id = ${accountId}
      AND ts >= NOW() - (${windowHours} || ' hours')::interval
    GROUP BY kind
    ORDER BY events DESC
  `;
}
