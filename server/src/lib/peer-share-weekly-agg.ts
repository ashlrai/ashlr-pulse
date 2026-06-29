/**
 * peer-share-weekly-agg.ts — weekly materialised aggregate for the
 * peer-share week-over-week (WoW) trend dashboard.
 *
 * Rolls up peer_share_hourly_aggregate rows into ISO-week buckets
 * (Monday 00:00 UTC) for every active (owner, viewer) grant.
 *
 * Called by:
 *   • /api/cron/peer-share-weekly-agg — Monday 00:05 UTC
 *   • /app/compare/week-over-week — reads WoW rows to build the UI
 *
 * Design:
 *   One INSERT…ON CONFLICT (owner_id, viewer_id, week_start_iso, field)
 *   DO UPDATE row per (pair × week × field). The inner query sums the
 *   hourly-aggregate rows for each week bucket, gated by a non-revoked
 *   peer_share grant — same privacy guard as the hourly layer.
 *
 *   week_start_iso is "YYYY-MM-DD" for the Monday that starts the ISO week
 *   (UTC). We derive it by flooring each hour_bucket to the preceding
 *   Monday: Monday = bucket - (DOW + 6) % 7 days.
 *
 * Fields aggregated (SHAREABLE_FIELDS subset):
 *   cost_millicents, tokens_input, tokens_output, event_count,
 *   distinct_repos, distinct_models, tool_calls_total
 *
 * WoW delta formula (pure, no DB):
 *   delta% = (thisWeek - lastWeek) / lastWeek * 100
 *   Returns 0 when lastWeek === 0 (no prior data).
 *
 * Privacy floor: only fields present in the grant's fields[] array are
 * returned by readWeeklyRows; the DB stores all shareable fields but the
 * read path filters to the viewer's granted set.
 */

import { sql } from "@/lib/db";
import { log } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fields we aggregate into the weekly table. */
export const WEEKLY_FIELDS = [
  "cost_millicents",
  "tokens_input",
  "tokens_output",
  "event_count",
  "distinct_repos",
  "distinct_models",
  "tool_calls_total",
] as const;

export type WeeklyField = (typeof WEEKLY_FIELDS)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One row from peer_share_weekly_aggregate. */
export interface PeerShareWeeklyRow {
  id: number;
  ownerId: string;
  viewerId: string;
  /** "YYYY-MM-DD" — the Monday that opens this ISO week (UTC). */
  weekStartIso: string;
  field: WeeklyField;
  value: number;
  upsertedAt: string;
}

/** Aggregated weekly totals for one (owner, viewer, week) triple. */
export interface WeeklyTotals {
  weekStartIso: string;
  costMillicents: number;
  tokensInput: number;
  tokensOutput: number;
  eventCount: number;
  distinctRepos: number;
  distinctModels: number;
  toolCallsTotal: number;
}

/** WoW delta result for one metric field. */
export interface WowDelta {
  field: WeeklyField;
  thisWeek: number;
  lastWeek: number;
  /** Percentage change: (thisWeek - lastWeek) / lastWeek * 100. 0 when lastWeek===0. */
  deltaPct: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable, no DB)
// ---------------------------------------------------------------------------

/**
 * Compute week-over-week delta percentage.
 *
 * Returns 0 when lastWeek is 0 (no division by zero).
 * Result is rounded to 2 decimal places.
 */
export function computeWowDeltaPct(thisWeek: number, lastWeek: number): number {
  if (lastWeek === 0) return 0;
  return Math.round(((thisWeek - lastWeek) / lastWeek) * 10_000) / 100;
}

/**
 * Given two WeeklyTotals objects (this week and last week), produce an array
 * of WowDelta entries — one per aggregated field.
 */
export function buildWowDeltas(
  thisWeek: WeeklyTotals,
  lastWeek: WeeklyTotals,
): WowDelta[] {
  return WEEKLY_FIELDS.map((field) => {
    const tw = thisWeek[fieldToKey(field)];
    const lw = lastWeek[fieldToKey(field)];
    return {
      field,
      thisWeek: tw,
      lastWeek: lw,
      deltaPct: computeWowDeltaPct(tw, lw),
    };
  });
}

/** Convert a DB field name to a WeeklyTotals key. */
function fieldToKey(field: WeeklyField): keyof Omit<WeeklyTotals, "weekStartIso"> {
  const map: Record<WeeklyField, keyof Omit<WeeklyTotals, "weekStartIso">> = {
    cost_millicents: "costMillicents",
    tokens_input:    "tokensInput",
    tokens_output:   "tokensOutput",
    event_count:     "eventCount",
    distinct_repos:  "distinctRepos",
    distinct_models: "distinctModels",
    tool_calls_total: "toolCallsTotal",
  };
  return map[field];
}

/**
 * Derive the ISO-week start (Monday 00:00 UTC) for a given date.
 * Returns "YYYY-MM-DD".
 */
export function isoWeekStart(date: Date): string {
  // JS getUTCDay(): 0=Sun, 1=Mon, …, 6=Sat
  // Monday offset: (getUTCDay() + 6) % 7  → Mon=0, Tue=1, …, Sun=6
  const d = new Date(date);
  const dayOffset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayOffset);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// ---------------------------------------------------------------------------
// DB read
// ---------------------------------------------------------------------------

/**
 * Read weekly aggregate rows for a specific (owner, viewer) pair,
 * filtering to only the fields present in the granted fields[] array.
 *
 * Returns rows for the two most recent weeks (this week + last week)
 * relative to the given `asOf` date.
 */
export async function readWeeklyRows(
  ownerId: string,
  viewerId: string,
  grantedFields: string[],
  asOf: Date = new Date(),
): Promise<PeerShareWeeklyRow[]> {
  const db = sql();

  const thisWeekIso  = isoWeekStart(asOf);
  // Last week = this week minus 7 days
  const lastWeekDate = new Date(asOf);
  lastWeekDate.setUTCDate(lastWeekDate.getUTCDate() - 7);
  const lastWeekIso  = isoWeekStart(lastWeekDate);

  // Only return fields the viewer's grant allows.
  const allowedFields = WEEKLY_FIELDS.filter((f) => grantedFields.includes(f));
  if (allowedFields.length === 0) return [];

  const rows = await db<{
    id: string;
    owner_id: string;
    viewer_id: string;
    week_start_iso: string;
    field: string;
    value: string | number;
    upserted_at: string;
  }[]>`
    SELECT
      id,
      owner_id::text,
      viewer_id::text,
      week_start_iso,
      field,
      value,
      upserted_at::text
    FROM peer_share_weekly_aggregate
    WHERE owner_id  = ${ownerId}::uuid
      AND viewer_id = ${viewerId}::uuid
      AND week_start_iso IN (${thisWeekIso}, ${lastWeekIso})
      AND field = ANY(${allowedFields}::text[])
    ORDER BY week_start_iso DESC, field
  `;

  return rows.map((r) => ({
    id: Number(r.id),
    ownerId: r.owner_id,
    viewerId: r.viewer_id,
    weekStartIso: r.week_start_iso,
    field: r.field as WeeklyField,
    value: Number(r.value ?? 0),
    upsertedAt: r.upserted_at,
  }));
}

/**
 * Collapse a flat list of PeerShareWeeklyRow into a WeeklyTotals object.
 * Missing fields default to 0.
 */
export function rowsToTotals(
  rows: PeerShareWeeklyRow[],
  weekStartIso: string,
): WeeklyTotals {
  const totals: WeeklyTotals = {
    weekStartIso,
    costMillicents:  0,
    tokensInput:     0,
    tokensOutput:    0,
    eventCount:      0,
    distinctRepos:   0,
    distinctModels:  0,
    toolCallsTotal:  0,
  };
  for (const r of rows) {
    if (r.weekStartIso !== weekStartIso) continue;
    const key = fieldToKey(r.field);
    totals[key] = r.value;
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Refresh routine
// ---------------------------------------------------------------------------

/**
 * Refresh peer_share_weekly_aggregate for one (owner, viewer) pair,
 * covering every ISO week that has hourly rows from `since` onward.
 *
 * Reads from peer_share_hourly_aggregate — does NOT re-scan activity_event —
 * so this is fast (aggregation of already-aggregated data).
 *
 * Returns the number of rows upserted.
 */
export async function refreshWeeklyAggregates(
  ownerId: string,
  viewerId: string,
  since: Date,
): Promise<number> {
  const db = sql();

  // Aggregate hourly rows into weekly buckets in a single query.
  // Week start = Monday 00:00 UTC computed by flooring to DOW offset.
  //
  // For distinct_repos and distinct_models we can't compute true cardinality
  // from the pre-aggregated hourly layer (it stores sums not sets). We use
  // COUNT(DISTINCT model) / COUNT(DISTINCT source) over the hourly rows as
  // an approximation; for repos there's no repo column in hourly agg so we
  // return 0 as a placeholder (future work: add repo_hash column to hourly agg).
  //
  // tool_calls_total: not stored in hourly agg; default 0 (placeholder).

  const sinceIso = since.toISOString();

  const weekRows = await db<{
    week_start_iso: string;
    cost_millicents: string | number;
    tokens_input: string | number;
    tokens_output: string | number;
    event_count: string | number;
    distinct_models: string | number;
  }[]>`
    SELECT
      TO_CHAR(
        DATE_TRUNC('week', hour_bucket AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
        'YYYY-MM-DD'
      )                                     AS week_start_iso,
      SUM(cost_millicents)::bigint          AS cost_millicents,
      SUM(tokens_input)::bigint             AS tokens_input,
      SUM(tokens_output)::bigint            AS tokens_output,
      SUM(event_count)::bigint              AS event_count,
      COUNT(DISTINCT NULLIF(model,''))::int AS distinct_models
    FROM peer_share_hourly_aggregate
    WHERE owner_id  = ${ownerId}::uuid
      AND viewer_id = ${viewerId}::uuid
      AND hour_bucket >= ${sinceIso}::timestamptz
      AND EXISTS (
        SELECT 1 FROM peer_share ps
        WHERE ps.owner_id  = ${ownerId}::uuid
          AND ps.viewer_id = ${viewerId}::uuid
          AND ps.revoked_at IS NULL
      )
    GROUP BY 1
    ORDER BY 1
  `;

  if (weekRows.length === 0) return 0;

  let upserted = 0;

  for (const wr of weekRows) {
    const weekIso = wr.week_start_iso;

    const fieldValues: Record<WeeklyField, number> = {
      cost_millicents:  Number(wr.cost_millicents  ?? 0),
      tokens_input:     Number(wr.tokens_input     ?? 0),
      tokens_output:    Number(wr.tokens_output    ?? 0),
      event_count:      Number(wr.event_count      ?? 0),
      distinct_repos:   0, // placeholder — hourly agg has no repo column
      distinct_models:  Number(wr.distinct_models  ?? 0),
      tool_calls_total: 0, // placeholder — hourly agg has no tool_calls column
    };

    for (const field of WEEKLY_FIELDS) {
      await db`
        INSERT INTO peer_share_weekly_aggregate
          (owner_id, viewer_id, week_start_iso, field, value, upserted_at)
        VALUES (
          ${ownerId}::uuid,
          ${viewerId}::uuid,
          ${weekIso},
          ${field},
          ${fieldValues[field]},
          NOW()
        )
        ON CONFLICT (owner_id, viewer_id, week_start_iso, field) DO UPDATE SET
          value       = EXCLUDED.value,
          upserted_at = EXCLUDED.upserted_at
      `;
      upserted++;
    }
  }

  return upserted;
}

/**
 * Entry point used by the cron route — refreshes the last 8 weeks for every
 * active (owner, viewer) peer_share pair.
 *
 * Returns summary counts.
 */
export async function runWeeklyAggregateCron(): Promise<{
  pairs: number;
  rowsUpserted: number;
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

  // Look back 8 weeks so we always have at least 2 full weeks for WoW diff.
  const since = new Date(Date.now() - 8 * 7 * 24 * 3_600_000);

  let rowsUpserted = 0;
  const errors: string[] = [];

  for (const { owner_id, viewer_id } of pairs) {
    try {
      rowsUpserted += await refreshWeeklyAggregates(owner_id, viewer_id, since);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${owner_id}→${viewer_id}: ${msg}`);
      log.error({
        msg: "peer-share-weekly: pair failed",
        owner_id,
        viewer_id,
        err: msg,
      });
    }
  }

  return { pairs: pairs.length, rowsUpserted, errors };
}
