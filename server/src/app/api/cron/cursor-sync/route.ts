/**
 * POST /api/cron/cursor-sync — hourly Cursor usage ingest for all orgs.
 *
 * Auth: shared secret in `x-cron-secret` header, validated against
 * PULSE_CRON_SECRET env. Internal endpoint; not user-facing.
 *
 * For each org that has cursor_admin_token configured, this route:
 *   1. Looks up the encrypted admin token via cursor-auth.ts.
 *   2. Resolves the primary user_id for the org (owner) to use as
 *      activity_event.user_id so Cursor events appear in their feed.
 *   3. Calls cursorIngest() which polls the Cursor API, maps sessions
 *      to ActivityEventInsert rows, and upserts with ON CONFLICT DO NOTHING.
 *
 * Returns JSON: { orgs_synced, events_ingested, errors }
 *
 * Privacy floor: cursor-ingest.ts only fetches ts, duration_ms, model,
 * tokens, and cost. No code context, editor selections, or keystroke
 * data is ever fetched or stored.
 */

import { NextResponse } from "next/server";
import { log } from "@/lib/logger";
import { safeEqual } from "@/lib/timing-safe";
import { listOrgsWithCursorToken, getCursorToken } from "@/lib/cursor-auth";
import { cursorIngest } from "@/lib/cursor-ingest";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300; // up to 5 minutes per cron tick

/** Resolve the primary owner user_id for an org. */
async function primaryOwnerForOrg(orgId: string): Promise<string | null> {
  const db = sql();
  const [row] = await db<{ user_id: string }[]>`
    SELECT user_id::text AS user_id
    FROM membership
    WHERE org_id = ${orgId}::uuid
      AND role IN ('owner', 'admin')
    ORDER BY (role = 'owner') DESC, (role = 'admin') DESC
    LIMIT 1
  `;
  return row?.user_id ?? null;
}

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
  const orgs = await listOrgsWithCursorToken();

  log.info({ msg: "cron: cursor-sync starting", orgs: orgs.length });

  let orgs_synced = 0;
  let events_ingested = 0;
  const errors: string[] = [];

  for (const { id: orgId, name: orgName } of orgs) {
    try {
      const config = await getCursorToken(orgId);
      if (!config) {
        // Token was removed between list and fetch — skip silently.
        continue;
      }

      const userId = await primaryOwnerForOrg(orgId);
      if (!userId) {
        errors.push(`${orgName}: no owner found`);
        continue;
      }

      const result = await cursorIngest(config, userId);

      if (result.error) {
        errors.push(`${orgName}: ${result.error}`);
        log.warn({
          msg: "cron: cursor-sync org error",
          org_id: orgId,
          err: result.error,
        });
      } else {
        orgs_synced++;
        events_ingested += result.events_inserted;
        log.info({
          msg: "cron: cursor-sync org done",
          org_id: orgId,
          sessions_fetched: result.sessions_fetched,
          events_inserted: result.events_inserted,
          skipped_cooldown: result.skipped_cooldown,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${orgName}: ${message}`);
      log.error({ msg: "cron: cursor-sync org threw", org_id: orgId, err: message });
    }
  }

  const elapsed_ms = Date.now() - startedAt;
  log.info({
    msg: "cron: cursor-sync done",
    orgs_synced,
    events_ingested,
    errors: errors.length,
    elapsed_ms,
  });

  return NextResponse.json({ orgs_synced, events_ingested, errors });
}
