/**
 * GET /api/dashboard/peer-share-dimensions
 *
 * Returns materialised cost/token breakdowns for a peer-share grant sliced
 * by one dimension (model | source | language), over an optional date range.
 *
 * ─── Query params ────────────────────────────────────────────────────────────
 *
 *   ?shareId=<uuid>          — required; the peer_share.id to query.
 *   ?dimension=model|source|language — required; which dimension table to read.
 *   ?since=YYYY-MM-DD        — optional; defaults to 30 days ago.
 *   ?until=YYYY-MM-DD        — optional; defaults to today (UTC).
 *
 * ─── Auth / peer-share gate ──────────────────────────────────────────────────
 *
 * Callers must be authenticated. The endpoint enforces that:
 *   - The caller is the owner OR viewer of the share, OR
 *   - The caller is an org admin who can see org-member shares.
 * A missing or revoked grant returns 403.
 *
 * ─── Privacy floor ───────────────────────────────────────────────────────────
 *
 * Only aggregate counts, costs, and dimension labels flow through.
 * No prompts, completions, code, diffs, or raw OTel spans are returned.
 *
 * ─── Response shape ──────────────────────────────────────────────────────────
 *
 * {
 *   dimension: "model" | "source" | "language",
 *   since: "YYYY-MM-DD",
 *   until: "YYYY-MM-DD",
 *   rows: Array<{
 *     dimension_value: string,
 *     cost_millicents:  number,
 *     event_count:      number,
 *     trend:            number | null,  // % change first-half → second-half of range
 *   }>
 * }
 *
 * Rows are sorted by cost_millicents DESC. Empty array when no data.
 */

import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { sql } from "@/lib/db";
import { log } from "@/lib/logger";
import {
  readDimensionalRows,
  type DimensionType,
} from "@/lib/peer-share-dimensional-agg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── Validation helpers ───────────────────────────────────────────────────────

const VALID_DIMENSIONS = new Set<string>(["model", "source", "language"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDimension(v: string | null): v is DimensionType {
  return v !== null && VALID_DIMENSIONS.has(v);
}

function isValidDate(v: string | null): v is string {
  return v !== null && DATE_RE.test(v);
}

/** Clamp a date string to [minDate, maxDate] range (strings compared lexicographically). */
function clampDate(date: string, min: string, max: string): string {
  if (date < min) return min;
  if (date > max) return max;
  return date;
}

/** "YYYY-MM-DD" for `daysAgo` UTC days before today. */
function daysAgoIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

// ─── Grant access gate ────────────────────────────────────────────────────────

/**
 * Verify that userId is the owner or viewer of the given share.
 * Returns { ownerId, viewerId } on success, null on failure.
 */
async function verifyShareAccess(
  shareId: string,
  userId: string,
): Promise<{ ownerId: string; viewerId: string } | null> {
  const db = sql();

  const rows = await db<{ owner_id: string; viewer_id: string }[]>`
    SELECT owner_id::text AS owner_id, viewer_id::text AS viewer_id
    FROM peer_share
    WHERE id         = ${shareId}::uuid
      AND revoked_at IS NULL
      AND (owner_id = ${userId}::uuid OR viewer_id = ${userId}::uuid)
    LIMIT 1
  `.catch(() => [] as { owner_id: string; viewer_id: string }[]);

  if (rows.length === 0) return null;
  return { ownerId: rows[0].owner_id, viewerId: rows[0].viewer_id };
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<Response> {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;

  // Validate shareId.
  const shareId = params.get("shareId");
  if (!shareId || !UUID_RE.test(shareId)) {
    return NextResponse.json(
      { error: "shareId query param is required (UUID)" },
      { status: 400 },
    );
  }

  // Validate dimension.
  const dimensionRaw = params.get("dimension");
  if (!isValidDimension(dimensionRaw)) {
    return NextResponse.json(
      { error: "dimension must be one of: model, source, language" },
      { status: 400 },
    );
  }
  const dimension: DimensionType = dimensionRaw;

  // Resolve date range — default to last 30 days.
  const todayIso    = new Date().toISOString().slice(0, 10);
  const defaultSince = daysAgoIso(30);

  const sinceRaw = params.get("since");
  const untilRaw = params.get("until");

  const since = isValidDate(sinceRaw)
    ? clampDate(sinceRaw, daysAgoIso(90), todayIso)  // max 90d lookback
    : defaultSince;
  const until = isValidDate(untilRaw)
    ? clampDate(untilRaw, since, todayIso)
    : todayIso;

  // Grant access gate.
  const grant = await verifyShareAccess(shareId, me.id);
  if (!grant) {
    log.warn({
      msg: "peer-share-dimensions: access denied",
      user_id: me.id,
      share_id: shareId,
    });
    return NextResponse.json(
      { error: "no access to this peer share" },
      { status: 403 },
    );
  }

  log.info({
    msg: "peer-share-dimensions: loading",
    user_id: me.id,
    share_id: shareId,
    dimension,
    since,
    until,
  });

  const rows = await readDimensionalRows(shareId, dimension, since, until);

  return NextResponse.json({
    dimension,
    since,
    until,
    rows,
  });
}
