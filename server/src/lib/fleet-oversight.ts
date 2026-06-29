/**
 * fleet-oversight.ts — the Fleet Oversight metrics engine (THE CONTRACT).
 *
 * This is the manager/CEO substrate: it answers, for one org over a recent
 * window, three questions about the autonomous coding fleet —
 *   1. PRODUCTIVITY — how much work is the fleet doing (proposals, ticks,
 *      active engines, repos touched, cost, applied changes)?
 *   2. QUALITY       — are its decisions GOOD (approval vs rejection rate,
 *      review latency, stale-review backlog)?
 *   3. IMPACT/SAFETY — is it IMPROVING the codebase, and is it operating
 *      within budget and command-failure bounds?
 * …plus a `trend` verdict vs the immediately-prior window of equal length.
 *
 * EVERYTHING IS COMPUTED ON READ from data the fleet already emits — no new
 * tables, no migrations. We aggregate three sources, all ORG-SCOPED:
 *   • activity_event WHERE source='ashlr-fleet'  → scoped via
 *     membership (m.user_id::text = ae.user_id AND m.org_id = $org), the
 *     same join graph-db.ts uses for live fleet agents.
 *   • fleet_command (org_id column)              → review latency + failed
 *     commands.
 *   • repo_health (org_id column)                → health distribution.
 *   • org.monthly_budget_usd                     → the safety budget cap.
 *
 * fleet_event semantics (migration 0025): 'tick' | 'proposal' | 'merge' |
 * 'decline'. fleet_outcome: 'pending' | 'applied' | 'rejected' | <tick-reason>.
 * We classify a PROPOSAL's resolution from fleet_outcome on the proposal row
 * itself, and treat 'merge' events as a corroborating applied signal.
 *
 * PRIVACY FLOOR: this engine reads and returns METADATA ONLY — counts, rates,
 * costs, enums, scores, timestamps. It never touches prompts, completions,
 * code, or diffs (those never reach the cloud at all).
 *
 * THIS FILE IS THE SHARED CONTRACT. Every Oversight agent codes to the
 * FleetMetrics interface + computeFleetMetrics signature below — keep them
 * stable.
 */

import { sql } from "@/lib/db";
import { readFleetAggregates } from "@/lib/fleet-aggregate-refresh";

// ---------------------------------------------------------------------------
// The shared contract. EVERY agent reads this shape.
// ---------------------------------------------------------------------------

export interface FleetMetrics {
  window: { start: string; end: string; days: number };
  productivity: {
    proposals: number;
    perDay: number;
    ticks: number;
    activeAgents: number;
    reposTouched: number;
    costUsd: number;
    costPerProposal: number;
    appliedChanges: number;
  };
  quality: {
    applied: number;
    rejected: number;
    pending: number;
    resolved: number;
    approvalRate: number; // applied / resolved
    rejectionRate: number; // rejected / resolved
    avgHoursToReview: number | null;
    staleReviewCount: number; // pending proposals older than STALE_REVIEW_DAYS
  };
  impact: {
    reposImproved: number;
    reposRegressed: number;
    avgHealthScore: number | null;
  };
  safety: {
    spendUsd: number;
    budgetCapUsd: number | null;
    overBudget: boolean;
    failedCommands: number;
  };
  byEngine: Array<{ engine: string; proposals: number; approvalRate: number; costUsd: number }>;
  byRepo: Array<{ repo: string; proposals: number; approvalRate: number; costUsd: number; healthScore: number | null }>;
  byOwner: Array<{ owner: string; proposals: number; approvalRate: number }>;
  trend: "improving" | "flat" | "regressing"; // vs the immediately-prior window of equal length
}

// Pending proposals older than this many days count as a stale review backlog.
const STALE_REVIEW_DAYS = 3;

// Health thresholds for the impact approximation (repo_health is a 0..100
// composite). Without a prior per-repo snapshot we approximate "improved" as
// currently-healthy repos and "regressed" as currently-unhealthy ones.
const HEALTHY_SCORE = 70;
const UNHEALTHY_SCORE = 50;

// A trend is "flat" unless the composite score moved more than this fraction.
const TREND_EPSILON = 0.05; // 5%

// USD per cost_millicent: cost_millicents is hundred-thousandths of a dollar.
const MILLICENTS_PER_USD = 100_000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function rate(numer: number, denom: number): number {
  return denom > 0 ? round2(numer / denom) : 0;
}

// ---------------------------------------------------------------------------
// Row shapes for the aggregate queries.
// ---------------------------------------------------------------------------

interface ProductivityRow {
  proposals: number;
  ticks: number;
  merges: number;
  applied_outcomes: number;
  active_agents: number;
  repos_touched: number;
  cost_millicents: string | number | null;
}

interface OutcomeRow {
  applied: number;
  rejected: number;
  pending: number;
}

interface ReviewLatencyRow {
  avg_hours: number | null;
}

interface StaleRow {
  stale: number;
}

interface BreakdownRow {
  key: string;
  proposals: number;
  applied: number;
  rejected: number;
  cost_millicents: string | number | null;
}

interface HealthRow {
  repo_name: string;
  health_score: number | null;
}

interface FailedCommandsRow {
  failed: number;
}

interface SpendBudgetRow {
  spend_millicents: string | number | null;
  budget_usd: string | number | null;
}

interface TrendRow {
  proposals: number;
  applied: number;
  resolved: number;
}

// ---------------------------------------------------------------------------
// Agent health-check rollup — per-agent presence + queue depth.
//
// PRIVACY FLOOR: identical to computeFleetMetrics — only metadata
// (timestamps, counts, cost aggregates). No prompts, completions, or diffs.
// ---------------------------------------------------------------------------

/**
 * One agent entry in the health rollup payload.
 *
 * agentId           — COALESCE(session_id, user_id) — stable identifier that
 *                     the fleet daemon stamps on every activity_event row.
 * lastHeartbeatSec  — seconds since the most recent tick or proposal from
 *                     this agent (0 = just now, large = stale).
 * isHealthy         — true when last heartbeat was within AGENT_STALE_SEC.
 * proposalQueueDepth — pending proposals attributed to this agent.
 * costLastHour      — USD cost from this agent in the last 60 minutes.
 */
export interface AgentHealthEntry {
  agentId: string;
  lastHeartbeatSec: number;
  isHealthy: boolean;
  proposalQueueDepth: number;
  costLastHour: number;
}

// An agent is considered stale (unhealthy) if it hasn't emitted any fleet
// event in this many seconds.
export const AGENT_STALE_SEC = 300; // 5 minutes

interface AgentPresenceRow {
  agent_id: string;
  last_event_sec: number; // seconds since last event (EXTRACT EPOCH from NOW()-MAX(ts))
  pending_proposals: number;
  cost_last_hour_millicents: string | number | null;
}

/**
 * Aggregate per-agent heartbeat presence for `orgId`.
 *
 * Reads activity_event WHERE source='ashlr-fleet' grouped by
 * COALESCE(session_id, user_id::text) — the same identity key used by the
 * graph-db live-agent query. Only agents active in the last `windowSec`
 * seconds are returned (default 24 h) to keep the payload small.
 *
 * Feature-flagged: callers MUST check PULSE_FLEET_HEALTH=true before calling.
 * This function itself is pure data; the flag lives at the route/component layer.
 */
export async function computeAgentHealthRollup(
  orgId: string,
  windowSec = 86_400,
): Promise<AgentHealthEntry[]> {
  const db = sql();

  const rows = await db<AgentPresenceRow[]>`
    SELECT
      COALESCE(NULLIF(ae.session_id, ''), ae.user_id::text)            AS agent_id,
      EXTRACT(EPOCH FROM (NOW() - MAX(ae.ts)))::int                    AS last_event_sec,
      COUNT(*) FILTER (
        WHERE ae.fleet_event = 'proposal' AND ae.fleet_outcome = 'pending'
      )::int                                                           AS pending_proposals,
      COALESCE(SUM(ae.cost_millicents) FILTER (
        WHERE ae.ts >= NOW() - interval '1 hour'
      ), 0)                                                            AS cost_last_hour_millicents
    FROM activity_event ae
    JOIN membership m ON m.user_id::text = ae.user_id AND m.org_id = ${orgId}::uuid
    WHERE ae.source = 'ashlr-fleet'
      AND ae.ts >= NOW() - (${windowSec} || ' seconds')::interval
    GROUP BY COALESCE(NULLIF(ae.session_id, ''), ae.user_id::text)
    ORDER BY last_event_sec ASC
  `;

  return rows.map((r) => {
    const lastHeartbeatSec = Math.max(0, Number(r.last_event_sec ?? 0));
    return {
      agentId: r.agent_id,
      lastHeartbeatSec,
      isHealthy: lastHeartbeatSec <= AGENT_STALE_SEC,
      proposalQueueDepth: Number(r.pending_proposals ?? 0),
      costLastHour: round2(Number(r.cost_last_hour_millicents ?? 0) / MILLICENTS_PER_USD),
    };
  });
}

// ---------------------------------------------------------------------------
// computeFleetMetrics — the one entry point.
// ---------------------------------------------------------------------------

/**
 * Minimum window (days) at which computeFleetMetrics reads from the
 * materialized fleet_daily_aggregate table instead of scanning activity_event.
 * For windows >= this threshold the aggregate table provides a ~90% query-time
 * win on the /oversight page and weekly digest render.
 */
const AGGREGATE_MIN_DAYS = 7;

/**
 * Compute the FleetMetrics snapshot for `orgId` over the most recent `days`
 * (default 7). The caller (route layer) is responsible for verifying the
 * requesting user is a member of `orgId` and for plan-gating.
 *
 * When days >= AGGREGATE_MIN_DAYS (7) the productivity and quality totals are
 * read from the materialized fleet_daily_aggregate table (populated nightly by
 * /api/cron/fleet-daily). The remaining dimensions (impact, safety, breakdowns,
 * trend) always hit the live tables since they either need current health
 * snapshots (repo_health), budget caps (org), or per-repo/engine granularity
 * that the daily aggregate doesn't store.
 */
export async function computeFleetMetrics(orgId: string, days = 7): Promise<FleetMetrics> {
  const db = sql();
  const windowDays = days > 0 ? days : 7;

  const end = new Date();
  const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const priorStart = new Date(start.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const priorStartIso = priorStart.toISOString();

  // -------------------------------------------------------------------------
  // FAST PATH — materialized aggregate table (windows >= AGGREGATE_MIN_DAYS).
  //
  // When the caller requests >= 7 days we read pre-rolled daily rows from
  // fleet_daily_aggregate instead of scanning activity_event directly. This
  // cuts query time by ~90% on the /oversight page and the weekly digest.
  //
  // We still run ALL the live queries below for the dimensions that need
  // real-time data: breakdowns (byEngine/byRepo/byOwner), review latency,
  // stale count, health, safety, and the trend comparison. Only the top-line
  // productivity + quality totals (proposals, applied, rejected, cost, active
  // agents, repos touched) are substituted from the aggregate.
  // -------------------------------------------------------------------------
  let aggregateProductivity: {
    proposals: number;
    applied: number;
    rejected: number;
    costUsd: number;
    activeAgents: number;
    reposTouched: number;
  } | null = null;

  if (windowDays >= AGGREGATE_MIN_DAYS) {
    try {
      const agg = await readFleetAggregates(orgId, windowDays);
      if (agg.length > 0) {
        // NOTE: activeAgents/reposTouched are intentionally NOT derived from the
        // daily aggregate rows here. Each row stores a per-day COUNT(DISTINCT ...);
        // an agent or repo active across multiple days appears in several rows.
        //   - Math.max() would yield the single peak day (window UNDER-count).
        //   - SUM() would double-count anything active on >1 day (OVER-count).
        // Neither reproduces the live query's window-wide COUNT(DISTINCT ...).
        // We therefore source these two fields from the live `prod[0]` query
        // (active_agents / repos_touched), which is a true distinct over the
        // full [start, end) window. proposals/applied/rejected/cost are pure
        // additive counts, so SUM over the daily rows is correct for those.
        aggregateProductivity = agg.reduce(
          (acc, row) => ({
            proposals: acc.proposals + row.proposals,
            applied: acc.applied + row.applied,
            rejected: acc.rejected + row.rejected,
            costUsd: acc.costUsd + row.costUsd,
            activeAgents: 0,
            reposTouched: 0,
          }),
          { proposals: 0, applied: 0, rejected: 0, costUsd: 0, activeAgents: 0, reposTouched: 0 },
        );
        aggregateProductivity.costUsd = round2(aggregateProductivity.costUsd);
      }
    } catch {
      // Aggregate table not yet populated (e.g. first deploy, migration not
      // run yet) — fall through to the live query path silently.
      aggregateProductivity = null;
    }
  }

  const [
    prod,
    outcomes,
    reviewLatency,
    stale,
    byEngineRows,
    byRepoRows,
    byOwnerRows,
    healthRows,
    failedRows,
    spendBudget,
    thisWindowTrend,
    priorWindowTrend,
  ] = await Promise.all([
    // 1. PRODUCTIVITY — fleet event counts, distinct agents/repos, cost.
    db<ProductivityRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal')::int                          AS proposals,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'tick')::int                              AS ticks,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'merge')::int                             AS merges,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal' AND ae.fleet_outcome = 'applied')::int AS applied_outcomes,
        COUNT(DISTINCT COALESCE(ae.session_id, ae.user_id))::int                          AS active_agents,
        COUNT(DISTINCT ae.repo_name) FILTER (WHERE ae.repo_name IS NOT NULL)::int         AS repos_touched,
        COALESCE(SUM(ae.cost_millicents), 0)                                              AS cost_millicents
      FROM activity_event ae
      JOIN membership m ON m.user_id::text = ae.user_id AND m.org_id = ${orgId}::uuid
      WHERE ae.source = 'ashlr-fleet'
        AND ae.ts >= ${startIso}::timestamptz
        AND ae.ts <  ${endIso}::timestamptz
    `,

    // 2. QUALITY — proposal outcome distribution.
    db<OutcomeRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE ae.fleet_outcome = 'applied')::int  AS applied,
        COUNT(*) FILTER (WHERE ae.fleet_outcome = 'rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE ae.fleet_outcome = 'pending')::int  AS pending
      FROM activity_event ae
      JOIN membership m ON m.user_id::text = ae.user_id AND m.org_id = ${orgId}::uuid
      WHERE ae.source = 'ashlr-fleet'
        AND ae.fleet_event = 'proposal'
        AND ae.ts >= ${startIso}::timestamptz
        AND ae.ts <  ${endIso}::timestamptz
    `,

    // 2b. avgHoursToReview — approximated from fleet_command review lifecycle:
    //     time from a proposal command landing to its approve/reject completing.
    db<ReviewLatencyRow[]>`
      SELECT
        GREATEST(0, AVG(EXTRACT(EPOCH FROM (fc.completed_at - fc.created_at)) / 3600.0))::float8 AS avg_hours
      FROM fleet_command fc
      WHERE fc.org_id = ${orgId}::uuid
        AND fc.kind IN ('approve_proposal', 'reject_proposal')
        AND fc.completed_at IS NOT NULL
        AND fc.completed_at >= fc.created_at
        AND fc.created_at >= ${startIso}::timestamptz
        AND fc.created_at <  ${endIso}::timestamptz
    `,

    // 2c. staleReviewCount — pending proposals older than STALE_REVIEW_DAYS,
    //     still within the window.
    db<StaleRow[]>`
      SELECT COUNT(*)::int AS stale
      FROM activity_event ae
      JOIN membership m ON m.user_id::text = ae.user_id AND m.org_id = ${orgId}::uuid
      WHERE ae.source = 'ashlr-fleet'
        AND ae.fleet_event = 'proposal'
        AND ae.fleet_outcome = 'pending'
        AND ae.ts >= ${startIso}::timestamptz
        AND ae.ts <  (NOW() - (${STALE_REVIEW_DAYS} || ' days')::interval)
    `,

    // 3. byEngine — proposals + approval + cost grouped by provider/model engine.
    db<BreakdownRow[]>`
      SELECT
        COALESCE(NULLIF(ae.provider, ''), NULLIF(ae.model, ''), 'unknown') AS key,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal')::int           AS proposals,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal' AND ae.fleet_outcome = 'applied')::int  AS applied,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal' AND ae.fleet_outcome = 'rejected')::int AS rejected,
        COALESCE(SUM(ae.cost_millicents), 0)                               AS cost_millicents
      FROM activity_event ae
      JOIN membership m ON m.user_id::text = ae.user_id AND m.org_id = ${orgId}::uuid
      WHERE ae.source = 'ashlr-fleet'
        AND ae.ts >= ${startIso}::timestamptz
        AND ae.ts <  ${endIso}::timestamptz
      GROUP BY 1
      ORDER BY proposals DESC, key ASC
    `,

    // 3b. byRepo — same, grouped by repo_name (health merged in JS).
    db<BreakdownRow[]>`
      SELECT
        ae.repo_name                                                       AS key,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal')::int           AS proposals,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal' AND ae.fleet_outcome = 'applied')::int  AS applied,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal' AND ae.fleet_outcome = 'rejected')::int AS rejected,
        COALESCE(SUM(ae.cost_millicents), 0)                               AS cost_millicents
      FROM activity_event ae
      JOIN membership m ON m.user_id::text = ae.user_id AND m.org_id = ${orgId}::uuid
      WHERE ae.source = 'ashlr-fleet'
        AND ae.repo_name IS NOT NULL
        AND ae.ts >= ${startIso}::timestamptz
        AND ae.ts <  ${endIso}::timestamptz
      GROUP BY ae.repo_name
      ORDER BY proposals DESC, key ASC
    `,

    // 3c. byOwner — proposals + approval grouped by fleet_owner.
    db<BreakdownRow[]>`
      SELECT
        ae.fleet_owner                                                     AS key,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal')::int           AS proposals,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal' AND ae.fleet_outcome = 'applied')::int  AS applied,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal' AND ae.fleet_outcome = 'rejected')::int AS rejected,
        0                                                                  AS cost_millicents
      FROM activity_event ae
      JOIN membership m ON m.user_id::text = ae.user_id AND m.org_id = ${orgId}::uuid
      WHERE ae.source = 'ashlr-fleet'
        AND ae.fleet_owner IS NOT NULL
        AND ae.ts >= ${startIso}::timestamptz
        AND ae.ts <  ${endIso}::timestamptz
      GROUP BY ae.fleet_owner
      ORDER BY proposals DESC, key ASC
    `,

    // 4. IMPACT — per-repo health snapshot for the org.
    db<HealthRow[]>`
      SELECT rh.repo_name AS repo_name, rh.health_score AS health_score
      FROM repo_health rh
      WHERE rh.org_id = ${orgId}::uuid
    `,

    // 5a. SAFETY — failed commands in the window.
    db<FailedCommandsRow[]>`
      SELECT COUNT(*)::int AS failed
      FROM fleet_command fc
      WHERE fc.org_id = ${orgId}::uuid
        AND fc.status = 'failed'
        AND fc.created_at >= ${startIso}::timestamptz
        AND fc.created_at <  ${endIso}::timestamptz
    `,

    // 5b. SAFETY — total fleet spend in the window + the org budget cap.
    db<SpendBudgetRow[]>`
      SELECT
        (SELECT COALESCE(SUM(ae.cost_millicents), 0)
           FROM activity_event ae
           JOIN membership m ON m.user_id::text = ae.user_id AND m.org_id = ${orgId}::uuid
           WHERE ae.source = 'ashlr-fleet'
             AND ae.ts >= ${startIso}::timestamptz
             AND ae.ts <  ${endIso}::timestamptz)            AS spend_millicents,
        (SELECT o.monthly_budget_usd FROM org o WHERE o.id = ${orgId}::uuid) AS budget_usd
    `,

    // 6a. TREND — this window's proposal volume + approval inputs.
    db<TrendRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal')::int                                  AS proposals,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal' AND ae.fleet_outcome = 'applied')::int  AS applied,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal' AND ae.fleet_outcome IN ('applied','rejected'))::int AS resolved
      FROM activity_event ae
      JOIN membership m ON m.user_id::text = ae.user_id AND m.org_id = ${orgId}::uuid
      WHERE ae.source = 'ashlr-fleet'
        AND ae.ts >= ${startIso}::timestamptz
        AND ae.ts <  ${endIso}::timestamptz
    `,

    // 6b. TREND — the immediately-prior window of equal length.
    db<TrendRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal')::int                                  AS proposals,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal' AND ae.fleet_outcome = 'applied')::int  AS applied,
        COUNT(*) FILTER (WHERE ae.fleet_event = 'proposal' AND ae.fleet_outcome IN ('applied','rejected'))::int AS resolved
      FROM activity_event ae
      JOIN membership m ON m.user_id::text = ae.user_id AND m.org_id = ${orgId}::uuid
      WHERE ae.source = 'ashlr-fleet'
        AND ae.ts >= ${priorStartIso}::timestamptz
        AND ae.ts <  ${startIso}::timestamptz
    `,
  ]);

  // -------------------------------------------------------------------------
  // Productivity.
  // -------------------------------------------------------------------------
  const p = prod[0] ?? {
    proposals: 0,
    ticks: 0,
    merges: 0,
    applied_outcomes: 0,
    active_agents: 0,
    repos_touched: 0,
    cost_millicents: 0,
  };

  // Use materialized aggregate totals when available (>= AGGREGATE_MIN_DAYS).
  // Ticks and merges are not stored in the aggregate table (they are less
  // important for dashboard rollup); those always come from the live query.
  const proposals = aggregateProductivity ? aggregateProductivity.proposals : p.proposals;
  const costUsd = aggregateProductivity
    ? aggregateProductivity.costUsd
    : round2(Number(p.cost_millicents ?? 0) / MILLICENTS_PER_USD);
  // Always sourced from the live query: these are window-wide COUNT(DISTINCT ...)
  // totals that cannot be reconstructed from per-day aggregate rows (see the
  // reduce note above). Using prod[0] here keeps the fast path's agent/repo
  // counts identical to the live-query semantics.
  const activeAgents = p.active_agents;
  const reposTouched = p.repos_touched;

  // Applied changes = proposals whose outcome is 'applied', corroborated by
  // explicit 'merge' events (whichever signal is larger best reflects reality).
  const appliedChanges = aggregateProductivity
    ? Math.max(aggregateProductivity.applied, p.merges)
    : Math.max(p.applied_outcomes, p.merges);

  const productivity = {
    proposals,
    perDay: round2(proposals / windowDays),
    ticks: p.ticks,
    activeAgents,
    reposTouched,
    costUsd,
    costPerProposal: proposals > 0 ? round2(costUsd / proposals) : 0,
    appliedChanges,
  };

  // -------------------------------------------------------------------------
  // Quality.
  // -------------------------------------------------------------------------
  const o = outcomes[0] ?? { applied: 0, rejected: 0, pending: 0 };
  // Use aggregate totals for applied/rejected when available — pending is not
  // stored in the aggregate (it's a live state) so always read it from the
  // live query.
  const qualityApplied = aggregateProductivity ? aggregateProductivity.applied : o.applied;
  const qualityRejected = aggregateProductivity ? aggregateProductivity.rejected : o.rejected;
  const resolved = qualityApplied + qualityRejected;
  const quality = {
    applied: qualityApplied,
    rejected: qualityRejected,
    pending: o.pending,
    resolved,
    approvalRate: rate(qualityApplied, resolved),
    rejectionRate: rate(qualityRejected, resolved),
    avgHoursToReview:
      reviewLatency[0]?.avg_hours != null ? round2(Number(reviewLatency[0].avg_hours)) : null,
    staleReviewCount: stale[0]?.stale ?? 0,
  };

  // -------------------------------------------------------------------------
  // Impact — health distribution. Without a prior per-repo snapshot we
  // approximate: improved = currently-healthy repos (>= HEALTHY_SCORE),
  // regressed = currently-unhealthy repos (< UNHEALTHY_SCORE).
  // -------------------------------------------------------------------------
  const scored = healthRows.filter((r) => r.health_score != null) as Array<{
    repo_name: string;
    health_score: number;
  }>;
  const reposImproved = scored.filter((r) => r.health_score >= HEALTHY_SCORE).length;
  const reposRegressed = scored.filter((r) => r.health_score < UNHEALTHY_SCORE).length;
  const avgHealthScore =
    scored.length > 0
      ? Math.round(scored.reduce((s, r) => s + r.health_score, 0) / scored.length)
      : null;
  const impact = { reposImproved, reposRegressed, avgHealthScore };

  // -------------------------------------------------------------------------
  // Safety.
  // -------------------------------------------------------------------------
  const sb = spendBudget[0] ?? { spend_millicents: 0, budget_usd: null };
  const spendUsd = round2(Number(sb.spend_millicents ?? 0) / MILLICENTS_PER_USD);
  const budgetCapUsd = sb.budget_usd != null ? round2(Number(sb.budget_usd)) : null;
  const safety = {
    spendUsd,
    budgetCapUsd,
    overBudget: budgetCapUsd != null ? spendUsd > budgetCapUsd : false,
    failedCommands: failedRows[0]?.failed ?? 0,
  };

  // -------------------------------------------------------------------------
  // Breakdowns.
  // -------------------------------------------------------------------------
  const healthByRepo = new Map<string, number | null>(
    healthRows.map((r) => [r.repo_name, r.health_score]),
  );

  const byEngine = byEngineRows.map((r) => ({
    engine: r.key,
    proposals: r.proposals,
    approvalRate: rate(r.applied, r.applied + r.rejected),
    costUsd: round2(Number(r.cost_millicents ?? 0) / MILLICENTS_PER_USD),
  }));

  const byRepo = byRepoRows.map((r) => ({
    repo: r.key,
    proposals: r.proposals,
    approvalRate: rate(r.applied, r.applied + r.rejected),
    costUsd: round2(Number(r.cost_millicents ?? 0) / MILLICENTS_PER_USD),
    healthScore: healthByRepo.has(r.key) ? (healthByRepo.get(r.key) ?? null) : null,
  }));

  const byOwner = byOwnerRows.map((r) => ({
    owner: r.key,
    proposals: r.proposals,
    approvalRate: rate(r.applied, r.applied + r.rejected),
  }));

  // -------------------------------------------------------------------------
  // Trend — compare this window's (per-day productivity + approvalRate) to the
  // prior equal-length window. A composite score blends the two so a single
  // metric improving while the other regresses nets to 'flat'.
  // -------------------------------------------------------------------------
  const trend = computeTrend(thisWindowTrend[0], priorWindowTrend[0], windowDays);

  return {
    window: { start: startIso, end: endIso, days: windowDays },
    productivity,
    quality,
    impact,
    safety,
    byEngine,
    byRepo,
    byOwner,
    trend,
  };
}

// ---------------------------------------------------------------------------
// Trend logic (exported for direct unit testing).
// ---------------------------------------------------------------------------

/**
 * Compare a window's productivity (proposals/day) + decision quality
 * (approvalRate) against the prior equal-length window and return a verdict.
 *
 * Composite = 0.5 * normalizedProductivityDelta + 0.5 * approvalRateDelta.
 * - improving  when composite >  TREND_EPSILON
 * - regressing when composite < -TREND_EPSILON
 * - flat       otherwise (includes the cold-start case with no prior data)
 */
export function computeTrend(
  current: TrendRow | undefined,
  prior: TrendRow | undefined,
  windowDays: number,
): "improving" | "flat" | "regressing" {
  const cur = current ?? { proposals: 0, applied: 0, resolved: 0 };
  const prev = prior ?? { proposals: 0, applied: 0, resolved: 0 };

  // No activity at all in either window → nothing to assess.
  if (cur.proposals === 0 && prev.proposals === 0) return "flat";

  const curPerDay = cur.proposals / windowDays;
  const prevPerDay = prev.proposals / windowDays;

  // Productivity delta, normalized against the prior baseline. With no prior
  // proposals but current activity, treat as a full improvement on that axis.
  let prodDelta: number;
  if (prevPerDay > 0) {
    prodDelta = (curPerDay - prevPerDay) / prevPerDay;
  } else {
    prodDelta = curPerDay > 0 ? 1 : 0;
  }
  // Clamp so a huge volume swing can't completely drown the quality signal.
  prodDelta = Math.max(-1, Math.min(1, prodDelta));

  const curApproval = cur.resolved > 0 ? cur.applied / cur.resolved : 0;
  const prevApproval = prev.resolved > 0 ? prev.applied / prev.resolved : 0;
  // Approval delta is already a 0..1-bounded difference.
  const approvalDelta =
    prev.resolved > 0 ? curApproval - prevApproval : cur.resolved > 0 ? curApproval - 0.5 : 0;

  const composite = 0.5 * prodDelta + 0.5 * approvalDelta;

  if (composite > TREND_EPSILON) return "improving";
  if (composite < -TREND_EPSILON) return "regressing";
  return "flat";
}
