/**
 * peer-share-hourly-aggregate.ts — query builder + incremental compute for
 * 1-hour rolling windows per (owner, viewer, source, model).
 *
 * Called by:
 *   • /api/cron/peer-share-hourly (hourly tick + nightly back-fill)
 *     — refreshes the last 72 h for all active grants.
 *   • /api/peer-share/subscribe (SSE endpoint, 15 s polling interval)
 *     — reads recent hourly buckets and streams deltas to the viewer.
 *
 * Design:
 *   One INSERT…ON CONFLICT (owner_id, viewer_id, hour_bucket, source, model)
 *   DO UPDATE row per hour bucket. The inner query aggregates activity_event
 *   for the owner within [bucket_start, bucket_start + 1 h), gated by an
 *   EXISTS check on a non-revoked peer_share grant for the (owner, viewer)
 *   pair — same privacy guard as the daily aggregate.
 *
 *   hour_bucket is stored as TIMESTAMPTZ truncated to the start of the hour
 *   (UTC) so that SSE subscribers can order by bucket and compute deltas
 *   between successive refreshes.
 *
 *   The current in-flight hour IS refreshed (unlike the daily layer which
 *   omits today) because the whole point is "what is my pair doing right
 *   now". The current bucket will be re-upserted every tick — that is
 *   intentional and safe (idempotent upsert).
 *
 * Retention: rows older than HOURLY_RETENTION_HRS (72) are pruned on each
 * cron run so the table stays bounded.
 *
 * Privacy floor: metadata only — counts, costs, source enums, model names.
 * No prompts, completions, code, diffs, or raw OTel spans.
 */

import { sql } from "@/lib/db";
import { log } from "@/lib/logger";

/** Keep 72 h of hourly rows — 3-day rolling window. */
export const HOURLY_RETENTION_HRS = 72;

/** Default rolling window refreshed on each cron tick. */
const DEFAULT_WINDOW_HRS = 72;

/** One row per (owner, viewer, hour, source, model). */
export interface PeerShareHourlyAggregate {
  ownerId: string;
  viewerId: string;
  /** ISO-8601 timestamp truncated to the hour, e.g. "2026-06-29T14:00:00.000Z" */
  hourBucket: string;
  source: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  costMillicents: number;
  eventCount: number;
  computedAt: string;
}

/**
 * Delta event emitted by the SSE endpoint — describes the aggregate values
 * for one (source, model, bucket) relative to the subscriber's last snapshot.
 */
export interface PeerShareDeltaEvent {
  type: "delta";
  ownerId: string;
  source: string;
  model: string;
  /** ISO-8601 hour bucket start */
  bucket: string;
  costDelta: number;      // millicents
  tokenDelta: number;     // total tokens (input + output)
  eventCount: number;
}

interface AggRow {
  source: string;
  model: string;
  tokens_input: string | number;
  tokens_output: string | number;
  cost_millicents: string | number;
  event_count: string | number;
}

/**
 * Refresh peer_share_hourly_aggregate for one (owner, viewer) pair, covering
 * every UTC hour from `sinceHour` (inclusive) up to and including the current
 * in-flight hour.
 *
 * Returns the number of rows upserted.
 */
export async function refreshHourlyAggregates(
  ownerId: string,
  viewerId: string,
  sinceHour: Date,
): Promise<number> {
  const db = sql();

  const nowMs = Date.now();
  // Truncate "now" to the start of the current hour.
  const currentHourMs = nowMs - (nowMs % (3_600_000));

  // Truncate sinceHour to the start of its hour.
  const sinceMs = sinceHour.getTime() - (sinceHour.getTime() % 3_600_000);

  if (sinceMs > currentHourMs) {
    return 0;
  }

  const msPerHour = 3_600_000;
  const totalHours =
    Math.round((currentHourMs - sinceMs) / msPerHour) + 1;
  const clampedHours = Math.min(totalHours, DEFAULT_WINDOW_HRS);
  const clampedSinceMs = currentHourMs - (clampedHours - 1) * msPerHour;

  const hours: Date[] = [];
  for (let h = 0; h < clampedHours; h++) {
    hours.push(new Date(clampedSinceMs + h * msPerHour));
  }

  let upserted = 0;

  for (const bucketStart of hours) {
    const bucketStartIso = bucketStart.toISOString();
    const bucketEndIso = new Date(bucketStart.getTime() + msPerHour).toISOString();

    const rows = await db<AggRow[]>`
      SELECT
        COALESCE(ae.source, '')                           AS source,
        COALESCE(ae.model,  '')                           AS model,
        COALESCE(SUM(ae.tokens_input),  0)::bigint        AS tokens_input,
        COALESCE(SUM(ae.tokens_output), 0)::bigint        AS tokens_output,
        COALESCE(SUM(ae.cost_millicents), 0)::bigint      AS cost_millicents,
        COUNT(*)::int                                     AS event_count
      FROM activity_event ae
      WHERE ae.user_id = ${ownerId}::uuid
        AND ae.ts >= ${bucketStartIso}::timestamptz
        AND ae.ts <  ${bucketEndIso}::timestamptz
        AND EXISTS (
          SELECT 1 FROM peer_share ps
          WHERE ps.owner_id  = ${ownerId}::uuid
            AND ps.viewer_id = ${viewerId}::uuid
            AND ps.revoked_at IS NULL
        )
      GROUP BY ae.source, ae.model
    `;

    for (const r of rows) {
      await db`
        INSERT INTO peer_share_hourly_aggregate
          (owner_id, viewer_id, hour_bucket, source, model,
           tokens_input, tokens_output, cost_millicents, event_count, computed_at)
        VALUES (
          ${ownerId}::uuid,
          ${viewerId}::uuid,
          ${bucketStartIso}::timestamptz,
          ${r.source ?? ""},
          ${r.model  ?? ""},
          ${Number(r.tokens_input  ?? 0)},
          ${Number(r.tokens_output ?? 0)},
          ${Number(r.cost_millicents ?? 0)},
          ${Number(r.event_count ?? 0)},
          NOW()
        )
        ON CONFLICT (owner_id, viewer_id, hour_bucket, source, model) DO UPDATE SET
          tokens_input    = EXCLUDED.tokens_input,
          tokens_output   = EXCLUDED.tokens_output,
          cost_millicents = EXCLUDED.cost_millicents,
          event_count     = EXCLUDED.event_count,
          computed_at     = EXCLUDED.computed_at
      `;
      upserted++;
    }

    // Emit a zero-row for empty buckets so the subscriber knows the hour
    // was computed (not just absent due to no activity yet).
    if (rows.length === 0) {
      await db`
        INSERT INTO peer_share_hourly_aggregate
          (owner_id, viewer_id, hour_bucket, source, model,
           tokens_input, tokens_output, cost_millicents, event_count, computed_at)
        VALUES (
          ${ownerId}::uuid, ${viewerId}::uuid,
          ${bucketStartIso}::timestamptz, '', '',
          0, 0, 0, 0, NOW()
        )
        ON CONFLICT (owner_id, viewer_id, hour_bucket, source, model) DO UPDATE SET
          computed_at = EXCLUDED.computed_at
      `;
      upserted++;
    }
  }

  return upserted;
}

/**
 * Read hourly aggregate rows for a specific (owner, viewer) pair within the
 * given [fromBucket, toBucket] range (both inclusive).
 *
 * Used by the SSE endpoint to fetch current-window aggregates on each tick.
 */
export async function readHourlyRows(
  ownerId: string,
  viewerId: string,
  fromBucket: Date,
  toBucket: Date,
): Promise<PeerShareHourlyAggregate[]> {
  const db = sql();

  const rows = await db<{
    owner_id: string;
    viewer_id: string;
    hour_bucket: string;
    source: string;
    model: string;
    tokens_input: string | number;
    tokens_output: string | number;
    cost_millicents: string | number;
    event_count: string | number;
    computed_at: string;
  }[]>`
    SELECT
      owner_id::text, viewer_id::text,
      hour_bucket::text, source, model,
      tokens_input, tokens_output, cost_millicents, event_count,
      computed_at::text
    FROM peer_share_hourly_aggregate
    WHERE owner_id  = ${ownerId}::uuid
      AND viewer_id = ${viewerId}::uuid
      AND hour_bucket >= ${fromBucket.toISOString()}::timestamptz
      AND hour_bucket <= ${toBucket.toISOString()}::timestamptz
    ORDER BY hour_bucket ASC, source, model
  `;

  return rows.map((r) => ({
    ownerId: r.owner_id,
    viewerId: r.viewer_id,
    hourBucket: r.hour_bucket,
    source: r.source,
    model: r.model,
    tokensInput: Number(r.tokens_input ?? 0),
    tokensOutput: Number(r.tokens_output ?? 0),
    costMillicents: Number(r.cost_millicents ?? 0),
    eventCount: Number(r.event_count ?? 0),
    computedAt: r.computed_at,
  }));
}

/**
 * Prune rows older than HOURLY_RETENTION_HRS from peer_share_hourly_aggregate.
 * Returns the number of rows deleted.
 */
export async function pruneHourlyAggregates(): Promise<number> {
  const db = sql();
  const cutoff = new Date(Date.now() - HOURLY_RETENTION_HRS * 3_600_000);

  const result = await db`
    DELETE FROM peer_share_hourly_aggregate
    WHERE hour_bucket < ${cutoff.toISOString()}::timestamptz
    RETURNING 1
  `;
  return result.length;
}

/**
 * Compute delta events between two snapshots of hourly rows for the same
 * (owner, viewer) pair. A "delta" is an hourly row whose cost or token
 * count has changed (or is new) compared to the previous snapshot.
 *
 * Rows are matched by (source, model, hourBucket). Only rows with a
 * non-zero delta (costDelta != 0 || tokenDelta != 0) are returned so the
 * SSE stream stays quiet during idle periods.
 *
 * Privacy guard: only aggregate numbers flow through — no raw event data.
 */
export function computeDeltas(
  ownerId: string,
  prev: PeerShareHourlyAggregate[],
  curr: PeerShareHourlyAggregate[],
): PeerShareDeltaEvent[] {
  // Build lookup from prev snapshot keyed by (source, model, hourBucket).
  const prevMap = new Map<string, PeerShareHourlyAggregate>();
  for (const row of prev) {
    prevMap.set(`${row.source}|${row.model}|${row.hourBucket}`, row);
  }

  const deltas: PeerShareDeltaEvent[] = [];
  for (const row of curr) {
    const key = `${row.source}|${row.model}|${row.hourBucket}`;
    const p = prevMap.get(key);
    const costDelta = row.costMillicents - (p?.costMillicents ?? 0);
    const tokenDelta =
      (row.tokensInput + row.tokensOutput) -
      ((p?.tokensInput ?? 0) + (p?.tokensOutput ?? 0));

    if (costDelta === 0 && tokenDelta === 0) continue;

    deltas.push({
      type: "delta",
      ownerId,
      source: row.source,
      model: row.model,
      bucket: row.hourBucket,
      costDelta,
      tokenDelta,
      eventCount: row.eventCount,
    });
  }

  // Order by bucket ASC so the client sees oldest delta first.
  deltas.sort((a, b) => a.bucket.localeCompare(b.bucket));
  return deltas;
}

/**
 * Entry point used by the cron route — refreshes the last 72 h for every
 * active (owner, viewer) peer_share pair, then prunes old rows.
 *
 * Returns summary counts.
 */
export async function runHourlyAggregateCron(): Promise<{
  pairs: number;
  rowsUpserted: number;
  rowsPruned: number;
}> {
  const db = sql();

  const pairs = await db<{ owner_id: string; viewer_id: string }[]>`
    SELECT
      owner_id::text  AS owner_id,
      viewer_id::text AS viewer_id
    FROM peer_share
    WHERE revoked_at IS NULL
  `;

  let rowsUpserted = 0;
  for (const { owner_id, viewer_id } of pairs) {
    const since = new Date(Date.now() - DEFAULT_WINDOW_HRS * 3_600_000);
    try {
      rowsUpserted += await refreshHourlyAggregates(owner_id, viewer_id, since);
    } catch (err) {
      log.error({
        msg: "peer-share-hourly: pair failed",
        owner_id,
        viewer_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const rowsPruned = await pruneHourlyAggregates();

  return { pairs: pairs.length, rowsUpserted, rowsPruned };
}
