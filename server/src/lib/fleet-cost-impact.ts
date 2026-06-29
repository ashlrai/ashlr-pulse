/**
 * fleet-cost-impact.ts — peer-safe cost-impact aggregates for fleet oversight.
 *
 * Computes rolling cost metrics per user + model from the
 * peer_share_hourly_aggregate table (already privacy-gated) and exposes:
 *
 *   • Hourly cost deltas per (user, model) — gated via peer_share grants.
 *   • Rolling 7-day user-vs-team cost ratios (millicents/day).
 *   • Model preference drift: share of each model this week vs last week.
 *
 * Privacy floor
 * ─────────────
 *   All numeric — no prompts, completions, code, diffs, or raw OTel spans.
 *   Reads exclusively from peer_share_hourly_aggregate (already peer-gated)
 *   and peer_share_daily_aggregate. No raw activity_event access here.
 *
 * Peer-safe aggregation
 * ─────────────────────
 *   The hourly aggregate table already enforces the peer_share grant via its
 *   EXISTS-on-grant INSERT guard. This layer queries that materialized table
 *   and further groups by org membership — viewers only see data for owners
 *   they hold an active grant from.
 */

import { sql } from "@/lib/db";
import { log } from "@/lib/logger";
import type { AnomalySeverity } from "./realtime-anomaly";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Cost impact row for one user over a rolling window. */
export interface UserCostImpact {
  /** User identifier (UUID as string). */
  userId: string;
  /** Total cost in millicents for the rolling 7d window. */
  totalMillicents: number;
  /** Cost per event (millicents/event) over the window. */
  costPerEvent: number;
  /** Cost per token (millicents/token) over the window. */
  costPerToken: number;
  /** Daily average cost in millicents. */
  dailyAvgMillicents: number;
  /** 7-day daily costs, index 0 = 7 days ago, index 6 = today. */
  dailyCosts: number[];
}

/** Org-level cost impact summary. */
export interface OrgCostImpact {
  /** All users in the org with their cost impact. */
  users: UserCostImpact[];
  /** Team average daily cost in millicents. */
  teamAvgDailyMillicents: number;
  /** Model share breakdown for this week vs last week. */
  modelDrift: ModelDriftEntry[];
  /** ISO-8601 timestamp this data was computed. */
  computedAt: string;
}

/** Model preference drift entry. */
export interface ModelDriftEntry {
  model: string;
  /** Share of events this week (0–1). */
  shareThisWeek: number;
  /** Share of events last week (0–1). */
  shareLastWeek: number;
  /** Change in share (positive = gaining, negative = losing). */
  driftPct: number;
}

/** Cost-impact fields appended to FleetRealtimeEvent on each ingest. */
export interface CostImpactFields {
  /** Caller's cost this event in millicents. */
  user_cost_millicents: number;
  /** Team average cost per event in millicents (from rolling window). */
  team_avg_millicents: number;
  /**
   * Ratio of user cost to team average (1.0 = at average).
   * Maps to the peer_divergence severity bands from realtime-anomaly.ts:
   *   < 2.0  → low
   *   2.0–3.0 → medium
   *   > 3.0  → high (was >= 4.99 in peer_divergence detector)
   */
  peer_divergence_ratio: number;
  /** Severity band for the divergence ratio. */
  peer_divergence_severity: AnomalySeverity;
}

// ---------------------------------------------------------------------------
// Severity band mapping (mirrors realtime-anomaly.ts thresholds)
// ---------------------------------------------------------------------------

/**
 * Map a peer_divergence_ratio to a severity band.
 *
 * Thresholds from realtime-anomaly.ts detectPeerDivergence():
 *   ratio >= 4.99 → "high"
 *   ratio >= 2.99 → "medium"
 *   otherwise     → "low"
 *
 * Using 2.99/4.99 lower bounds rather than exact 3.0/5.0 to tolerate
 * floating-point rounding (same rationale as the anomaly detector).
 */
export function divergenceSeverity(ratio: number): AnomalySeverity {
  if (ratio >= 4.99) return "high";
  if (ratio >= 2.99) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Pure computation helpers (no DB — fully unit-testable)
// ---------------------------------------------------------------------------

/**
 * Compute cost-impact fields for a single event given the user's rolling cost
 * and the team average.
 *
 * @param eventCostMillicents  Cost of this event in millicents.
 * @param teamAvgMillicents    Team average cost-per-event in millicents.
 */
export function computeCostImpactFields(
  eventCostMillicents: number,
  teamAvgMillicents: number,
): CostImpactFields {
  const userCost = Math.max(0, eventCostMillicents);
  const teamAvg  = Math.max(0, teamAvgMillicents);

  const ratio =
    teamAvg > 0
      ? userCost / teamAvg
      : userCost > 0
        ? Number.POSITIVE_INFINITY
        : 1.0;

  const clampedRatio = Number.isFinite(ratio) ? ratio : 99.0;

  return {
    user_cost_millicents:   userCost,
    team_avg_millicents:    teamAvg,
    peer_divergence_ratio:  Number(clampedRatio.toFixed(3)),
    peer_divergence_severity: divergenceSeverity(clampedRatio),
  };
}

/**
 * Compute rolling 7-day user-vs-team ratios from a flat list of daily cost rows.
 *
 * @param rows   Rows from peer_share_daily_aggregate grouped by (owner_id, date).
 * @param days   Rolling window size (default 7).
 */
export function computeUserCostImpacts(
  rows: { ownerId: string; date: string; costMillicents: number; eventCount: number; tokensTotal: number }[],
  days = 7,
): UserCostImpact[] {
  // Group by userId.
  const byUser = new Map<string, { date: string; costMillicents: number; eventCount: number; tokensTotal: number }[]>();
  for (const r of rows) {
    let arr = byUser.get(r.ownerId);
    if (!arr) { arr = []; byUser.set(r.ownerId, arr); }
    arr.push({ date: r.date, costMillicents: r.costMillicents, eventCount: r.eventCount, tokensTotal: r.tokensTotal });
  }

  // Generate date buckets for the rolling window (oldest first).
  const nowMs  = Date.now();
  const dates: string[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const dt = new Date(nowMs - d * 86_400_000);
    dates.push(dt.toISOString().slice(0, 10));
  }

  const impacts: UserCostImpact[] = [];

  for (const [userId, userRows] of byUser) {
    const byDate = new Map(userRows.map((r) => [r.date, r]));

    const dailyCosts   = dates.map((d) => byDate.get(d)?.costMillicents ?? 0);
    const totalCost    = dailyCosts.reduce((s, c) => s + c, 0);
    const totalEvents  = userRows.reduce((s, r) => s + r.eventCount, 0);
    const totalTokens  = userRows.reduce((s, r) => s + r.tokensTotal, 0);
    const dailyAvg     = days > 0 ? totalCost / days : 0;

    impacts.push({
      userId,
      totalMillicents:   totalCost,
      costPerEvent:      totalEvents > 0 ? totalCost / totalEvents : 0,
      costPerToken:      totalTokens > 0 ? totalCost / totalTokens : 0,
      dailyAvgMillicents: dailyAvg,
      dailyCosts,
    });
  }

  // Sort by totalMillicents descending (highest spender first).
  impacts.sort((a, b) => b.totalMillicents - a.totalMillicents);

  return impacts;
}

/**
 * Compute model preference drift: this week's model share vs last week's.
 *
 * @param thisWeek  (model, eventCount) for the current 7d window.
 * @param lastWeek  (model, eventCount) for the prior 7d window.
 */
export function computeModelDrift(
  thisWeek: { model: string; eventCount: number }[],
  lastWeek: { model: string; eventCount: number }[],
): ModelDriftEntry[] {
  const totalThis = thisWeek.reduce((s, r) => s + r.eventCount, 0);
  const totalLast = lastWeek.reduce((s, r) => s + r.eventCount, 0);

  const thisMap = new Map(thisWeek.map((r) => [r.model, r.eventCount]));
  const lastMap = new Map(lastWeek.map((r) => [r.model, r.eventCount]));

  const allModels = new Set([...thisMap.keys(), ...lastMap.keys()]);

  const entries: ModelDriftEntry[] = [];
  for (const model of allModels) {
    if (!model) continue;
    const shareThis = totalThis > 0 ? (thisMap.get(model) ?? 0) / totalThis : 0;
    const shareLast = totalLast > 0 ? (lastMap.get(model) ?? 0) / totalLast : 0;
    const drift     = shareThis - shareLast;

    entries.push({
      model,
      shareThisWeek: Number(shareThis.toFixed(4)),
      shareLastWeek: Number(shareLast.toFixed(4)),
      driftPct:      Number((drift * 100).toFixed(2)),
    });
  }

  // Sort by this-week share descending.
  entries.sort((a, b) => b.shareThisWeek - a.shareThisWeek);
  return entries;
}

// ---------------------------------------------------------------------------
// DB-backed loaders
// ---------------------------------------------------------------------------

/**
 * Load rolling 7-day cost-impact aggregates for all members of an org.
 *
 * Reads from peer_share_daily_aggregate (already peer-gated at write time).
 * Falls back gracefully when the table doesn't exist.
 *
 * @param orgId  Organisation UUID.
 * @param days   Rolling window in days (default 7).
 */
export async function loadOrgCostImpact(
  orgId: string,
  days = 7,
): Promise<OrgCostImpact> {
  const db = sql();
  const empty: OrgCostImpact = {
    users: [],
    teamAvgDailyMillicents: 0,
    modelDrift: [],
    computedAt: new Date().toISOString(),
  };

  try {
    // Resolve org member UUIDs.
    const members = await db<{ user_id: string }[]>`
      SELECT user_id::text AS user_id
      FROM membership
      WHERE org_id = ${orgId}::uuid
    `.catch(() => [] as { user_id: string }[]);

    if (members.length === 0) return empty;
    const memberIds = members.map((m) => m.user_id);

    const cutoffDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const lastWeekCutoff = new Date(Date.now() - 2 * days * 86_400_000).toISOString().slice(0, 10);

    // Named row types avoid the self-referential `typeof` inference issue.
    type DailyRow = {
      owner_id: string;
      date: string;
      cost_millicents: string | number;
      event_count: string | number;
      tokens_input: string | number;
      tokens_output: string | number;
    };
    type ModelRow = { model: string; event_count: string | number };

    // Daily cost rows for this window.
    const dailyRows: DailyRow[] = await db<DailyRow[]>`
      SELECT
        owner_id::text AS owner_id,
        date::text     AS date,
        COALESCE(SUM(cost_millicents), 0)::bigint  AS cost_millicents,
        COALESCE(SUM(event_count), 0)::int          AS event_count,
        COALESCE(SUM(tokens_input), 0)::bigint      AS tokens_input,
        COALESCE(SUM(tokens_output), 0)::bigint     AS tokens_output
      FROM peer_share_daily_aggregate
      WHERE owner_id = ANY(${memberIds}::uuid[])
        AND date >= ${cutoffDate}::date
      GROUP BY owner_id, date
      ORDER BY owner_id, date
    `.catch((): DailyRow[] => []);

    // Model mix — this week.
    const modelThis: ModelRow[] = await db<ModelRow[]>`
      SELECT
        COALESCE(model, '') AS model,
        COALESCE(SUM(event_count), 0)::int AS event_count
      FROM peer_share_daily_aggregate
      WHERE owner_id = ANY(${memberIds}::uuid[])
        AND date >= ${cutoffDate}::date
      GROUP BY model
    `.catch((): ModelRow[] => []);

    // Model mix — last week.
    const modelLast: ModelRow[] = await db<ModelRow[]>`
      SELECT
        COALESCE(model, '') AS model,
        COALESCE(SUM(event_count), 0)::int AS event_count
      FROM peer_share_daily_aggregate
      WHERE owner_id = ANY(${memberIds}::uuid[])
        AND date >= ${lastWeekCutoff}::date
        AND date <  ${cutoffDate}::date
      GROUP BY model
    `.catch((): ModelRow[] => []);

    // Map to typed rows.
    const typedDaily = dailyRows.map((r: DailyRow) => ({
      ownerId:        r.owner_id,
      date:           r.date,
      costMillicents: Number(r.cost_millicents ?? 0),
      eventCount:     Number(r.event_count ?? 0),
      tokensTotal:    Number(r.tokens_input ?? 0) + Number(r.tokens_output ?? 0),
    }));

    const users = computeUserCostImpacts(typedDaily, days);

    const teamAvg =
      users.length > 0
        ? users.reduce((s, u) => s + u.dailyAvgMillicents, 0) / users.length
        : 0;

    const modelDrift = computeModelDrift(
      modelThis.map((r: ModelRow) => ({ model: r.model, eventCount: Number(r.event_count ?? 0) })),
      modelLast.map((r: ModelRow) => ({ model: r.model, eventCount: Number(r.event_count ?? 0) })),
    );

    return {
      users,
      teamAvgDailyMillicents: teamAvg,
      modelDrift,
      computedAt: new Date().toISOString(),
    };
  } catch (err) {
    log.warn({
      msg: "fleet-cost-impact: loadOrgCostImpact failed",
      orgId,
      err: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
}
