/**
 * peer-share-dimensional-agg.ts — cross-dimensional materialised aggregates.
 *
 * Produces daily cost/token breakdowns sliced by model, source, and language
 * for a single peer-share grant. These are the building blocks for the
 * drill-down filters on the /app heatmap and team-metrics dashboards.
 *
 * Called by:
 *   • /api/cron/peer-share-dimensional-agg (hourly cron, runs after
 *     peer-share-hourly-agg)
 *   • /api/dashboard/peer-share-dimensions (read path — queries the three
 *     materialized tables, never this module directly)
 *
 * Design
 * ------
 * Model + source dimensions are derived by rolling up
 * peer_share_hourly_aggregate (already materialised, fast).
 *
 * Language dimension is derived by querying activity_event directly because
 * the hourly aggregate does not carry a language column. The query is gated
 * by the same EXISTS(peer_share grant) privacy guard used everywhere else.
 *
 * Retention: rows older than DIMENSIONAL_RETENTION_DAYS (30) are pruned on
 * each cron run by the cron route.
 *
 * Privacy floor: metadata only — counts, costs, source enums, model names,
 * language tags. No prompts, completions, code, diffs, or raw OTel spans.
 * Identical guarantee to peer_share_daily_aggregate.
 */

import { sql } from "@/lib/db";
import { log } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Retention window — matches peer_share_daily_aggregate. */
export const DIMENSIONAL_RETENTION_DAYS = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One row of a dimensional aggregate (model | source | language). */
export interface DimensionalAggRow {
  dimensionValue: string;
  costMillicents: number;
  tokensInput: number;
  tokensOutput: number;
  eventCount: number;
}

/** The result of one materializeDimensionalAggregates call. */
export interface DimensionalAggResult {
  byModel: DimensionalAggRow[];
  bySource: DimensionalAggRow[];
  byLanguage: DimensionalAggRow[];
}

// Internal DB row shape returned by the GROUP BY queries.
interface RawDimRow {
  dimension_value: string;
  cost_millicents: string | number;
  tokens_input: string | number;
  tokens_output: string | number;
  event_count: string | number;
}

function mapRaw(r: RawDimRow): DimensionalAggRow {
  return {
    dimensionValue: r.dimension_value ?? "",
    costMillicents: Number(r.cost_millicents ?? 0),
    tokensInput: Number(r.tokens_input ?? 0),
    tokensOutput: Number(r.tokens_output ?? 0),
    eventCount: Number(r.event_count ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Core materialisation function
// ---------------------------------------------------------------------------

/**
 * Compute dimensional aggregates for one (owner, viewer) grant for a single
 * UTC calendar date bucket (e.g. "2026-06-29").
 *
 * Reads from peer_share_hourly_aggregate (model + source dimensions) and
 * activity_event (language dimension). The grant's EXISTS check is applied
 * to both queries — no data flows if the grant is revoked.
 *
 * Returns { byModel, bySource, byLanguage } — each an array of rows sorted
 * by cost_millicents DESC. Empty arrays when there is no data for the bucket.
 */
export async function materializeDimensionalAggregates(
  shareId: string,
  ownerId: string,
  viewerId: string,
  bucketDate: string,  // "YYYY-MM-DD" UTC calendar date
): Promise<DimensionalAggResult> {
  const db = sql();

  // The bucket covers the full UTC day [bucket 00:00, bucket+1 00:00).
  const bucketStart = `${bucketDate}T00:00:00.000Z`;
  const bucketEnd   = new Date(
    new Date(bucketStart).getTime() + 86_400_000,
  ).toISOString();

  // Shared grant gate fragment — prevents data flowing on revoked grants.
  // Used in both queries below.

  // ── Model dimension — roll up from peer_share_hourly_aggregate ────────────

  const modelRows = await db<RawDimRow[]>`
    SELECT
      COALESCE(NULLIF(model, ''), '')                  AS dimension_value,
      SUM(cost_millicents)::bigint                     AS cost_millicents,
      SUM(tokens_input)::bigint                        AS tokens_input,
      SUM(tokens_output)::bigint                       AS tokens_output,
      SUM(event_count)::int                            AS event_count
    FROM peer_share_hourly_aggregate
    WHERE owner_id  = ${ownerId}::uuid
      AND viewer_id = ${viewerId}::uuid
      AND hour_bucket >= ${bucketStart}::timestamptz
      AND hour_bucket <  ${bucketEnd}::timestamptz
      AND EXISTS (
        SELECT 1 FROM peer_share ps
        WHERE ps.id         = ${shareId}::uuid
          AND ps.owner_id   = ${ownerId}::uuid
          AND ps.viewer_id  = ${viewerId}::uuid
          AND ps.revoked_at IS NULL
      )
    GROUP BY 1
    ORDER BY SUM(cost_millicents) DESC
  `;

  // ── Source dimension — roll up from peer_share_hourly_aggregate ───────────

  const sourceRows = await db<RawDimRow[]>`
    SELECT
      COALESCE(NULLIF(source, ''), '')                 AS dimension_value,
      SUM(cost_millicents)::bigint                     AS cost_millicents,
      SUM(tokens_input)::bigint                        AS tokens_input,
      SUM(tokens_output)::bigint                       AS tokens_output,
      SUM(event_count)::int                            AS event_count
    FROM peer_share_hourly_aggregate
    WHERE owner_id  = ${ownerId}::uuid
      AND viewer_id = ${viewerId}::uuid
      AND hour_bucket >= ${bucketStart}::timestamptz
      AND hour_bucket <  ${bucketEnd}::timestamptz
      AND EXISTS (
        SELECT 1 FROM peer_share ps
        WHERE ps.id         = ${shareId}::uuid
          AND ps.owner_id   = ${ownerId}::uuid
          AND ps.viewer_id  = ${viewerId}::uuid
          AND ps.revoked_at IS NULL
      )
    GROUP BY 1
    ORDER BY SUM(cost_millicents) DESC
  `;

  // ── Language dimension — query activity_event directly ────────────────────
  // peer_share_hourly_aggregate has no language column, so we go to the source.
  // The grant EXISTS gate is the same privacy guard.

  const langRows = await db<RawDimRow[]>`
    SELECT
      COALESCE(NULLIF(ae.language, ''), '')            AS dimension_value,
      COALESCE(SUM(ae.cost_millicents), 0)::bigint     AS cost_millicents,
      COALESCE(SUM(ae.tokens_input),  0)::bigint       AS tokens_input,
      COALESCE(SUM(ae.tokens_output), 0)::bigint       AS tokens_output,
      COUNT(*)::int                                    AS event_count
    FROM activity_event ae
    WHERE ae.user_id = ${ownerId}::uuid
      AND ae.ts >= ${bucketStart}::timestamptz
      AND ae.ts <  ${bucketEnd}::timestamptz
      AND EXISTS (
        SELECT 1 FROM peer_share ps
        WHERE ps.id         = ${shareId}::uuid
          AND ps.owner_id   = ${ownerId}::uuid
          AND ps.viewer_id  = ${viewerId}::uuid
          AND ps.revoked_at IS NULL
      )
    GROUP BY 1
    ORDER BY SUM(ae.cost_millicents) DESC NULLS LAST
  `;

  return {
    byModel:    modelRows.map(mapRaw),
    bySource:   sourceRows.map(mapRaw),
    byLanguage: langRows.map(mapRaw),
  };
}

// ---------------------------------------------------------------------------
// Upsert helpers
// ---------------------------------------------------------------------------

/**
 * Upsert model-dimension rows for one (share, bucket_date) into
 * peer_share_daily_agg_by_model.
 */
async function upsertByModel(
  shareId: string,
  ownerId: string,
  viewerId: string,
  bucketDate: string,
  rows: DimensionalAggRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const db = sql();
  let upserted = 0;
  for (const r of rows) {
    await db`
      INSERT INTO peer_share_daily_agg_by_model
        (share_id, owner_id, viewer_id, bucket_date, dimension_value,
         cost_millicents, tokens_input, tokens_output, event_count, computed_at)
      VALUES (
        ${shareId}::uuid, ${ownerId}::uuid, ${viewerId}::uuid,
        ${bucketDate}::date, ${r.dimensionValue},
        ${r.costMillicents}, ${r.tokensInput}, ${r.tokensOutput},
        ${r.eventCount}, NOW()
      )
      ON CONFLICT (share_id, bucket_date, dimension_value) DO UPDATE SET
        cost_millicents = EXCLUDED.cost_millicents,
        tokens_input    = EXCLUDED.tokens_input,
        tokens_output   = EXCLUDED.tokens_output,
        event_count     = EXCLUDED.event_count,
        computed_at     = EXCLUDED.computed_at
    `;
    upserted++;
  }
  return upserted;
}

/**
 * Upsert source-dimension rows into peer_share_daily_agg_by_source.
 */
async function upsertBySource(
  shareId: string,
  ownerId: string,
  viewerId: string,
  bucketDate: string,
  rows: DimensionalAggRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const db = sql();
  let upserted = 0;
  for (const r of rows) {
    await db`
      INSERT INTO peer_share_daily_agg_by_source
        (share_id, owner_id, viewer_id, bucket_date, dimension_value,
         cost_millicents, tokens_input, tokens_output, event_count, computed_at)
      VALUES (
        ${shareId}::uuid, ${ownerId}::uuid, ${viewerId}::uuid,
        ${bucketDate}::date, ${r.dimensionValue},
        ${r.costMillicents}, ${r.tokensInput}, ${r.tokensOutput},
        ${r.eventCount}, NOW()
      )
      ON CONFLICT (share_id, bucket_date, dimension_value) DO UPDATE SET
        cost_millicents = EXCLUDED.cost_millicents,
        tokens_input    = EXCLUDED.tokens_input,
        tokens_output   = EXCLUDED.tokens_output,
        event_count     = EXCLUDED.event_count,
        computed_at     = EXCLUDED.computed_at
    `;
    upserted++;
  }
  return upserted;
}

/**
 * Upsert language-dimension rows into peer_share_daily_agg_by_language.
 */
async function upsertByLanguage(
  shareId: string,
  ownerId: string,
  viewerId: string,
  bucketDate: string,
  rows: DimensionalAggRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const db = sql();
  let upserted = 0;
  for (const r of rows) {
    await db`
      INSERT INTO peer_share_daily_agg_by_language
        (share_id, owner_id, viewer_id, bucket_date, dimension_value,
         cost_millicents, tokens_input, tokens_output, event_count, computed_at)
      VALUES (
        ${shareId}::uuid, ${ownerId}::uuid, ${viewerId}::uuid,
        ${bucketDate}::date, ${r.dimensionValue},
        ${r.costMillicents}, ${r.tokensInput}, ${r.tokensOutput},
        ${r.eventCount}, NOW()
      )
      ON CONFLICT (share_id, bucket_date, dimension_value) DO UPDATE SET
        cost_millicents = EXCLUDED.cost_millicents,
        tokens_input    = EXCLUDED.tokens_input,
        tokens_output   = EXCLUDED.tokens_output,
        event_count     = EXCLUDED.event_count,
        computed_at     = EXCLUDED.computed_at
    `;
    upserted++;
  }
  return upserted;
}

// ---------------------------------------------------------------------------
// Cron entry point
// ---------------------------------------------------------------------------

/** Summary counters returned by the cron entry point. */
export interface DimensionalAggCronResult {
  pairs: number;
  bucketsProcessed: number;
  rowsUpserted: number;
  errors: string[];
}

/**
 * Entry point used by the cron route.
 *
 * For every active (non-revoked) peer_share grant, refreshes the last
 * DIMENSIONAL_RETENTION_DAYS of dimensional daily aggregates by:
 *   1. Building the list of UTC calendar date buckets in the rolling window.
 *   2. Calling materializeDimensionalAggregates for each (grant, bucket).
 *   3. Upserting the resulting rows into the three dimension tables.
 *   4. Pruning rows older than DIMENSIONAL_RETENTION_DAYS.
 *
 * Per-pair errors are swallowed so one bad grant doesn't abort the sweep.
 */
export async function runDimensionalAggCron(): Promise<DimensionalAggCronResult> {
  const db = sql();

  const grants = await db<{
    share_id: string;
    owner_id: string;
    viewer_id: string;
  }[]>`
    SELECT
      id::text          AS share_id,
      owner_id::text    AS owner_id,
      viewer_id::text   AS viewer_id
    FROM peer_share
    WHERE revoked_at IS NULL
  `;

  // Build the rolling list of bucket dates (today and back RETENTION days).
  const nowUtc   = new Date();
  const todayIso = nowUtc.toISOString().slice(0, 10);
  const buckets: string[] = [];
  for (let d = 0; d < DIMENSIONAL_RETENTION_DAYS; d++) {
    const dt = new Date(nowUtc.getTime() - d * 86_400_000);
    buckets.push(dt.toISOString().slice(0, 10));
  }

  let bucketsProcessed = 0;
  let rowsUpserted = 0;
  const errors: string[] = [];

  for (const grant of grants) {
    for (const bucket of buckets) {
      try {
        const result = await materializeDimensionalAggregates(
          grant.share_id,
          grant.owner_id,
          grant.viewer_id,
          bucket,
        );

        const [mu, su, lu] = await Promise.all([
          upsertByModel(grant.share_id, grant.owner_id, grant.viewer_id, bucket, result.byModel),
          upsertBySource(grant.share_id, grant.owner_id, grant.viewer_id, bucket, result.bySource),
          upsertByLanguage(grant.share_id, grant.owner_id, grant.viewer_id, bucket, result.byLanguage),
        ]);

        rowsUpserted += mu + su + lu;
        bucketsProcessed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${grant.share_id}@${bucket}: ${msg}`);
        log.error({
          msg: "peer-share-dimensional-agg: bucket failed",
          share_id: grant.share_id,
          bucket,
          err: msg,
        });
      }
    }
  }

  // Prune old rows from all three dimension tables.
  void todayIso; // used for context; pruning uses the cutoff below
  const cutoff = new Date(nowUtc.getTime() - DIMENSIONAL_RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  await Promise.all([
    db`DELETE FROM peer_share_daily_agg_by_model    WHERE bucket_date < ${cutoff}::date`,
    db`DELETE FROM peer_share_daily_agg_by_source   WHERE bucket_date < ${cutoff}::date`,
    db`DELETE FROM peer_share_daily_agg_by_language WHERE bucket_date < ${cutoff}::date`,
  ]).catch((err) => {
    log.warn({
      msg: "peer-share-dimensional-agg: prune failed (non-fatal)",
      err: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    pairs: grants.length,
    bucketsProcessed,
    rowsUpserted,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Read helpers (used by the dashboard API route)
// ---------------------------------------------------------------------------

/** Dimension type accepted by the read API. */
export type DimensionType = "model" | "source" | "language";

/** One response row for the dimensions API endpoint. */
export interface DimensionApiRow {
  dimension_value: string;
  cost_millicents: number;
  event_count: number;
  /** Simple trend: cost for the last 7 days vs prior 7 days; null when not enough data. */
  trend: number | null;
}

/**
 * Read dimensional aggregate rows for one share in a date range, sorted by
 * cost_millicents DESC.
 *
 * Queries the appropriate materialized table based on `dimension`.
 * All three tables have the same shape so we switch on the table name only.
 *
 * Returns rows sorted by cost DESC — ready for the API response.
 */
export async function readDimensionalRows(
  shareId: string,
  dimension: DimensionType,
  since: string,  // ISO date "YYYY-MM-DD"
  until: string,  // ISO date "YYYY-MM-DD"
): Promise<DimensionApiRow[]> {
  const db = sql();

  // Determine trend windows: [since, midpoint) vs [midpoint, until].
  // We compute a simple 50/50 split of the requested range.
  const sinceMs   = new Date(since).getTime();
  const untilMs   = new Date(until).getTime() + 86_400_000; // inclusive
  const midMs     = Math.floor((sinceMs + untilMs) / 2);
  const midDate   = new Date(midMs).toISOString().slice(0, 10);

  type RawRow = {
    dimension_value: string;
    cost_millicents: string | number;
    event_count: string | number;
    cost_first_half: string | number;
    cost_second_half: string | number;
  };

  let rows: RawRow[];

  if (dimension === "model") {
    rows = await db<RawRow[]>`
      SELECT
        dimension_value,
        SUM(cost_millicents)::bigint                                                AS cost_millicents,
        SUM(event_count)::int                                                       AS event_count,
        SUM(CASE WHEN bucket_date < ${midDate}::date THEN cost_millicents ELSE 0 END)::bigint AS cost_first_half,
        SUM(CASE WHEN bucket_date >= ${midDate}::date THEN cost_millicents ELSE 0 END)::bigint AS cost_second_half
      FROM peer_share_daily_agg_by_model
      WHERE share_id   = ${shareId}::uuid
        AND bucket_date >= ${since}::date
        AND bucket_date <= ${until}::date
      GROUP BY dimension_value
      ORDER BY SUM(cost_millicents) DESC
    `;
  } else if (dimension === "source") {
    rows = await db<RawRow[]>`
      SELECT
        dimension_value,
        SUM(cost_millicents)::bigint                                                AS cost_millicents,
        SUM(event_count)::int                                                       AS event_count,
        SUM(CASE WHEN bucket_date < ${midDate}::date THEN cost_millicents ELSE 0 END)::bigint AS cost_first_half,
        SUM(CASE WHEN bucket_date >= ${midDate}::date THEN cost_millicents ELSE 0 END)::bigint AS cost_second_half
      FROM peer_share_daily_agg_by_source
      WHERE share_id   = ${shareId}::uuid
        AND bucket_date >= ${since}::date
        AND bucket_date <= ${until}::date
      GROUP BY dimension_value
      ORDER BY SUM(cost_millicents) DESC
    `;
  } else {
    rows = await db<RawRow[]>`
      SELECT
        dimension_value,
        SUM(cost_millicents)::bigint                                                AS cost_millicents,
        SUM(event_count)::int                                                       AS event_count,
        SUM(CASE WHEN bucket_date < ${midDate}::date THEN cost_millicents ELSE 0 END)::bigint AS cost_first_half,
        SUM(CASE WHEN bucket_date >= ${midDate}::date THEN cost_millicents ELSE 0 END)::bigint AS cost_second_half
      FROM peer_share_daily_agg_by_language
      WHERE share_id   = ${shareId}::uuid
        AND bucket_date >= ${since}::date
        AND bucket_date <= ${until}::date
      GROUP BY dimension_value
      ORDER BY SUM(cost_millicents) DESC
    `;
  }

  return rows.map((r) => {
    const first  = Number(r.cost_first_half ?? 0);
    const second = Number(r.cost_second_half ?? 0);
    // trend: % change from first half to second half; null when first half is 0.
    const trend = first > 0
      ? Math.round(((second - first) / first) * 10_000) / 100
      : null;

    return {
      dimension_value: r.dimension_value,
      cost_millicents: Number(r.cost_millicents ?? 0),
      event_count:     Number(r.event_count ?? 0),
      trend,
    };
  });
}
