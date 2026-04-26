/**
 * POST /api/cron/github-sync — bulk-sync every connected GitHub account.
 *
 * Auth: shared secret in `x-cron-secret` header, validated against
 * PULSE_CRON_SECRET env. Internal endpoint; not user-facing.
 *
 * Two callers in production:
 *   1. The in-process scheduler at lib/cron.ts (runs every 60 min,
 *      passes the same secret on the wire so the route's auth path
 *      is consistent across triggers)
 *   2. Optional external cron (Railway cron service or GitHub Actions)
 *      that POSTs the same shape — useful for redundancy or for
 *      out-of-band catch-up syncs.
 *
 * Returns per-account results. Errors are returned 200 with details so
 * the cron caller can log them; we don't 5xx on per-account failure
 * because one user's revoked token shouldn't fail the whole sweep.
 */

import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { syncAccount, type SyncResult } from "@/lib/github-sync";
import { log } from "@/lib/logger";
import { safeEqual } from "@/lib/timing-safe";

export const runtime = "nodejs";
export const maxDuration = 300; // up to 5 minutes per cron tick

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.PULSE_CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "PULSE_CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  const supplied = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(supplied, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const db = sql();
  const accounts = await db<{
    id: string;
    user_id: string;
    github_user_id: number;
    github_login: string;
    avatar_url: string | null;
    scopes: string[];
    last_synced_at: string | null;
    sync_error: string | null;
    created_at: string;
  }[]>`
    SELECT
      id::text         AS id,
      user_id::text    AS user_id,
      github_user_id, github_login, avatar_url, scopes,
      last_synced_at, sync_error, created_at
    FROM github_account
  `;

  log.info({ msg: "cron: github-sync starting", accounts: accounts.length });

  const results: SyncResult[] = [];
  for (const account of accounts) {
    try {
      const r = await syncAccount(account);
      results.push(r);
      log.info({
        msg: "cron: github-sync account done",
        login: account.github_login,
        repos: r.reposScanned,
        commits: r.commitsAdded,
        prs: r.prsAdded,
        errors: r.errors.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ msg: "cron: github-sync account threw", login: account.github_login, err: message });
      results.push({
        account_id: account.id,
        github_login: account.github_login,
        reposScanned: 0,
        commitsAdded: 0,
        prsAdded: 0,
        errors: [message],
      });
    }
  }

  const elapsed_ms = Date.now() - startedAt;
  log.info({ msg: "cron: github-sync done", accounts: accounts.length, elapsed_ms });

  return NextResponse.json({
    ok: true,
    accounts: accounts.length,
    elapsed_ms,
    results,
  });
}
