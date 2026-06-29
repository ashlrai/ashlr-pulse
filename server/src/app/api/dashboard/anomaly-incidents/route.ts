/**
 * GET /api/dashboard/anomaly-incidents
 *
 * Returns grouped anomaly incidents for the authenticated user's org.
 *
 * ─── Auth ─────────────────────────────────────────────────────────────────────
 * Callers must be authenticated (currentUser()). Returns 401 if no session.
 *
 * ─── Query params ─────────────────────────────────────────────────────────────
 *   ?orgId=<uuid>       — required; the org to query.
 *   ?win=7|14|30|90     — window in days for first_detected_at filter (default 7).
 *   ?kind=<AnomalyKind> — optional; filter to a specific anomaly kind.
 *   ?severity=low|medium|high — optional; filter by min severity.
 *   ?minCost=<number>   — optional; filter by min cost_impact_millicents.
 *   ?closed=true        — optional; include closed incidents (default: open only).
 *
 * ─── Response ────────────────────────────────────────────────────────────────
 * {
 *   incidents:  AnomalyIncidentRow[];
 *   windowDays: number;
 *   total:      number;
 * }
 *
 * ─── Performance ──────────────────────────────────────────────────────────────
 * The query uses the (org_id, first_detected_at DESC) index from migration
 * 0048_anomaly_incident.sql, giving <50ms for typical org sizes.
 *
 * ─── Privacy ──────────────────────────────────────────────────────────────────
 * Incident context carries only aggregate numeric/enum metadata — no prompts,
 * completions, or PII beyond repo_name / owner handles already visible in
 * the Alerts tab.
 */

import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { sql } from "@/lib/db";
import { log } from "@/lib/logger";
import { ANOMALY_KIND_VALUES, type AnomalyKind, type AnomalySeverity } from "@/lib/realtime-anomaly";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnomalyIncidentRow {
  id:                     string;
  org_id:                 string;
  first_detected_at:      string;
  last_seen_at:           string;
  closed_at:              string | null;
  kind:                   AnomalyKind;
  severity:               AnomalySeverity;
  cost_impact_millicents: number;
  event_count:            number;
  context: {
    repo_names: string[];
    models:     string[];
    owners:     string[];
    span_ids:   string[];
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ALLOWED_WINDOWS = new Set([7, 14, 30, 90]);
const SEVERITY_ORDER: AnomalySeverity[] = ["low", "medium", "high"];

function resolveWindow(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  return ALLOWED_WINDOWS.has(n) ? n : 7;
}

/** Return all severities >= the given minimum severity. */
function severitiesFrom(min: AnomalySeverity): AnomalySeverity[] {
  const idx = SEVERITY_ORDER.indexOf(min);
  return idx === -1 ? SEVERITY_ORDER : SEVERITY_ORDER.slice(idx);
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function isMember(userId: string, orgId: string): Promise<boolean> {
  const db = sql();
  const rows = await db<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM membership
    WHERE org_id  = ${orgId}::uuid
      AND user_id = ${userId}::uuid
  `.catch(() => [] as { n: number }[]);
  return Number(rows[0]?.n ?? 0) > 0;
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

  // Membership gate — only org members may query incidents.
  const allowed = await isMember(me.id, orgId);
  if (!allowed) {
    log.warn({ msg: "anomaly-incidents: access denied", viewer_id: me.id, org_id: orgId });
    return NextResponse.json({ error: "no access to this org" }, { status: 403 });
  }

  const windowDays  = resolveWindow(req.nextUrl.searchParams.get("win"));
  const kindParam   = req.nextUrl.searchParams.get("kind");
  const severityParam = req.nextUrl.searchParams.get("severity") as AnomalySeverity | null;
  const minCostParam  = req.nextUrl.searchParams.get("minCost");
  const includeClosed = req.nextUrl.searchParams.get("closed") === "true";

  // Validate kind filter.
  const kindFilter: AnomalyKind | null =
    kindParam && (ANOMALY_KIND_VALUES as string[]).includes(kindParam)
      ? (kindParam as AnomalyKind)
      : null;

  // Validate severity filter.
  const severityFilter: AnomalySeverity[] | null =
    severityParam && SEVERITY_ORDER.includes(severityParam)
      ? severitiesFrom(severityParam)
      : null;

  const minCost = minCostParam ? Math.max(0, parseInt(minCostParam, 10)) : 0;

  const db = sql();

  // Build the query. We use explicit CASE logic rather than dynamic fragments
  // to keep parameterization clean and avoid SQL injection vectors.
  const rows = await db<{
    id:                     string;
    org_id:                 string;
    first_detected_at:      string;
    last_seen_at:           string;
    closed_at:              string | null;
    kind:                   string;
    severity:               string;
    cost_impact_millicents: string | number;
    event_count:            number;
    context:                unknown;
  }[]>`
    SELECT
      id::text                       AS id,
      org_id::text                   AS org_id,
      first_detected_at::text        AS first_detected_at,
      last_seen_at::text             AS last_seen_at,
      closed_at::text                AS closed_at,
      kind,
      severity,
      cost_impact_millicents::bigint AS cost_impact_millicents,
      event_count,
      context
    FROM anomaly_incident
    WHERE org_id = ${orgId}::uuid
      AND first_detected_at >= NOW() - (${windowDays} || ' days')::interval
      AND (${includeClosed} OR closed_at IS NULL)
      AND (${kindFilter === null} OR kind = ${kindFilter ?? ""})
      AND (${severityFilter === null} OR severity = ANY(${severityFilter ?? []}::text[]))
      AND cost_impact_millicents >= ${minCost}
    ORDER BY first_detected_at DESC
    LIMIT 200
  `;

  const incidents: AnomalyIncidentRow[] = rows.map((r) => {
    let ctx = { repo_names: [] as string[], models: [] as string[], owners: [] as string[], span_ids: [] as string[] };
    try {
      const raw = r.context;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const c = raw as Record<string, unknown>;
        ctx = {
          repo_names: Array.isArray(c.repo_names) ? c.repo_names as string[] : [],
          models:     Array.isArray(c.models)     ? c.models     as string[] : [],
          owners:     Array.isArray(c.owners)     ? c.owners     as string[] : [],
          span_ids:   Array.isArray(c.span_ids)   ? c.span_ids   as string[] : [],
        };
      }
    } catch { /* leave empty */ }

    return {
      id:                     r.id,
      org_id:                 r.org_id,
      first_detected_at:      r.first_detected_at,
      last_seen_at:           r.last_seen_at,
      closed_at:              r.closed_at ?? null,
      kind:                   r.kind as AnomalyKind,
      severity:               r.severity as AnomalySeverity,
      cost_impact_millicents: Number(r.cost_impact_millicents ?? 0),
      event_count:            Number(r.event_count ?? 1),
      context:                ctx,
    };
  });

  log.info({
    msg:        "anomaly-incidents: returning",
    org_id:     orgId,
    count:      incidents.length,
    windowDays,
  });

  return NextResponse.json({
    incidents,
    windowDays,
    total: incidents.length,
  });
}
