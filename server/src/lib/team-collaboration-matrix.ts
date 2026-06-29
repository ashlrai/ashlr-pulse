/**
 * team-collaboration-matrix.ts — SQL helper for the peer collaboration heatmap.
 *
 * Queries `peer_share_hourly_aggregate` to build a 2D collaboration matrix:
 *   - Y axis: unique team members (owner_ids visible to the current viewer)
 *   - X axis: hourly time buckets over a 7-day rolling window
 *   - Cell value: total cost_millicents burned in that hour bucket by that owner
 *
 * Privacy floor:
 *   - Only numeric aggregates — no prompts, code, or raw content.
 *   - Respects peer_share grant restrictions (revoked grants excluded by the
 *     underlying table — rows are never written for revoked pairs).
 *   - Respects the `fields` column: we surface cost_millicents only, which is
 *     always present in valid peer_share grants.
 *   - Cross-org visibility: a viewer only sees owners who have granted them
 *     access via a non-revoked peer_share row.
 *
 * All functions are pure SQL — no business logic leaks into the DB layer.
 */

import { sql } from "@/lib/db";

// ─── Types ────────────────────────────────────────────────────────────────────

/** One cell in the collaboration matrix. */
export interface MatrixCell {
  /** Owner user ID (Y axis). */
  ownerId: string;
  /** ISO-8601 hour bucket start (X axis), e.g. "2026-06-29T14:00:00.000Z" */
  hourBucket: string;
  /** Total cost in millicents for this (owner, bucket). */
  costMillicents: number;
  /** Total event count for this (owner, bucket). */
  eventCount: number;
  /** Total tokens (input + output) for this (owner, bucket). */
  totalTokens: number;
  /** Breakdown by model (model → cost_millicents). Privacy: numeric only. */
  modelBreakdown: Record<string, number>;
  /** Source that contributed most to cost in this bucket. */
  topSource: string | null;
}

/** Metadata row for one visible peer (Y-axis member). */
export interface PeerMember {
  ownerId: string;
  /** Masked email: first char + domain only, e.g. "m***@acme.com" */
  maskedEmail: string;
  /** Whether the current viewer has an active (non-revoked) grant. */
  grantActive: boolean;
  /** ISO-8601 timestamp of when the grant was created. */
  grantCreatedAt: string;
  /** Granularity agreed in the grant. */
  granularity: string;
}

/** Filter options for computeCollaborationMatrix. */
export interface CollaborationMatrixFilter {
  /** Viewer user ID — only owners who granted access to this viewer are included. */
  viewerId: string;
  /** Number of days to look back. Default: 7. Max: 30. */
  windowDays?: number;
  /** Filter to a specific model (exact match). Null = all models. */
  model?: string | null;
  /** Filter to a specific repo (LIKE pattern). Null = all repos. */
  repo?: string | null;
  /**
   * Peer relationship status toggle:
   *   "active_grants"  — owners who gave the viewer an active grant (default)
   *   "active_work"    — owners who have any cost > 0 in the window
   *   "all"            — all owners with at least one aggregate row
   */
  peerStatus?: "active_grants" | "active_work" | "all";
}

/** Full collaboration matrix result. */
export interface CollaborationMatrix {
  /** List of visible peers (Y axis), ordered by total cost DESC. */
  peers: PeerMember[];
  /** All hourly buckets in the window (X axis), ISO-8601, ASC. */
  buckets: string[];
  /** Matrix cells — sparse: only populated cells are returned. */
  cells: MatrixCell[];
  /**
   * Maximum cost_millicents across all cells — used to scale color intensity
   * so the hottest cell is always 100% saturated.
   */
  maxCostMillicents: number;
  /** Window start (ISO-8601). */
  windowStart: string;
  /** Window end (ISO-8601). */
  windowEnd: string;
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * computeCollaborationMatrix — build the full Y×X matrix for the heatmap tab.
 *
 * Steps:
 *   1. Resolve visible owners (peers who have granted the viewer access).
 *   2. Query peer_share_hourly_aggregate for those owners in the window.
 *   3. Apply model/repo filters.
 *   4. Aggregate per (owner_id, hour_bucket) — sum cost, tokens, events.
 *   5. Build per-cell model breakdown.
 *   6. Return sparse cells + full bucket list for the X axis.
 *
 * Revoked grants: the underlying table only contains rows for non-revoked
 * pairs (the upsert query has an EXISTS check). We additionally guard here
 * by only pulling owner_ids from active grants.
 */
export async function computeCollaborationMatrix(
  filter: CollaborationMatrixFilter,
): Promise<CollaborationMatrix> {
  const db = sql();

  const windowDays = Math.min(filter.windowDays ?? 7, 30);
  const peerStatus = filter.peerStatus ?? "active_grants";

  // ── 1. Compute window bounds ──────────────────────────────────────────────
  const nowMs = Date.now();
  // Truncate to hour start so buckets align cleanly.
  const windowEndMs = nowMs - (nowMs % 3_600_000) + 3_600_000;
  const windowStartMs = windowEndMs - windowDays * 24 * 3_600_000;
  const windowStart = new Date(windowStartMs).toISOString();
  const windowEnd = new Date(windowEndMs).toISOString();

  // ── 2. Resolve visible peer owner IDs ─────────────────────────────────────
  // Only include owners who have a non-revoked grant to this viewer.
  const grantRows = await db<{
    owner_id: string;
    masked_email: string;
    grant_active: boolean;
    grant_created_at: string;
    granularity: string;
  }[]>`
    SELECT
      ps.owner_id::text                                     AS owner_id,
      -- Mask email: first char + *** + @domain
      CONCAT(
        LEFT(u.email, 1),
        '***@',
        SPLIT_PART(u.email, '@', 2)
      )                                                     AS masked_email,
      (ps.revoked_at IS NULL)                              AS grant_active,
      ps.created_at::text                                  AS grant_created_at,
      ps.granularity
    FROM peer_share ps
    JOIN "user" u ON u.id = ps.owner_id
    WHERE ps.viewer_id = ${filter.viewerId}::uuid
      AND ps.revoked_at IS NULL
    ORDER BY ps.created_at ASC
  `;

  if (grantRows.length === 0) {
    // No active grants — return empty matrix.
    return {
      peers: [],
      buckets: buildBucketList(windowStartMs, windowEndMs),
      cells: [],
      maxCostMillicents: 0,
      windowStart,
      windowEnd,
    };
  }

  const ownerIds = grantRows.map((g) => g.owner_id);

  // ── 3. Query aggregate rows ───────────────────────────────────────────────
  // Fetch all rows from peer_share_hourly_aggregate for the visible owners
  // in the time window, optionally filtered by model.
  const rawRows = await db<{
    owner_id: string;
    hour_bucket: string;
    source: string;
    model: string;
    cost_millicents: string | number;
    event_count: string | number;
    tokens_input: string | number;
    tokens_output: string | number;
  }[]>`
    SELECT
      owner_id::text     AS owner_id,
      hour_bucket::text  AS hour_bucket,
      source,
      model,
      cost_millicents,
      event_count,
      tokens_input,
      tokens_output
    FROM peer_share_hourly_aggregate
    WHERE owner_id   = ANY(${ownerIds}::uuid[])
      AND viewer_id  = ${filter.viewerId}::uuid
      AND hour_bucket >= ${windowStart}::timestamptz
      AND hour_bucket <  ${windowEnd}::timestamptz
      ${filter.model ? db`AND model = ${filter.model}` : db``}
    ORDER BY hour_bucket ASC, owner_id ASC
  `;

  // ── 4. Aggregate per (owner_id, hour_bucket) ──────────────────────────────
  // Build sparse cell map: key = "ownerId::hourBucket"
  const cellMap = new Map<
    string,
    {
      ownerId: string;
      hourBucket: string;
      costMillicents: number;
      eventCount: number;
      totalTokens: number;
      modelBreakdown: Record<string, number>;
      sourceCosts: Record<string, number>;
    }
  >();

  for (const row of rawRows) {
    const cost = Number(row.cost_millicents ?? 0);
    const events = Number(row.event_count ?? 0);
    const tokens = Number(row.tokens_input ?? 0) + Number(row.tokens_output ?? 0);

    // Skip zero rows (sentinel rows from revoked-grant protection).
    if (cost === 0 && events === 0 && tokens === 0) continue;

    const key = `${row.owner_id}::${row.hour_bucket}`;
    const existing = cellMap.get(key);

    if (!existing) {
      cellMap.set(key, {
        ownerId: row.owner_id,
        hourBucket: row.hour_bucket,
        costMillicents: cost,
        eventCount: events,
        totalTokens: tokens,
        modelBreakdown: cost > 0 ? { [row.model]: cost } : {},
        sourceCosts: cost > 0 ? { [row.source]: cost } : {},
      });
    } else {
      existing.costMillicents += cost;
      existing.eventCount += events;
      existing.totalTokens += tokens;
      if (cost > 0) {
        existing.modelBreakdown[row.model] =
          (existing.modelBreakdown[row.model] ?? 0) + cost;
        existing.sourceCosts[row.source] =
          (existing.sourceCosts[row.source] ?? 0) + cost;
      }
    }
  }

  // ── 5. Apply peerStatus filter ────────────────────────────────────────────
  // Determine which owners to include based on filter.peerStatus.
  let visibleOwnerIds: Set<string>;

  if (peerStatus === "active_grants") {
    // All owners with a non-revoked grant (already filtered above).
    visibleOwnerIds = new Set(ownerIds);
  } else if (peerStatus === "active_work") {
    // Only owners who have cost > 0 in the window.
    visibleOwnerIds = new Set<string>();
    for (const cell of cellMap.values()) {
      if (cell.costMillicents > 0) visibleOwnerIds.add(cell.ownerId);
    }
  } else {
    // "all" — everyone with at least one aggregate row.
    visibleOwnerIds = new Set<string>();
    for (const cell of cellMap.values()) {
      visibleOwnerIds.add(cell.ownerId);
    }
    // Also include owners with grants even if no rows yet.
    for (const id of ownerIds) visibleOwnerIds.add(id);
  }

  // ── 6. Build output ───────────────────────────────────────────────────────
  // Build final cells array (only visible owners).
  const cells: MatrixCell[] = [];
  let maxCostMillicents = 0;

  for (const cell of cellMap.values()) {
    if (!visibleOwnerIds.has(cell.ownerId)) continue;

    const topSource =
      Object.keys(cell.sourceCosts).length > 0
        ? Object.entries(cell.sourceCosts).sort((a, b) => b[1] - a[1])[0][0]
        : null;

    cells.push({
      ownerId: cell.ownerId,
      hourBucket: cell.hourBucket,
      costMillicents: cell.costMillicents,
      eventCount: cell.eventCount,
      totalTokens: cell.totalTokens,
      modelBreakdown: cell.modelBreakdown,
      topSource,
    });

    if (cell.costMillicents > maxCostMillicents) {
      maxCostMillicents = cell.costMillicents;
    }
  }

  // Build peers list (ordered by total cost DESC over the window).
  const ownerTotals = new Map<string, number>();
  for (const cell of cells) {
    ownerTotals.set(cell.ownerId, (ownerTotals.get(cell.ownerId) ?? 0) + cell.costMillicents);
  }

  const peers: PeerMember[] = grantRows
    .filter((g) => visibleOwnerIds.has(g.owner_id))
    .sort((a, b) => (ownerTotals.get(b.owner_id) ?? 0) - (ownerTotals.get(a.owner_id) ?? 0))
    .map((g) => ({
      ownerId: g.owner_id,
      maskedEmail: g.masked_email,
      grantActive: g.grant_active,
      grantCreatedAt: g.grant_created_at,
      granularity: g.granularity,
    }));

  const buckets = buildBucketList(windowStartMs, windowEndMs);

  return {
    peers,
    buckets,
    cells,
    maxCostMillicents,
    windowStart,
    windowEnd,
  };
}

// ─── CSV export ───────────────────────────────────────────────────────────────

/**
 * Export the collaboration matrix as CSV.
 * Columns: peer_masked_email, hour_bucket, cost_millicents, event_count, total_tokens, top_source
 * Privacy: no prompts/code — numeric aggregates only. Emails are masked.
 */
export function matrixToCsv(
  matrix: CollaborationMatrix,
): string {
  const peerMap = new Map(matrix.peers.map((p) => [p.ownerId, p.maskedEmail]));
  const lines: string[] = [
    "peer_masked_email,hour_bucket,cost_millicents,event_count,total_tokens,top_source",
  ];

  // Sort for deterministic output: peer email ASC, bucket ASC.
  const sorted = [...matrix.cells].sort((a, b) => {
    const emailA = peerMap.get(a.ownerId) ?? "";
    const emailB = peerMap.get(b.ownerId) ?? "";
    if (emailA !== emailB) return emailA.localeCompare(emailB);
    return a.hourBucket.localeCompare(b.hourBucket);
  });

  for (const cell of sorted) {
    const email = peerMap.get(cell.ownerId) ?? cell.ownerId.slice(-8);
    lines.push(
      [
        csvEscape(email),
        cell.hourBucket,
        cell.costMillicents,
        cell.eventCount,
        cell.totalTokens,
        csvEscape(cell.topSource ?? ""),
      ].join(","),
    );
  }

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a complete list of hourly bucket ISO strings in [start, end).
 * Used to populate the X axis even for buckets with no data.
 */
function buildBucketList(startMs: number, endMs: number): string[] {
  const buckets: string[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    buckets.push(new Date(cursor).toISOString());
    cursor += 3_600_000;
  }
  return buckets;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
