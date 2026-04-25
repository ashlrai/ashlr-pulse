/**
 * POST /api/github/sync — trigger a sync for the current user's account.
 *
 * Manual trigger from the /github page. A scheduled cron service can also
 * call this with a service token (TODO: add a /api/internal/cron path).
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { getAccountForUser } from "@/lib/github-account-db";
import { syncAccount } from "@/lib/github-sync";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const account = await getAccountForUser(me.id);
  if (!account) {
    return NextResponse.json(
      { error: "no GitHub account connected — visit /github to connect" },
      { status: 404 },
    );
  }

  const result = await syncAccount(account);
  return NextResponse.json(result);
}
