/**
 * fleet-aggregate-refresh.ts — compute and upsert 30-day rolling daily
 * aggregates into fleet_daily_aggregate.
 *
 * Called by:
 *   • /api/cron/fleet-daily (once per day at 01:00 UTC) — refreshes yesterday
 *     and the prior 29 days for every org with recent fleet activity.
 *   • Admin/back-fill callers — pass an explicit sinceDate to recompute a range.
 *
 * Design:
 *   One INSERT…ON CONFLICT (org_id, date) DO UPDATE row per (org, day). Each
 *   row is computed from a single aggregate query over activity_event scoped
 *   to that org + that calendar day. We process at most 30 days × N orgs;
 *   in practice N is small (< 1000 orgs) and the inner query is index-bound
 *   on (source, ts).
 *
 *   Retention: rows older than RETENTION_DAYS (90) are deleted on each cron
 *   run so the table stays bounded.
 *
 * Privacy floor: identical to fleet-oversight.ts — metadata only (counts,
 * costs, enums). No prompts, completions, code, or diffs.
 */

import { sql } from "@/lib/db";
import { log } from "@/lib/logger";

/** Keep 90 days of daily rows — covers any dashboard window + digest lookback. */
const RETENTION_DAYS = 90;

/** Default rolling window refreshed each cron tick. */
const DEFAULT_WINDOW_DAYS = 30;

/** One upserted row per (org, day). */
export interface FleetDailyAggregate {
  orgId: string;
  date: string;        // ISO date string "YYYY-MM-DD"
  proposals: number;
  applied: number;
  rejected: number;
  costUsd: number;
  activeAgents: number;
  reposTouched: number;
  computedAt: string;  // ISO timestamp
}

interface AggRow {
  proposals: number;
  applied: number;
  rejected: number;
  cost_usd: string | number | null;
  active_agents: number;
  repos_touched: number;
}

/**
 * Refresh fleet_daily_aggregate for `orgId` covering every UTC calendar day
 * from `sinceDate` (inclusive) up to yesterday (inclusive). Omits today so
 * partial-day rows are never persisted — only complete days land here.
 *
 * Returns the number of rows upserted.
 */
export async function refreshFleetAggregates(
  orgId: string,
  sinceDate: Date,
): Promise<number> {
  const db = sql();

  // Build the list of UTC calendar days from sinceDate up to yesterday.
  const yesterdayUtc = new Date();
  yesterdayUtc.setUTCHours(0, 0, 0, 0);
  yesterdayUtc.setUTCDate(yesterdayUtc.getUTCDate() - 1); // yesterday 00:00 UTC

  const sinceMidnight = new Date(sinceDate);
  sinceMidnight.setUTCHours(0, 0, 0, 0);

  if (sinceMidnight > yesterdayUtc) {
    // Nothing to do — caller asked for a future window.
    return 0;
  }

  // Clamp to DEFAULT_WINDOW_DAYS to avoid runaway back-fills from the cron.
  const msPerDay = 86_400_000;
  const totalDays =
    Math.round((yesterdayUtc.getTime() - sinceMidnight.getTime()) / msPerDay) + 1;
  const clampedDays = Math.min(totalDays, DEFAULT_WINDOW_DAYS);
  const clampedSince = new Date(yesterdayUtc.getTime() - (clampedDays - 1) * msPerDay);

  // Generate date strings for each day in the window.
  const days: string[] = [];
  for (let d = 0; d < clampedDays; d++) {
    const day = new Date(clampedSince.getTime() + d * msPerDay);
    days.push(day.toISOString().slice(0, 10)); // "YYYY-MM-DD"
  }

  let upserted = 0;

  for (const dateStr of days) {
    const dayStart = `${dateStr}T00:00:00.000Z`;
    const dayEnd = new Date(new Date(dayStart).getTime() + msPerDay).toISOString();

    const rows = await db<AggRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal')::int                                   AS proposals,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal' AND ae.fleet_outcome = 'applied')::int  AS applied,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal' AND ae.fleet_outcome = 'rejected')::int AS rejected,
        COALESCE(SUM(ae.cost_millicents), 0) / 100000.0                                            AS cost_usd,
        COUNT(DISTINCT COALESCE(NULLIF(ae.session_id, ''), ae.user_id::text))::int                 AS active_agents,
        COUNT(DISTINCT ae.repo_name) FILTER (WHERE ae.repo_name IS NOT NULL)::int                  AS repos_touched
      FROM activity_event ae
      JOIN membership m ON m.user_id::text = ae.user_id AND m.org_id = ${orgId}::uuid
      WHERE ae.source = 'ashlr-fleet'
        AND ae.ts >= ${dayStart}::timestamptz
        AND ae.ts <  ${dayEnd}::timestamptz
    `;

    const r = rows[0] ?? {
      proposals: 0, applied: 0, rejected: 0,
      cost_usd: 0, active_agents: 0, repos_touched: 0,
    };

    await db`
      INSERT INTO fleet_daily_aggregate
        (org_id, date, proposals, applied, rejected, cost_usd,
         active_agents, repos_touched, computed_at)
      VALUES (
        ${orgId}::uuid,
        ${dateStr}::date,
        ${r.proposals},
        ${r.applied},
        ${r.rejected},
        ${Number(r.cost_usd ?? 0)},
        ${r.active_agents},
        ${r.repos_touched},
        NOW()
      )
      ON CONFLICT (org_id, date) DO UPDATE SET
        proposals     = EXCLUDED.proposals,
        applied       = EXCLUDED.applied,
        rejected      = EXCLUDED.rejected,
        cost_usd      = EXCLUDED.cost_usd,
        active_agents = EXCLUDED.active_agents,
        repos_touched = EXCLUDED.repos_touched,
        computed_at   = EXCLUDED.computed_at
    `;
    upserted++;
  }

  return upserted;
}

/**
 * Prune rows older than RETENTION_DAYS from fleet_daily_aggregate.
 * Returns the number of rows deleted.
 */
export async function pruneFleetAggregates(): Promise<number> {
  const db = sql();
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const result = await db`
    DELETE FROM fleet_daily_aggregate
    WHERE date < ${cutoffStr}::date
    RETURNING 1
  `;
  return result.length;
}

/**
 * Return the last computed_at timestamp for an org, or null if no rows exist.
 * Used by the /admin/fleet-aggregate-status endpoint.
 */
export async function getLastComputedAt(orgId: string): Promise<string | null> {
  const db = sql();
  const rows = await db<{ computed_at: string }[]>`
    SELECT MAX(computed_at)::text AS computed_at
    FROM fleet_daily_aggregate
    WHERE org_id = ${orgId}::uuid
  `;
  return rows[0]?.computed_at ?? null;
}

/**
 * Read materialized aggregates for `orgId` over the most recent `days`
 * (exclusive of today). Returns rows ordered oldest-first.
 *
 * Used by computeFleetMetrics() when days >= 7.
 */
export async function readFleetAggregates(
  orgId: string,
  days: number,
): Promise<FleetDailyAggregate[]> {
  const db = sql();

  // Most recent `days` complete calendar days (i.e. up to yesterday).
  const rows = await db<{
    org_id: string;
    date: string;
    proposals: number;
    applied: number;
    rejected: number;
    cost_usd: string | number;
    active_agents: number;
    repos_touched: number;
    computed_at: string;
  }[]>`
    SELECT
      org_id::text,
      date::text,
      proposals,
      applied,
      rejected,
      cost_usd,
      active_agents,
      repos_touched,
      computed_at::text
    FROM fleet_daily_aggregate
    WHERE org_id = ${orgId}::uuid
      AND date >= (CURRENT_DATE - ${days}::int)
      AND date <  CURRENT_DATE
    ORDER BY date ASC
  `;

  return rows.map((r) => ({
    orgId: r.org_id,
    date: r.date,
    proposals: Number(r.proposals),
    applied: Number(r.applied),
    rejected: Number(r.rejected),
    costUsd: Math.round(Number(r.cost_usd ?? 0) * 100) / 100,
    activeAgents: Number(r.active_agents),
    reposTouched: Number(r.repos_touched),
    computedAt: r.computed_at,
  }));
}

/**
 * Convenience: return the lag in hours between the most recent computed_at
 * across ALL orgs and now. Returns null if no rows exist.
 */
export async function globalAggregatesLagHours(): Promise<number | null> {
  const db = sql();
  const rows = await db<{ lag_hours: number | null }[]>`
    SELECT EXTRACT(EPOCH FROM (NOW() - MAX(computed_at))) / 3600.0 AS lag_hours
    FROM fleet_daily_aggregate
  `;
  const lag = rows[0]?.lag_hours;
  return lag != null ? Math.round(Number(lag) * 10) / 10 : null;
}

/**
 * Entry point used by the cron route — refreshes the last 30 days for every
 * org that had fleet activity in the last 30 days, then prunes old rows.
 *
 * Returns summary counts.
 */
export async function runFleetAggregatesCron(): Promise<{
  orgs: number;
  rowsUpserted: number;
  rowsPruned: number;
}> {
  const db = sql();

  // Find orgs with recent fleet activity (same join as oversight cron).
  const orgs = await db<{ org_id: string }[]>`
    SELECT DISTINCT m.org_id::text AS org_id
    FROM activity_event ae
    JOIN membership m ON m.user_id::text = ae.user_id
    WHERE ae.source = 'ashlr-fleet'
      AND ae.ts >= NOW() - INTERVAL '30 days'
  `;

  let rowsUpserted = 0;
  for (const { org_id } of orgs) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - DEFAULT_WINDOW_DAYS);
    try {
      rowsUpserted += await refreshFleetAggregates(org_id, since);
    } catch (err) {
      log.error({
        msg: "fleet-aggregate-refresh: org failed",
        org_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const rowsPruned = await pruneFleetAggregates();

  return { orgs: orgs.length, rowsUpserted, rowsPruned };
}
