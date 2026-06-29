/**
 * GET  /api/dashboard/anomaly-incidents
 * POST /api/dashboard/anomaly-incidents — update incident or remediation status
 *
 * Returns grouped anomaly incidents for the authenticated user's org,
 * enriched with root-cause narrative, member anomalies, and remediation
 * suggestions so ops teams can diagnose 'why is cost spiking?' in < 30s.
 *
 * ─── Auth ─────────────────────────────────────────────────────────────────────
 * Callers must be authenticated (currentUser()). Returns 401 if no session.
 *
 * ─── GET query params ─────────────────────────────────────────────────────────
 *   ?orgId=<uuid>              — required; the org to query.
 *   ?win=7|14|30|90            — window in days for first_detected_at (default 7).
 *   ?kind=<AnomalyKind>        — optional; filter to a specific anomaly kind.
 *   ?severity=low|medium|high  — optional; filter by min severity.
 *   ?minCost=<number>          — optional; filter by min cost_impact_millicents.
 *   ?closed=true               — optional; include closed/resolved/dismissed.
 *   ?status=open|dismissed|resolved — optional; filter by incident status.
 *
 * ─── GET Response ─────────────────────────────────────────────────────────────
 * {
 *   incidents:  EnrichedIncidentRow[];
 *   windowDays: number;
 *   total:      number;
 * }
 *
 * ─── POST body ────────────────────────────────────────────────────────────────
 * { action: 'update_incident', incidentId: string, status: IncidentStatus }
 * { action: 'update_remediation', remediationId: string, status: RemediationStatus }
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
import {
  fetchRemediationsForIncidents,
  updateRemediationStatus,
  updateIncidentStatus,
  type RemediationRow,
  type RemediationStatus,
  type IncidentStatus,
} from "@/lib/anomaly-remediation-db";
import type { RootCauseSignal } from "@/lib/anomaly-grouper";

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
  severity_score:         number;
  cost_impact_millicents: number;
  event_count:            number;
  status:                 IncidentStatus;
  description:            string | null;
  root_cause_signal:      RootCauseSignal | null;
  context: {
    repo_names: string[];
    models:     string[];
    owners:     string[];
    span_ids:   string[];
  };
}

export interface EnrichedIncidentRow extends AnomalyIncidentRow {
  remediations: RemediationRow[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ALLOWED_WINDOWS     = new Set([7, 14, 30, 90]);
const SEVERITY_ORDER: AnomalySeverity[] = ["low", "medium", "high"];
const INCIDENT_STATUSES   = new Set<IncidentStatus>(["open", "dismissed", "resolved"]);

function resolveWindow(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  return ALLOWED_WINDOWS.has(n) ? n : 7;
}

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

  const allowed = await isMember(me.id, orgId);
  if (!allowed) {
    log.warn({ msg: "anomaly-incidents: access denied", viewer_id: me.id, org_id: orgId });
    return NextResponse.json({ error: "no access to this org" }, { status: 403 });
  }

  const windowDays    = resolveWindow(req.nextUrl.searchParams.get("win"));
  const kindParam     = req.nextUrl.searchParams.get("kind");
  const severityParam = req.nextUrl.searchParams.get("severity") as AnomalySeverity | null;
  const minCostParam  = req.nextUrl.searchParams.get("minCost");
  const statusParam   = req.nextUrl.searchParams.get("status") as IncidentStatus | null;
  // Legacy: ?closed=true shows non-open incidents too (maps to no status filter)
  const includeClosed = req.nextUrl.searchParams.get("closed") === "true";

  const kindFilter: AnomalyKind | null =
    kindParam && (ANOMALY_KIND_VALUES as string[]).includes(kindParam)
      ? (kindParam as AnomalyKind)
      : null;

  const severityFilter: AnomalySeverity[] | null =
    severityParam && SEVERITY_ORDER.includes(severityParam)
      ? severitiesFrom(severityParam)
      : null;

  const statusFilter: IncidentStatus | null =
    statusParam && INCIDENT_STATUSES.has(statusParam) ? statusParam : null;

  const minCost = minCostParam ? Math.max(0, parseInt(minCostParam, 10)) : 0;

  const db = sql();

  const rows = await db<{
    id:                     string;
    org_id:                 string;
    first_detected_at:      string;
    last_seen_at:           string;
    closed_at:              string | null;
    kind:                   string;
    severity:               string;
    severity_score:         number;
    cost_impact_millicents: string | number;
    event_count:            number;
    status:                 string;
    description:            string | null;
    root_cause_signal:      string | null;
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
      COALESCE(severity_score, 0)    AS severity_score,
      cost_impact_millicents::bigint AS cost_impact_millicents,
      event_count,
      COALESCE(status, 'open')       AS status,
      description,
      root_cause_signal,
      context
    FROM anomaly_incident
    WHERE org_id = ${orgId}::uuid
      AND first_detected_at >= NOW() - (${windowDays} || ' days')::interval
      AND (
        ${includeClosed || statusFilter !== null}
        OR (COALESCE(status, 'open') = 'open' AND closed_at IS NULL)
      )
      AND (${statusFilter === null} OR COALESCE(status, 'open') = ${statusFilter ?? "open"})
      AND (${kindFilter === null} OR kind = ${kindFilter ?? ""})
      AND (${severityFilter === null} OR severity = ANY(${severityFilter ?? []}::text[]))
      AND cost_impact_millicents >= ${minCost}
    ORDER BY
      severity_score DESC,
      first_detected_at DESC
    LIMIT 200
  `;

  // Build base incident rows.
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
      severity_score:         Number(r.severity_score ?? 0),
      cost_impact_millicents: Number(r.cost_impact_millicents ?? 0),
      event_count:            Number(r.event_count ?? 1),
      status:                 (r.status ?? "open") as IncidentStatus,
      description:            r.description ?? null,
      root_cause_signal:      (r.root_cause_signal ?? null) as RootCauseSignal | null,
      context:                ctx,
    };
  });

  // Fetch remediations for all returned incidents in one query.
  const incidentIds    = incidents.map((i) => i.id);
  const remediationMap = await fetchRemediationsForIncidents(incidentIds);

  const enriched: EnrichedIncidentRow[] = incidents.map((inc) => ({
    ...inc,
    remediations: remediationMap.get(inc.id) ?? [],
  }));

  log.info({
    msg:        "anomaly-incidents: returning",
    org_id:     orgId,
    count:      enriched.length,
    windowDays,
  });

  return NextResponse.json({
    incidents:  enriched,
    windowDays,
    total:      enriched.length,
  });
}

// ─── POST handler — update incident or remediation status ─────────────────────

export async function POST(req: NextRequest): Promise<Response> {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "body must be an object" }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const action = b["action"];

  // ── Update incident status ─────────────────────────────────────────────────
  if (action === "update_incident") {
    const incidentId = typeof b["incidentId"] === "string" ? b["incidentId"] : null;
    const status     = typeof b["status"] === "string" ? b["status"] as IncidentStatus : null;

    if (!incidentId || !/^[0-9a-f-]{36}$/.test(incidentId)) {
      return NextResponse.json({ error: "incidentId must be a UUID" }, { status: 400 });
    }
    if (!status || !INCIDENT_STATUSES.has(status)) {
      return NextResponse.json({ error: `status must be one of: ${[...INCIDENT_STATUSES].join(", ")}` }, { status: 400 });
    }

    // Verify the incident belongs to an org the user is a member of.
    const db = sql();
    const check = await db<{ org_id: string }[]>`
      SELECT org_id::text AS org_id FROM anomaly_incident WHERE id = ${incidentId}::uuid
    `.catch(() => []);
    const incOrgId = check[0]?.org_id;
    if (!incOrgId) {
      return NextResponse.json({ error: "incident not found" }, { status: 404 });
    }
    const memberCheck = await isMember(me.id, incOrgId);
    if (!memberCheck) {
      return NextResponse.json({ error: "no access to this incident" }, { status: 403 });
    }

    const updated = await updateIncidentStatus(incidentId, status);
    log.info({ msg: "anomaly-incidents: incident status updated", incident_id: incidentId, status, user_id: me.id });
    return NextResponse.json({ ok: updated });
  }

  // ── Update remediation status ──────────────────────────────────────────────
  if (action === "update_remediation") {
    const remediationId = typeof b["remediationId"] === "string" ? b["remediationId"] : null;
    const status        = typeof b["status"] === "string" ? b["status"] as RemediationStatus : null;
    const REMEDIATION_STATUSES = new Set<RemediationStatus>(["suggested", "in_progress", "applied", "dismissed"]);

    if (!remediationId || !/^[0-9a-f-]{36}$/.test(remediationId)) {
      return NextResponse.json({ error: "remediationId must be a UUID" }, { status: 400 });
    }
    if (!status || !REMEDIATION_STATUSES.has(status)) {
      return NextResponse.json({ error: `status must be one of: ${[...REMEDIATION_STATUSES].join(", ")}` }, { status: 400 });
    }

    // Verify access via incident → org membership.
    const db = sql();
    const check = await db<{ org_id: string }[]>`
      SELECT ai.org_id::text AS org_id
      FROM anomaly_remediation ar
      JOIN anomaly_incident ai ON ai.id = ar.incident_id
      WHERE ar.id = ${remediationId}::uuid
    `.catch(() => []);
    const remOrgId = check[0]?.org_id;
    if (!remOrgId) {
      return NextResponse.json({ error: "remediation not found" }, { status: 404 });
    }
    const memberCheck = await isMember(me.id, remOrgId);
    if (!memberCheck) {
      return NextResponse.json({ error: "no access to this remediation" }, { status: 403 });
    }

    const updated = await updateRemediationStatus(remediationId, status);
    log.info({ msg: "anomaly-incidents: remediation status updated", remediation_id: remediationId, status, user_id: me.id });
    return NextResponse.json({ ok: updated });
  }

  return NextResponse.json({ error: `unknown action: ${String(action)}` }, { status: 400 });
}
