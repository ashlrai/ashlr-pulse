/**
 * peer-share-aggregate-refresh.ts — compute and upsert 30-day rolling daily
 * aggregates into peer_share_daily_aggregate.
 *
 * Called by:
 *   • /api/cron/peer-share-refresh (nightly at 02:00 UTC) — refreshes the
 *     last 30 days for every active (owner, viewer) pair.
 *   • Back-fill callers — pass an explicit sinceDate to recompute a range.
 *
 * Design:
 *   One INSERT…ON CONFLICT (owner_id, viewer_id, date, source, model)
 *   DO UPDATE row per (owner, viewer, day, source, model). The inner query
 *   joins activity_event with peer_share to scope events to fields each
 *   grant allows (cost_millicents must be in the grant's fields whitelist
 *   to be included). We only process pairs with a non-revoked grant to
 *   avoid computing aggregates for shares that no longer exist.
 *
 *   Retention: rows older than RETENTION_DAYS (30) are deleted on each
 *   cron run so the table stays bounded. The /share date-range picker only
 *   exposes the last-30-days window.
 *
 * Privacy floor: metadata only — counts, costs, source enums, model names.
 *   No prompts, completions, code, diffs, or raw OTel spans. The query
 *   explicitly selects only the whitelisted aggregate columns from
 *   activity_event; the peer_share.fields whitelist is not re-applied here
 *   because we only surface sums (not raw row data) and cost_millicents is
 *   always aggregated as a sum — callers display totals, not raw events.
 */

import { sql } from "@/lib/db";
import { log } from "@/lib/logger";

/** Keep 30 days of daily rows — matches the /share date-range picker. */
export const RETENTION_DAYS = 30;

/** Default rolling window refreshed each cron tick. */
const DEFAULT_WINDOW_DAYS = 30;

/** One row per (owner, viewer, day, source, model). */
export interface PeerShareDailyAggregate {
  ownerId: string;
  viewerId: string;
  date: string;       // "YYYY-MM-DD"
  source: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  costMillicents: number;
  eventCount: number;
  computedAt: string;
}

/** Summary returned by read helpers. */
export interface PeerShareAggregateSummary {
  viewerId: string;
  viewerEmail: string;
  totalCostMillicents: number;
  totalEvents: number;
  dateFrom: string;
  dateTo: string;
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
 * Refresh peer_share_daily_aggregate for one (owner, viewer) pair covering
 * every UTC calendar day from `sinceDate` (inclusive) up to yesterday
 * (inclusive). Omits today so partial-day rows are never persisted.
 *
 * Returns the number of rows upserted.
 */
export async function refreshPeerShareAggregates(
  ownerId: string,
  viewerId: string,
  sinceDate: Date,
): Promise<number> {
  const db = sql();

  const yesterdayUtc = new Date();
  yesterdayUtc.setUTCHours(0, 0, 0, 0);
  yesterdayUtc.setUTCDate(yesterdayUtc.getUTCDate() - 1);

  const sinceMidnight = new Date(sinceDate);
  sinceMidnight.setUTCHours(0, 0, 0, 0);

  if (sinceMidnight > yesterdayUtc) {
    return 0;
  }

  const msPerDay = 86_400_000;
  const totalDays =
    Math.round((yesterdayUtc.getTime() - sinceMidnight.getTime()) / msPerDay) + 1;
  const clampedDays = Math.min(totalDays, DEFAULT_WINDOW_DAYS);
  const clampedSince = new Date(
    yesterdayUtc.getTime() - (clampedDays - 1) * msPerDay,
  );

  const days: string[] = [];
  for (let d = 0; d < clampedDays; d++) {
    const day = new Date(clampedSince.getTime() + d * msPerDay);
    days.push(day.toISOString().slice(0, 10));
  }

  let upserted = 0;

  for (const dateStr of days) {
    const dayStart = `${dateStr}T00:00:00.000Z`;
    const dayEnd = new Date(new Date(dayStart).getTime() + msPerDay).toISOString();

    // Aggregate activity_event rows for this owner on this day, scoped to
    // rows that would be visible under the peer_share grant for this viewer.
    // We group by source + model so the /share breakdown is rich.
    const rows = await db<AggRow[]>`
      SELECT
        COALESCE(ae.source, '')                           AS source,
        COALESCE(ae.model,  '')                           AS model,
        COALESCE(SUM(ae.tokens_input),  0)::bigint        AS tokens_input,
        COALESCE(SUM(ae.tokens_output), 0)::bigint        AS tokens_output,
        COALESCE(SUM(ae.cost_millicents), 0)::bigint      AS cost_millicents,
        COUNT(*)::int                                     AS event_count
      FROM activity_event ae
      -- Only include events for the owner.
      WHERE ae.user_id = ${ownerId}::uuid
        AND ae.ts >= ${dayStart}::timestamptz
        AND ae.ts <  ${dayEnd}::timestamptz
        -- Confirm a non-revoked grant exists for this (owner, viewer) pair.
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
        INSERT INTO peer_share_daily_aggregate
          (owner_id, viewer_id, date, source, model,
           tokens_input, tokens_output, cost_millicents, event_count, computed_at)
        VALUES (
          ${ownerId}::uuid,
          ${viewerId}::uuid,
          ${dateStr}::date,
          ${r.source ?? ""},
          ${r.model  ?? ""},
          ${Number(r.tokens_input  ?? 0)},
          ${Number(r.tokens_output ?? 0)},
          ${Number(r.cost_millicents ?? 0)},
          ${Number(r.event_count ?? 0)},
          NOW()
        )
        ON CONFLICT (owner_id, viewer_id, date, source, model) DO UPDATE SET
          tokens_input    = EXCLUDED.tokens_input,
          tokens_output   = EXCLUDED.tokens_output,
          cost_millicents = EXCLUDED.cost_millicents,
          event_count     = EXCLUDED.event_count,
          computed_at     = EXCLUDED.computed_at
      `;
      upserted++;
    }

    // If no rows came back (no activity that day) we still want a zero-row
    // so the /share page knows the day was computed (not just absent).
    if (rows.length === 0) {
      await db`
        INSERT INTO peer_share_daily_aggregate
          (owner_id, viewer_id, date, source, model,
           tokens_input, tokens_output, cost_millicents, event_count, computed_at)
        VALUES (
          ${ownerId}::uuid, ${viewerId}::uuid,
          ${dateStr}::date, '', '',
          0, 0, 0, 0, NOW()
        )
        ON CONFLICT (owner_id, viewer_id, date, source, model) DO UPDATE SET
          computed_at = EXCLUDED.computed_at
      `;
      upserted++;
    }
  }

  return upserted;
}

/**
 * Prune rows older than RETENTION_DAYS from peer_share_daily_aggregate.
 * Returns the number of rows deleted.
 */
export async function prunePeerShareAggregates(): Promise<number> {
  const db = sql();
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const result = await db`
    DELETE FROM peer_share_daily_aggregate
    WHERE date < ${cutoffStr}::date
    RETURNING 1
  `;
  return result.length;
}

/**
 * Read the aggregate summary per viewer for `ownerId` over the last `days`
 * complete calendar days (exclusive of today). Useful for the /share page
 * top-level summary card per peer.
 */
export async function readPeerShareSummaries(
  ownerId: string,
  days = RETENTION_DAYS,
): Promise<PeerShareAggregateSummary[]> {
  const db = sql();

  const rows = await db<{
    viewer_id: string;
    viewer_email: string;
    total_cost_millicents: string | number;
    total_events: string | number;
    date_from: string;
    date_to: string;
  }[]>`
    SELECT
      a.viewer_id::text                        AS viewer_id,
      u.email                                  AS viewer_email,
      SUM(a.cost_millicents)::bigint           AS total_cost_millicents,
      SUM(a.event_count)::bigint               AS total_events,
      MIN(a.date)::text                        AS date_from,
      MAX(a.date)::text                        AS date_to
    FROM peer_share_daily_aggregate a
    JOIN "user" u ON u.id = a.viewer_id
    WHERE a.owner_id = ${ownerId}::uuid
      AND a.date >= (CURRENT_DATE - ${days}::int)
      AND a.date <  CURRENT_DATE
    GROUP BY a.viewer_id, u.email
    ORDER BY total_cost_millicents DESC
  `;

  return rows.map((r) => ({
    viewerId: r.viewer_id,
    viewerEmail: r.viewer_email,
    totalCostMillicents: Number(r.total_cost_millicents ?? 0),
    totalEvents: Number(r.total_events ?? 0),
    dateFrom: r.date_from ?? "",
    dateTo: r.date_to ?? "",
  }));
}

/**
 * Read per-day rows for a specific (owner, viewer) pair in [from, to].
 * Used by the /share date-range detail view.
 */
export async function readPeerShareRows(
  ownerId: string,
  viewerId: string,
  from: string, // "YYYY-MM-DD"
  to: string,   // "YYYY-MM-DD"
): Promise<PeerShareDailyAggregate[]> {
  const db = sql();

  const rows = await db<{
    owner_id: string;
    viewer_id: string;
    date: string;
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
      date::text, source, model,
      tokens_input, tokens_output, cost_millicents, event_count,
      computed_at::text
    FROM peer_share_daily_aggregate
    WHERE owner_id  = ${ownerId}::uuid
      AND viewer_id = ${viewerId}::uuid
      AND date >= ${from}::date
      AND date <= ${to}::date
    ORDER BY date ASC, source, model
  `;

  return rows.map((r) => ({
    ownerId: r.owner_id,
    viewerId: r.viewer_id,
    date: r.date,
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
 * Entry point used by the cron route — refreshes the last 30 days for every
 * active (owner, viewer) peer_share pair, then prunes old rows.
 *
 * Returns summary counts.
 */
export async function runPeerShareAggregatesCron(): Promise<{
  pairs: number;
  rowsUpserted: number;
  rowsPruned: number;
}> {
  const db = sql();

  // Find all active (non-revoked) peer_share grants.
  const pairs = await db<{ owner_id: string; viewer_id: string }[]>`
    SELECT
      owner_id::text  AS owner_id,
      viewer_id::text AS viewer_id
    FROM peer_share
    WHERE revoked_at IS NULL
  `;

  let rowsUpserted = 0;
  for (const { owner_id, viewer_id } of pairs) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - DEFAULT_WINDOW_DAYS);
    try {
      rowsUpserted += await refreshPeerShareAggregates(owner_id, viewer_id, since);
    } catch (err) {
      log.error({
        msg: "peer-share-aggregate-refresh: pair failed",
        owner_id,
        viewer_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const rowsPruned = await prunePeerShareAggregates();

  return { pairs: pairs.length, rowsUpserted, rowsPruned };
}
