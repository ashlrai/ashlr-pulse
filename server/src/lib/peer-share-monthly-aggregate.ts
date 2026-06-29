/**
 * peer-share-monthly-aggregate.ts — materialized monthly aggregate for the
 * peer-share "forecast + WoW insight" feature (ROADMAP v0.5).
 *
 * Called by:
 *   • /api/cron/peer-share-monthly — monthly on the 1st at 00:05 UTC.
 *     Also supports ad-hoc backfill via `sinceMonth` parameter.
 *   • /api/peer-share/subscribe — emits monthly buckets alongside hourly/weekly
 *     so SSE clients receive MoM (month-over-month) deltas.
 *
 * Design:
 *   One INSERT … ON CONFLICT (owner_id, viewer_id, month_bucket, source, model)
 *   DO UPDATE row per calendar month. The inner query sums activity_event rows
 *   for the owner within [month_start, month_start + 1 month), gated by an
 *   EXISTS check on a non-revoked peer_share grant — same privacy guard as the
 *   hourly and weekly layers.
 *
 *   month_bucket is stored as the first UTC second of the calendar month
 *   (DATE_TRUNC('month', ts AT TIME ZONE 'UTC')).
 *
 *   trend_flag is derived via an OLS fit on the prior 3 completed months using
 *   the linearRegression helper from forecast.ts. Classification:
 *     'anomaly'       — current month > mean + 2σ of prior 3 months (z>2)
 *     'trending_up'   — OLS slope > TREND_THRESHOLD_PCT of mean monthly cost
 *     'trending_down' — OLS slope < -TREND_THRESHOLD_PCT
 *     'stable'        — |slope| <= TREND_THRESHOLD_PCT
 *     null            — fewer than 2 prior months (insufficient history)
 *
 * Privacy floor: metadata only — counts, costs, source enums, model names.
 * No prompts, completions, code, diffs, or raw OTel spans.
 */

import { sql } from "@/lib/db";
import { log } from "@/lib/logger";
import { linearRegression, type SeriesPoint } from "@/lib/forecast";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Keep 13 months of monthly rows (current month + 12 prior). */
export const MONTHLY_RETENTION_MONTHS = 13;

/** Default back-fill window: refresh the last 13 months. */
const DEFAULT_WINDOW_MONTHS = 13;

/**
 * Minimum fractional slope (relative to mean monthly cost) that qualifies
 * as a directional trend. Below this the month is classified as 'stable'.
 *
 * 5% of mean per month.
 */
const TREND_THRESHOLD_PCT = 0.05;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid trend flag values. */
export type TrendFlag = "trending_up" | "trending_down" | "stable" | "anomaly" | null;

/** One row from peer_share_monthly_aggregate. */
export interface PeerShareMonthlyAggregate {
  id: number;
  ownerId: string;
  viewerId: string;
  /** ISO-8601 timestamp at start of calendar month, e.g. "2026-06-01T00:00:00.000Z" */
  monthBucket: string;
  source: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  costMillicents: number;
  eventCount: number;
  trendFlag: TrendFlag;
  computedAt: string;
}

/** Monthly SSE event emitted to subscribers. */
export interface PeerShareMonthlyEvent {
  type: "monthly";
  ownerId: string;
  /** ISO-8601 month bucket start */
  bucket: string;
  source: string;
  model: string;
  costMillicents: number;
  tokensInput: number;
  tokensOutput: number;
  eventCount: number;
  trendFlag: TrendFlag;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a Date to the start of its UTC calendar month.
 * e.g. 2026-06-15 → 2026-06-01T00:00:00.000Z
 */
export function truncateToMonthUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/**
 * Return the Date that is `months` calendar months before `from`.
 * Always lands on the 1st of the resulting month.
 */
export function subtractMonths(from: Date, months: number): Date {
  const d = truncateToMonthUTC(from);
  // setUTCMonth handles year wrap-around correctly.
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

/**
 * Compute trend_flag for the current month given the prior months' cost series.
 *
 * @param priorMonths  Cost history, oldest first (completed months only).
 * @param currentCost  Total cost for the month being classified (millicents).
 * @returns TrendFlag
 */
export function computeTrendFlag(
  priorMonths: number[],
  currentCost: number,
): TrendFlag {
  if (priorMonths.length < 2) return null;

  const mean = priorMonths.reduce((a, b) => a + b, 0) / priorMonths.length;

  // Anomaly detection: z-score of currentCost relative to prior window.
  const sigma = Math.sqrt(
    priorMonths.reduce((a, b) => a + (b - mean) ** 2, 0) / priorMonths.length,
  );
  if (sigma > 0) {
    const z = (currentCost - mean) / sigma;
    if (z > 2) return "anomaly";
  }

  // OLS fit on prior months to extract slope.
  const series: SeriesPoint[] = priorMonths.map((v, i) => ({
    ts: `2000-01-${String(i + 1).padStart(2, "0")}`, // synthetic ts — only index matters
    value: v,
  }));
  const reg = linearRegression(series);
  if (!reg) return null;

  // No baseline cost (zero-mean history) → threshold collapses to 0 and any
  // non-zero slope would be flagged as trending. Treat as stable instead.
  if (mean === 0) return "stable";

  // Stable threshold: |slope| < TREND_THRESHOLD_PCT × mean
  const threshold = Math.abs(mean) * TREND_THRESHOLD_PCT;
  if (Math.abs(reg.slope) <= threshold) return "stable";
  return reg.slope > 0 ? "trending_up" : "trending_down";
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

interface AggRow {
  month_bucket: string;
  source: string;
  model: string;
  tokens_input: string | number;
  tokens_output: string | number;
  cost_millicents: string | number;
  event_count: string | number;
}

/**
 * Aggregate activity_event rows for one (owner, viewer) pair into monthly
 * buckets covering [sinceMonth, nowMonth], returning raw DB rows.
 *
 * Privacy guard: EXISTS check on non-revoked peer_share grant.
 */
async function aggregateMonthlyBuckets(
  ownerId: string,
  viewerId: string,
  sinceMonthIso: string,
): Promise<AggRow[]> {
  const db = sql();
  return db<AggRow[]>`
    SELECT
      DATE_TRUNC('month', ae.ts AT TIME ZONE 'UTC')::timestamptz  AS month_bucket,
      COALESCE(ae.source, '')                                       AS source,
      COALESCE(ae.model,  '')                                       AS model,
      COALESCE(SUM(ae.tokens_input),    0)::bigint                  AS tokens_input,
      COALESCE(SUM(ae.tokens_output),   0)::bigint                  AS tokens_output,
      COALESCE(SUM(ae.cost_millicents), 0)::bigint                  AS cost_millicents,
      COUNT(*)::int                                                  AS event_count
    FROM activity_event ae
    WHERE ae.user_id = ${ownerId}::uuid
      AND ae.ts >= ${sinceMonthIso}::timestamptz
      AND EXISTS (
        SELECT 1 FROM peer_share ps
        WHERE ps.owner_id  = ${ownerId}::uuid
          AND ps.viewer_id = ${viewerId}::uuid
          AND ps.revoked_at IS NULL
      )
    GROUP BY 1, ae.source, ae.model
    ORDER BY 1 ASC, ae.source, ae.model
  `;
}

/**
 * Fetch the last N months of aggregate totals (cost_millicents) for an
 * (owner, viewer) pair from the already-materialized monthly table.
 * Used to supply the OLS history for trend flag computation.
 *
 * Returns costs ordered oldest → newest.
 */
async function fetchPriorMonthlyCosts(
  ownerId: string,
  viewerId: string,
  beforeMonthIso: string,
  n: number,
): Promise<number[]> {
  const db = sql();
  const rows = await db<{ cost_millicents: string | number }[]>`
    SELECT
      SUM(cost_millicents)::bigint AS cost_millicents
    FROM peer_share_monthly_aggregate
    WHERE owner_id   = ${ownerId}::uuid
      AND viewer_id  = ${viewerId}::uuid
      AND month_bucket < ${beforeMonthIso}::timestamptz
    GROUP BY month_bucket
    ORDER BY month_bucket ASC
    LIMIT ${n}
  `;
  return rows.map((r) => Number(r.cost_millicents ?? 0));
}

// ---------------------------------------------------------------------------
// Main refresh routine
// ---------------------------------------------------------------------------

/**
 * Refresh peer_share_monthly_aggregate for one (owner, viewer) pair, covering
 * the current month and the prior `windowMonths - 1` completed months.
 *
 * Steps:
 *   1. Aggregate activity_event rows into monthly buckets.
 *   2. For each bucket, compute trend_flag from the prior 3 months' costs.
 *   3. UPSERT into peer_share_monthly_aggregate (idempotent).
 *
 * Returns the number of rows upserted.
 */
export async function refreshMonthlyAggregates(
  ownerId: string,
  viewerId: string,
  windowMonths: number = DEFAULT_WINDOW_MONTHS,
): Promise<number> {
  const db = sql();

  const now = new Date();
  const sinceMonth = subtractMonths(now, windowMonths - 1);
  const sinceMonthIso = sinceMonth.toISOString();

  const aggRows = await aggregateMonthlyBuckets(ownerId, viewerId, sinceMonthIso);

  if (aggRows.length === 0) {
    // No activity — write a zero sentinel for the current month so the cron
    // run records that the pair was processed, matching the hourly layer pattern.
    const currentMonthIso = truncateToMonthUTC(now).toISOString();
    await db`
      INSERT INTO peer_share_monthly_aggregate
        (owner_id, viewer_id, month_bucket, source, model,
         tokens_input, tokens_output, cost_millicents, event_count,
         trend_flag, computed_at)
      VALUES (
        ${ownerId}::uuid, ${viewerId}::uuid,
        ${currentMonthIso}::timestamptz, '', '',
        0, 0, 0, 0, NULL, NOW()
      )
      ON CONFLICT (owner_id, viewer_id, month_bucket, source, model) DO UPDATE SET
        computed_at = EXCLUDED.computed_at
    `;
    return 1;
  }

  let upserted = 0;

  // Build a map of (monthBucket → total cost) from the freshly aggregated rows
  // so we can pass the OLS history cheaply without extra DB round-trips.
  const monthCostMap = new Map<string, number>();
  for (const r of aggRows) {
    const key = r.month_bucket;
    monthCostMap.set(key, (monthCostMap.get(key) ?? 0) + Number(r.cost_millicents ?? 0));
  }

  // Sort month buckets oldest → newest so we can build the OLS series
  // incrementally as we iterate.
  const sortedBuckets = Array.from(monthCostMap.keys()).sort();

  // Pre-fetch prior months from the DB for the OLS window (before sinceMonthIso).
  const priorFetched = await fetchPriorMonthlyCosts(ownerId, viewerId, sinceMonthIso, 3);

  for (const r of aggRows) {
    const bucketIso = r.month_bucket;

    // Build OLS history: priorFetched + all months before this bucket
    // that are inside the current aggregation window.
    const bucketsBeforeThis = sortedBuckets.filter((b) => b < bucketIso);
    const windowHistory = [
      ...priorFetched,
      ...bucketsBeforeThis.map((b) => monthCostMap.get(b) ?? 0),
    ].slice(-3); // OLS uses prior 3 months

    const trendFlag = computeTrendFlag(windowHistory, Number(r.cost_millicents ?? 0));

    await db`
      INSERT INTO peer_share_monthly_aggregate
        (owner_id, viewer_id, month_bucket, source, model,
         tokens_input, tokens_output, cost_millicents, event_count,
         trend_flag, computed_at)
      VALUES (
        ${ownerId}::uuid,
        ${viewerId}::uuid,
        ${bucketIso}::timestamptz,
        ${r.source ?? ""},
        ${r.model  ?? ""},
        ${Number(r.tokens_input    ?? 0)},
        ${Number(r.tokens_output   ?? 0)},
        ${Number(r.cost_millicents ?? 0)},
        ${Number(r.event_count     ?? 0)},
        ${trendFlag},
        NOW()
      )
      ON CONFLICT (owner_id, viewer_id, month_bucket, source, model) DO UPDATE SET
        tokens_input    = EXCLUDED.tokens_input,
        tokens_output   = EXCLUDED.tokens_output,
        cost_millicents = EXCLUDED.cost_millicents,
        event_count     = EXCLUDED.event_count,
        trend_flag      = EXCLUDED.trend_flag,
        computed_at     = EXCLUDED.computed_at
    `;
    upserted++;
  }

  return upserted;
}

// ---------------------------------------------------------------------------
// Read path (used by SSE subscribe and compare routes)
// ---------------------------------------------------------------------------

/**
 * Read monthly aggregate rows for a specific (owner, viewer) pair within the
 * given [fromMonth, toMonth] range (both inclusive by month_bucket).
 */
export async function readMonthlyRows(
  ownerId: string,
  viewerId: string,
  fromMonth: Date,
  toMonth: Date,
): Promise<PeerShareMonthlyAggregate[]> {
  const db = sql();

  const rows = await db<{
    id: string;
    owner_id: string;
    viewer_id: string;
    month_bucket: string;
    source: string;
    model: string;
    tokens_input: string | number;
    tokens_output: string | number;
    cost_millicents: string | number;
    event_count: string | number;
    trend_flag: string | null;
    computed_at: string;
  }[]>`
    SELECT
      id,
      owner_id::text,
      viewer_id::text,
      month_bucket::text,
      source,
      model,
      tokens_input,
      tokens_output,
      cost_millicents,
      event_count,
      trend_flag,
      computed_at::text
    FROM peer_share_monthly_aggregate
    WHERE owner_id  = ${ownerId}::uuid
      AND viewer_id = ${viewerId}::uuid
      AND month_bucket >= ${fromMonth.toISOString()}::timestamptz
      AND month_bucket <= ${toMonth.toISOString()}::timestamptz
    ORDER BY month_bucket ASC, source, model
  `;

  return rows.map((r) => ({
    id: Number(r.id),
    ownerId: r.owner_id,
    viewerId: r.viewer_id,
    monthBucket: r.month_bucket,
    source: r.source,
    model: r.model,
    tokensInput: Number(r.tokens_input ?? 0),
    tokensOutput: Number(r.tokens_output ?? 0),
    costMillicents: Number(r.cost_millicents ?? 0),
    eventCount: Number(r.event_count ?? 0),
    trendFlag: (r.trend_flag ?? null) as TrendFlag,
    computedAt: r.computed_at,
  }));
}

/**
 * Build PeerShareMonthlyEvent payloads from rows.
 * Used by the SSE subscribe route to fan monthly data out to connected viewers.
 */
export function buildMonthlyEvents(
  rows: PeerShareMonthlyAggregate[],
): PeerShareMonthlyEvent[] {
  return rows
    .filter((r) => r.costMillicents > 0 || r.eventCount > 0)
    .map((r) => ({
      type: "monthly" as const,
      ownerId: r.ownerId,
      bucket: r.monthBucket,
      source: r.source,
      model: r.model,
      costMillicents: r.costMillicents,
      tokensInput: r.tokensInput,
      tokensOutput: r.tokensOutput,
      eventCount: r.eventCount,
      trendFlag: r.trendFlag,
    }));
}

// ---------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------

/**
 * Prune rows older than MONTHLY_RETENTION_MONTHS from
 * peer_share_monthly_aggregate.  Returns the number of rows deleted.
 */
export async function pruneMonthlyAggregates(): Promise<number> {
  const db = sql();
  const cutoff = subtractMonths(new Date(), MONTHLY_RETENTION_MONTHS);

  const result = await db`
    DELETE FROM peer_share_monthly_aggregate
    WHERE month_bucket < ${cutoff.toISOString()}::timestamptz
    RETURNING 1
  `;
  return result.length;
}

// ---------------------------------------------------------------------------
// Cron entry point
// ---------------------------------------------------------------------------

/**
 * Entry point used by the cron route — refreshes the last 13 months for every
 * active (owner, viewer) peer_share pair, then prunes old rows.
 *
 * Returns summary counts.
 */
export async function runMonthlyAggregateCron(): Promise<{
  pairs: number;
  rowsUpserted: number;
  rowsPruned: number;
  errors: string[];
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
  const errors: string[] = [];

  for (const { owner_id, viewer_id } of pairs) {
    try {
      rowsUpserted += await refreshMonthlyAggregates(owner_id, viewer_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${owner_id}→${viewer_id}: ${msg}`);
      log.error({
        msg: "peer-share-monthly: pair failed",
        owner_id,
        viewer_id,
        err: msg,
      });
    }
  }

  const rowsPruned = await pruneMonthlyAggregates();

  return { pairs: pairs.length, rowsUpserted, rowsPruned, errors };
}
