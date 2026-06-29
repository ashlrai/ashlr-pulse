/**
 * GET /api/dashboard/team-metrics
 *
 * Returns collaborative team metrics for the authenticated user's org:
 *
 *   1. velocityVectors  — per-developer 7d rolling (commits/tokens/cost trend).
 *   2. pairCompatibility — pairwise compatibility scores (overlap, model alignment,
 *                          cost-per-event divergence, shared repos).
 *   3. pairingHeatmap   — "who was active with whom" in 2h UTC buckets (privacy-
 *                          safe: only co-active day counts, no content).
 *
 * ─── Auth / peer-share gate ──────────────────────────────────────────────────
 *
 * Callers must be authenticated. Peer-share viewers may only request metrics
 * for orgs that include them (i.e. the owner must hold an active, non-revoked
 * grant for the viewer). Without a valid grant the endpoint returns 403.
 *
 * Query params:
 *   ?orgId=<uuid>  — required; the org to compute metrics for.
 *   ?as=<userId>   — optional peer-share override; viewer must hold an active
 *                    grant from at least one member of the target org.
 *   ?win=7|14|30|90 — rolling window in days (default 30).
 *
 * ─── Privacy floor ───────────────────────────────────────────────────────────
 *
 * Only aggregate cost/event/token/commit counts flow through this endpoint.
 * No prompts, completions, repo content, or individual event metadata are
 * returned. The heatmap shows (userA, userB, bucket, count) only.
 *
 * ─── Response shape ──────────────────────────────────────────────────────────
 *
 * {
 *   velocityVectors:  VelocityVector[];
 *   pairCompatibility: PairCompatibility[];
 *   pairingHeatmap:   PairingHeatmapCell[];
 *   windowDays:       number;
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { listGrantsForViewer } from "@/lib/peer-share-db";
import { sql } from "@/lib/db";
import { log } from "@/lib/logger";
import {
  computeVelocityVectors,
  binToPairingHeatmap,
  computePairCompatibility,
  type ExtendedAggregateInput,
} from "@/lib/team-velocity-profiler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── Window validation ────────────────────────────────────────────────────────

const ALLOWED_WINDOWS = new Set([7, 14, 30, 90]);

function resolveWindow(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  return ALLOWED_WINDOWS.has(n) ? n : 30;
}

// ─── Peer-share gate ──────────────────────────────────────────────────────────

/**
 * Returns true if the viewer is allowed to see metrics for the given org.
 * Conditions:
 *   - viewer is a member of the org, OR
 *   - viewer holds at least one active non-revoked grant from a member of the org.
 */
async function canViewOrgMetrics(
  viewerId: string,
  orgId: string,
): Promise<boolean> {
  const db = sql();

  // Fast path: direct membership.
  const memberRows = await db<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM membership
    WHERE org_id = ${orgId}::uuid
      AND user_id = ${viewerId}::uuid
  `.catch(() => [] as { n: number }[]);

  if (Number(memberRows[0]?.n ?? 0) > 0) return true;

  // Peer-share path: does the viewer hold a grant from any org member?
  const grants = await listGrantsForViewer(viewerId).catch(() => []);
  if (grants.length === 0) return false;

  const ownerIds = grants.map((g) => g.owner_id);
  const memberCheck = await db<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM membership
    WHERE org_id  = ${orgId}::uuid
      AND user_id = ANY(${ownerIds}::uuid[])
  `.catch(() => [] as { n: number }[]);

  return Number(memberCheck[0]?.n ?? 0) > 0;
}

// ─── Data loader ──────────────────────────────────────────────────────────────

interface AggregateRow {
  owner_id: string;
  date: string;
  cost_millicents: string | number;
  event_count: string | number;
  token_count: string | number | null;
  commit_count: string | number | null;
  model: string | null;
  repo: string | null;
}

async function loadOrgAggregates(
  orgId: string,
  windowDays: number,
): Promise<ExtendedAggregateInput[]> {
  const db = sql();

  const cutoff = new Date(Date.now() - windowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  // Load daily aggregates for all org members from peer_share_daily_aggregate.
  // We group by owner, date, model, and repo to get granular distributions.
  const rows = await db<AggregateRow[]>`
    SELECT
      psda.owner_id::text                             AS owner_id,
      psda.date::text                                 AS date,
      SUM(psda.cost_millicents)::bigint               AS cost_millicents,
      SUM(psda.event_count)::int                      AS event_count,
      SUM(
        COALESCE(psda.tokens_input, 0) +
        COALESCE(psda.tokens_output, 0)
      )::bigint                                       AS token_count,
      -- commit count: join activity_event git commits for the day
      COALESCE(
        (
          SELECT COUNT(*)::int
          FROM activity_event ae
          WHERE ae.user_id = psda.owner_id
            AND ae.source  = 'git'
            AND ae.ts::date = psda.date::date
        ), 0
      )                                               AS commit_count,
      psda.model                                      AS model,
      NULL::text                                      AS repo
    FROM peer_share_daily_aggregate psda
    INNER JOIN membership m
      ON m.user_id = psda.owner_id
      AND m.org_id = ${orgId}::uuid
    WHERE psda.date >= ${cutoff}::date
    GROUP BY psda.owner_id, psda.date, psda.model
    ORDER BY psda.date DESC
  `.catch(() => [] as AggregateRow[]);

  return rows.map((r) => ({
    ownerId:        r.owner_id,
    date:           r.date,
    costMillicents: Number(r.cost_millicents ?? 0),
    eventCount:     Number(r.event_count ?? 0),
    tokenCount:     Number(r.token_count ?? 0),
    commitCount:    Number(r.commit_count ?? 0),
    model:          r.model ?? undefined,
    repo:           r.repo ?? undefined,
  }));
}

// ─── Heatmap weights loader ───────────────────────────────────────────────────

async function loadHeatmapWeights(
  orgId: string,
  windowDays: number,
): Promise<Map<string, number[]>> {
  const db = sql();
  const out = new Map<string, number[]>();

  try {
    const rows = await db<{ user_id: string; hour: number; value: number }[]>`
      SELECT
        ae.user_id::text   AS user_id,
        EXTRACT(HOUR FROM ae.ts)::int AS hour,
        COUNT(*)::int       AS value
      FROM activity_event ae
      INNER JOIN membership m
        ON m.user_id = ae.user_id
        AND m.org_id = ${orgId}::uuid
      WHERE ae.ts >= NOW() - (${windowDays} || ' days')::interval
      GROUP BY ae.user_id, hour
    `;

    for (const r of rows) {
      if (!out.has(r.user_id)) out.set(r.user_id, Array(24).fill(0));
      const weights = out.get(r.user_id)!;
      weights[r.hour] = (weights[r.hour] ?? 0) + r.value;
    }
  } catch {
    // Non-fatal — falls back to uniform weights in the profiler.
  }

  return out;
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<Response> {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const orgId = req.nextUrl.searchParams.get("orgId");
  if (!orgId || !/^[0-9a-f-]{36}$/.test(orgId)) {
    return NextResponse.json(
      { error: "orgId query param is required (UUID)" },
      { status: 400 },
    );
  }

  const windowDays = resolveWindow(req.nextUrl.searchParams.get("win"));

  // Peer-share gate: viewer must be an org member or hold a grant from a member.
  const allowed = await canViewOrgMetrics(me.id, orgId);
  if (!allowed) {
    log.warn({ msg: "team-metrics: access denied", viewer_id: me.id, org_id: orgId });
    return NextResponse.json(
      { error: "no access to this org's metrics" },
      { status: 403 },
    );
  }

  log.info({ msg: "team-metrics: loading", viewer_id: me.id, org_id: orgId, windowDays });

  // Load data in parallel.
  const [aggregates, heatmapWeights] = await Promise.all([
    loadOrgAggregates(orgId, windowDays),
    loadHeatmapWeights(orgId, windowDays),
  ]);

  if (aggregates.length === 0) {
    return NextResponse.json({
      velocityVectors: [],
      pairCompatibility: [],
      pairingHeatmap: [],
      windowDays,
    });
  }

  // Compute metrics (all pure functions).
  const velocityVectors   = computeVelocityVectors(aggregates);
  const pairingHeatmap    = binToPairingHeatmap(aggregates, heatmapWeights);
  const pairCompatibility = computePairCompatibility(aggregates, pairingHeatmap, windowDays);

  return NextResponse.json({
    velocityVectors,
    pairCompatibility,
    pairingHeatmap,
    windowDays,
  });
}
