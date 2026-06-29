/**
 * POST /api/peer-share-sync — on-demand trigger for the peer-share hourly
 * aggregate refresh.
 *
 * Designed for dashboard real-time indicators that want to show "peer
 * activity" without waiting for the next scheduled cron tick. A POST to
 * this endpoint refreshes the hourly aggregate for the calling viewer's
 * active grants (or a specific owner, if provided) and returns updated
 * aggregate counts.
 *
 * Auth: cookie-session via currentUser(). Only the authenticated viewer
 * may trigger a refresh for grants they hold — they cannot specify an
 * arbitrary viewer_id.
 *
 * Request body (JSON, all fields optional):
 *   {
 *     "owner_id": "<uuid>"  // if omitted, refresh ALL grants for the viewer
 *   }
 *
 * Response:
 *   {
 *     "ok": true,
 *     "pairs": <number>,          // grants refreshed
 *     "rows_upserted": <number>,  // hourly rows written
 *     "rows_pruned": <number>,    // old rows removed
 *     "elapsed_ms": <number>
 *   }
 *
 * Privacy floor: the refresh only computes aggregate sums
 * (tokens_input, tokens_output, cost_millicents, event_count) into
 * peer_share_hourly_aggregate — no prompts, completions, code, diffs,
 * or raw OTel spans are ever surfaced or stored.
 *
 * Rate: callers should debounce; this endpoint does real DB work per call.
 * The underlying upsert is idempotent, so duplicate calls are safe but
 * wasteful. Dashboard clients should throttle to ≤1 call per 15 s.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/current-user";
import { sql } from "@/lib/db";
import {
  refreshHourlyAggregates,
  pruneHourlyAggregates,
  HOURLY_RETENTION_HRS,
} from "@/lib/peer-share-hourly-aggregate";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // 1 min — scoped to one viewer's grants

const SyncBodySchema = z.object({
  owner_id: z.string().uuid().optional(),
});

export async function POST(req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    // Empty or missing body is fine — treat as {}
    rawBody = {};
  }

  const parsed = SyncBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { owner_id: requestedOwnerId } = parsed.data;

  const db = sql();

  // Build the WHERE clause: only look at active grants where the caller is
  // the viewer. If owner_id is supplied, scope to that single pair.
  const grants = requestedOwnerId
    ? await db<{ owner_id: string; viewer_id: string }[]>`
        SELECT owner_id::text AS owner_id, viewer_id::text AS viewer_id
        FROM peer_share
        WHERE viewer_id = ${me.id}::uuid
          AND owner_id  = ${requestedOwnerId}::uuid
          AND revoked_at IS NULL
      `
    : await db<{ owner_id: string; viewer_id: string }[]>`
        SELECT owner_id::text AS owner_id, viewer_id::text AS viewer_id
        FROM peer_share
        WHERE viewer_id = ${me.id}::uuid
          AND revoked_at IS NULL
      `;

  if (grants.length === 0) {
    return NextResponse.json({
      ok: true,
      pairs: 0,
      rows_upserted: 0,
      rows_pruned: 0,
      elapsed_ms: 0,
    });
  }

  const startedAt = Date.now();
  log.info({
    msg: "peer-share-sync: starting on-demand refresh",
    viewer_id: me.id,
    pairs: grants.length,
  });

  let rowsUpserted = 0;
  for (const { owner_id, viewer_id } of grants) {
    const since = new Date(Date.now() - HOURLY_RETENTION_HRS * 3_600_000);
    try {
      rowsUpserted += await refreshHourlyAggregates(owner_id, viewer_id, since);
    } catch (err) {
      log.error({
        msg: "peer-share-sync: pair refresh failed",
        owner_id,
        viewer_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Prune expired rows opportunistically (same as cron).
  const rowsPruned = await pruneHourlyAggregates();

  const elapsed_ms = Date.now() - startedAt;
  log.info({
    msg: "peer-share-sync: done",
    elapsed_ms,
    pairs: grants.length,
    rows_upserted: rowsUpserted,
    rows_pruned: rowsPruned,
  });

  return NextResponse.json({
    ok: true,
    pairs: grants.length,
    rows_upserted: rowsUpserted,
    rows_pruned: rowsPruned,
    elapsed_ms,
  });
}
