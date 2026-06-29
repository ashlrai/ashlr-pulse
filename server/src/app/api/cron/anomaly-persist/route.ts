/**
 * POST /api/cron/anomaly-persist
 *
 * Hourly cron that scans recent fleet activity for anomalies and persists
 * detected anomaly_event rows for the dashboard Alerts tab.
 *
 * Auth: shared secret in `x-cron-secret` (PULSE_CRON_SECRET env), same
 * pattern as /api/cron/cost-drift-alert. Internal endpoint; not user-facing.
 *
 * Per run (once per org with fleet activity in the last 2h):
 *   1. Fetch the last 2h of fleet events for this org as FleetRealtimeEvent
 *      equivalents (already restricted to the broadcast-safe fields).
 *   2. Build the AnomalyContext from the org's 7-day rolling daily costs and
 *      the prior 50 events (for baseline windows).
 *   3. Call deriveAnomalies() — pure, no DB in the detector.
 *   4. Dedup: skip anomaly kinds already written for this org in the last 1h
 *      to avoid spamming the Alerts feed.
 *   5. Insert surviving anomalies into anomaly_event.
 *   6. Group surviving anomalies into anomaly_incident rows via
 *      groupAnomaliesToIncidents(), then upsert created/updated incidents.
 *      Each new anomaly_event.id is appended to its incident's context.span_ids.
 *   7. Enrich newly-created incidents with root_cause_signal, severity_score,
 *      and description via clusterAndEnrich(), then insert anomaly_remediation
 *      rows for each new incident.
 *
 * Privacy: reads only aggregate cost/token columns, model enums, fleet_outcome,
 * fleet_owner, and repo_name from activity_event. No prompts, completions,
 * or user-content fields are ever accessed.
 *
 * Idempotent within a 1-hour window per (org_id, kind): dedup check prevents
 * duplicate rows from multiple cron fires or retries.
 */

import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { safeEqual } from "@/lib/timing-safe";
import { log } from "@/lib/logger";
import { deriveAnomalies, type AnomalyContext, type RealtimeAnomaly } from "@/lib/realtime-anomaly";
import type { FleetRealtimeEvent } from "@/lib/fleet-realtime";
import {
  groupAnomaliesToIncidents,
  type AnomalyIncident,
} from "@/lib/anomaly-incident-grouping";
import { clusterAndEnrich } from "@/lib/anomaly-grouper";
import { insertRemediationsForIncident } from "@/lib/anomaly-remediation-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OrgRow {
  org_id: string;
}

interface OpenIncidentRow {
  id:                     string;
  first_detected_at:      string;
  last_seen_at:           string;
  closed_at:              string | null;
  kind:                   string;
  severity:               string;
  cost_impact_millicents: string | number;
  event_count:            number;
  context:                unknown;
}

interface FleetEventRow {
  ts: string;
  source: string;
  fleet_event: string | null;
  fleet_outcome: string | null;
  fleet_owner: string | null;
  repo_name: string | null;
  provider: string | null;
  model: string | null;
  duration_ms: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_millicents: number | null;
}

interface DailyCostRow {
  date: string;
  cost_millicents: string | number;
}

interface ExistingKindRow {
  kind: string;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const expected = process.env.PULSE_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "PULSE_CRON_SECRET not configured" }, { status: 500 });
  }
  const supplied = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(supplied, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  log.info({ msg: "cron: anomaly-persist starting" });

  const db = sql();

  // ── 1. Collect orgs that have had fleet activity in the last 2h ────────────
  const orgs = await db<OrgRow[]>`
    SELECT DISTINCT m.org_id::text AS org_id
    FROM activity_event ae
    JOIN membership m ON m.user_id = ae.user_id
    WHERE ae.source = 'ashlr-fleet'
      AND ae.ts >= NOW() - INTERVAL '2 hours'
  `;

  const results: { org_id: string; inserted: number; skipped: number; error?: string }[] = [];

  for (const { org_id } of orgs) {
    try {
      // ── 2a. Fetch the last 2h of fleet events (broadcast-safe columns only) ──
      const recentRows = await db<FleetEventRow[]>`
        SELECT
          ae.ts::text          AS ts,
          ae.source            AS source,
          ae.fleet_event       AS fleet_event,
          ae.fleet_outcome     AS fleet_outcome,
          ae.fleet_owner       AS fleet_owner,
          ae.repo_name         AS repo_name,
          ae.provider          AS provider,
          ae.model             AS model,
          ae.duration_ms       AS duration_ms,
          ae.tokens_input      AS tokens_input,
          ae.tokens_output     AS tokens_output,
          ae.cost_millicents   AS cost_millicents
        FROM activity_event ae
        JOIN membership m ON m.user_id = ae.user_id
        WHERE m.org_id = ${org_id}::uuid
          AND ae.source = 'ashlr-fleet'
          AND ae.ts >= NOW() - INTERVAL '2 hours'
        ORDER BY ae.ts ASC
        LIMIT 500
      `;

      if (recentRows.length === 0) {
        results.push({ org_id, inserted: 0, skipped: 0 });
        continue;
      }

      // Cast DB rows to FleetRealtimeEvent (the broadcast-safe shape).
      const batch: FleetRealtimeEvent[] = recentRows.map((r) => ({
        ts:              r.ts,
        source:          r.source,
        fleet_event:     r.fleet_event,
        fleet_outcome:   r.fleet_outcome,
        fleet_owner:     r.fleet_owner,
        repo_name:       r.repo_name,
        provider:        r.provider,
        model:           r.model,
        duration_ms:     r.duration_ms,
        tokens_input:    r.tokens_input,
        tokens_output:   r.tokens_output,
        cost_millicents: r.cost_millicents,
      }));

      // ── 2b. Rolling 7-day daily costs for the cost-spike baseline ─────────
      const dailyCostRows = await db<DailyCostRow[]>`
        SELECT
          DATE(ae.ts AT TIME ZONE 'UTC')::text         AS date,
          COALESCE(SUM(ae.cost_millicents), 0)::bigint AS cost_millicents
        FROM activity_event ae
        JOIN membership m ON m.user_id = ae.user_id
        WHERE m.org_id = ${org_id}::uuid
          AND ae.source = 'ashlr-fleet'
          AND ae.ts >= NOW() - INTERVAL '7 days'
          AND ae.ts < NOW() - INTERVAL '2 hours'
        GROUP BY DATE(ae.ts AT TIME ZONE 'UTC')
        ORDER BY date ASC
      `;
      const rollingDailyCosts = dailyCostRows.map((r) => Number(r.cost_millicents ?? 0));

      // ── 2c. Prior-50-event baseline for token explosion + sliding windows ──
      const priorRows = await db<FleetEventRow[]>`
        SELECT
          ae.ts::text          AS ts,
          ae.source            AS source,
          ae.fleet_event       AS fleet_event,
          ae.fleet_outcome     AS fleet_outcome,
          ae.fleet_owner       AS fleet_owner,
          ae.repo_name         AS repo_name,
          ae.provider          AS provider,
          ae.model             AS model,
          ae.duration_ms       AS duration_ms,
          ae.tokens_input      AS tokens_input,
          ae.tokens_output     AS tokens_output,
          ae.cost_millicents   AS cost_millicents
        FROM activity_event ae
        JOIN membership m ON m.user_id = ae.user_id
        WHERE m.org_id = ${org_id}::uuid
          AND ae.source = 'ashlr-fleet'
          AND ae.ts >= NOW() - INTERVAL '8 hours'
          AND ae.ts < NOW() - INTERVAL '2 hours'
        ORDER BY ae.ts ASC
        LIMIT 50
      `;
      const recentEvents: FleetRealtimeEvent[] = priorRows.map((r) => ({
        ts:              r.ts,
        source:          r.source,
        fleet_event:     r.fleet_event,
        fleet_outcome:   r.fleet_outcome,
        fleet_owner:     r.fleet_owner,
        repo_name:       r.repo_name,
        provider:        r.provider,
        model:           r.model,
        duration_ms:     r.duration_ms,
        tokens_input:    r.tokens_input,
        tokens_output:   r.tokens_output,
        cost_millicents: r.cost_millicents,
      }));

      const recentEventTokens = recentEvents.map(
        (e) => (e.tokens_input ?? 0) + (e.tokens_output ?? 0),
      );

      // Build per-owner cost map from prior events.
      const ownerCosts: Record<string, number> = {};
      for (const e of recentEvents) {
        const owner = e.fleet_owner ?? "__unknown__";
        ownerCosts[owner] = (ownerCosts[owner] ?? 0) + (e.cost_millicents ?? 0);
      }

      const context: AnomalyContext = {
        rollingDailyCosts,
        recentEventTokens,
        recentEvents,
        ownerCosts,
      };

      // ── 3. Run pure detection ─────────────────────────────────────────────
      const anomalies = deriveAnomalies(batch, context);
      if (anomalies.length === 0) {
        results.push({ org_id, inserted: 0, skipped: 0 });
        continue;
      }

      // ── 4. Dedup: skip kinds already written for this org in the last 1h ──
      const existingKinds = await db<ExistingKindRow[]>`
        SELECT DISTINCT kind
        FROM anomaly_event
        WHERE org_id = ${org_id}::uuid
          AND ts >= NOW() - INTERVAL '1 hour'
      `;
      const alreadyWritten = new Set(existingKinds.map((r) => r.kind));

      const toInsert = anomalies.filter((a) => !alreadyWritten.has(a.kind));

      // ── 5. Persist surviving anomalies + group into incidents ────────────
      let inserted = 0;

      // Collect inserted anomaly_event ids so we can link them to incidents.
      const insertedEvents: Array<{ anomaly: RealtimeAnomaly; event_id: string }> = [];

      for (const anomaly of toInsert) {
        const rows = await db<{ id: string }[]>`
          INSERT INTO anomaly_event (org_id, severity, kind, repo_name, context_json)
          VALUES (
            ${org_id}::uuid,
            ${anomaly.severity},
            ${anomaly.kind},
            ${anomaly.repo_name},
            ${JSON.stringify({ ...anomaly.context, message: anomaly.message })}::jsonb
          )
          RETURNING id::text AS id
        `;
        const event_id = rows[0]?.id ?? "";
        if (event_id) insertedEvents.push({ anomaly, event_id });
        inserted++;
      }

      // ── 6. Group anomalies into incidents ─────────────────────────────────
      if (insertedEvents.length > 0) {
        try {
          // Fetch currently open incidents for this org (2-hour merge window).
          const openRows = await db<OpenIncidentRow[]>`
            SELECT
              id::text                   AS id,
              first_detected_at::text    AS first_detected_at,
              last_seen_at::text         AS last_seen_at,
              closed_at::text            AS closed_at,
              kind,
              severity,
              cost_impact_millicents::bigint AS cost_impact_millicents,
              event_count,
              context
            FROM anomaly_incident
            WHERE org_id   = ${org_id}::uuid
              AND closed_at IS NULL
              AND last_seen_at >= NOW() - INTERVAL '2 hours'
            ORDER BY last_seen_at DESC
            LIMIT 100
          `;

          const recentIncidents: AnomalyIncident[] = openRows.map((r) => ({
            id:                     r.id,
            org_id,
            first_detected_at:      r.first_detected_at,
            last_seen_at:           r.last_seen_at,
            closed_at:              r.closed_at ?? null,
            kind:                   r.kind,
            severity:               r.severity as AnomalyIncident["severity"],
            cost_impact_millicents: Number(r.cost_impact_millicents ?? 0),
            event_count:            Number(r.event_count ?? 1),
            context: (() => {
              const raw = r.context;
              if (raw && typeof raw === "object" && !Array.isArray(raw)) {
                const c = raw as Record<string, unknown>;
                return {
                  repo_names: Array.isArray(c.repo_names) ? c.repo_names as string[] : [],
                  models:     Array.isArray(c.models)     ? c.models     as string[] : [],
                  owners:     Array.isArray(c.owners)     ? c.owners     as string[] : [],
                  span_ids:   Array.isArray(c.span_ids)   ? c.span_ids   as string[] : [],
                };
              }
              return { repo_names: [], models: [], owners: [], span_ids: [] };
            })(),
          }));

          const batchAnomalies = insertedEvents.map((e) => e.anomaly);
          const { created, updated } = groupAnomaliesToIncidents(batchAnomalies, recentIncidents);

          // Fill org_id on newly created incidents (grouping helper leaves it blank).
          for (const inc of created) {
            inc.org_id = org_id;
          }

          // Attach span_ids: map each anomaly to its incident in the result.
          // We match by order (created incidents correspond to unmatched anomalies
          // in batch order) and update context.span_ids.
          let createdIdx = 0;
          for (const { anomaly, event_id } of insertedEvents) {
            // Find the incident this anomaly ended up in (created or updated).
            const inCreated = created.find(
              (inc) => inc.kind === anomaly.kind && !inc.context.span_ids.includes(event_id),
            );
            const inUpdated = updated.find(
              (inc) => inc.kind === anomaly.kind && !inc.context.span_ids.includes(event_id),
            );
            const target = inCreated ?? inUpdated ?? null;
            if (target && !target.context.span_ids.includes(event_id)) {
              target.context.span_ids.push(event_id);
            }
            createdIdx++;
          }

          // Enrich created incidents with root_cause_signal, severity_score,
          // description via the anomaly-grouper's clusterAndEnrich().
          // We cluster the anomalies that belong to each created incident
          // by matching kind, then apply enrichment to the incident.
          const enrichmentMap = new Map<string, ReturnType<typeof clusterAndEnrich>[number]["enrichment"]>();
          if (created.length > 0) {
            // Cluster the full surviving batch to derive root-cause signals.
            const clusters = clusterAndEnrich(batchAnomalies);
            // Match each created incident to the best-fitting cluster by kind.
            for (const inc of created) {
              const match = clusters.find((c) =>
                c.cluster.anomalies.some((a) => a.kind === inc.kind),
              );
              if (match) {
                enrichmentMap.set(`${inc.kind}-${inc.first_detected_at}`, match.enrichment);
              }
            }
          }

          // INSERT new incidents.
          for (const inc of created) {
            const enrichKey = `${inc.kind}-${inc.first_detected_at}`;
            const enrichment = enrichmentMap.get(enrichKey) ?? null;

            const insertedRows = await db<{ id: string }[]>`
              INSERT INTO anomaly_incident
                (org_id, first_detected_at, last_seen_at, kind, severity,
                 cost_impact_millicents, event_count, context,
                 description, root_cause_signal, severity_score, status)
              VALUES (
                ${inc.org_id}::uuid,
                ${inc.first_detected_at}::timestamptz,
                ${inc.last_seen_at}::timestamptz,
                ${inc.kind},
                ${inc.severity},
                ${inc.cost_impact_millicents},
                ${inc.event_count},
                ${JSON.stringify(inc.context)}::jsonb,
                ${enrichment?.description ?? null},
                ${enrichment?.root_cause_signal ?? null},
                ${enrichment?.severity_score ?? 0},
                'open'
              )
              RETURNING id::text AS id
            `;

            // Insert suggested remediation actions for new incidents.
            const newId = insertedRows[0]?.id;
            if (newId && enrichment?.root_cause_signal) {
              try {
                await insertRemediationsForIncident(newId, enrichment.root_cause_signal);
              } catch (remErr) {
                const msg = remErr instanceof Error ? remErr.message : String(remErr);
                log.warn({ msg: "cron: anomaly-persist remediation insert failed (non-fatal)", incident_id: newId, err: msg });
              }
            }
          }

          // UPDATE merged incidents.
          for (const inc of updated) {
            if (!inc.id) continue;
            await db`
              UPDATE anomaly_incident SET
                last_seen_at           = ${inc.last_seen_at}::timestamptz,
                severity               = ${inc.severity},
                cost_impact_millicents = ${inc.cost_impact_millicents},
                event_count            = ${inc.event_count},
                context                = ${JSON.stringify(inc.context)}::jsonb
              WHERE id = ${inc.id}::uuid
            `;
          }

          log.info({
            msg:              "cron: anomaly-persist incidents",
            org_id,
            incidents_created: created.length,
            incidents_updated: updated.length,
          });
        } catch (incidentErr) {
          // Incident grouping is best-effort — anomaly_event rows are already
          // inserted. Log the error but do not fail the org run.
          const msg = incidentErr instanceof Error ? incidentErr.message : String(incidentErr);
          log.warn({ msg: "cron: anomaly-persist incident grouping failed (non-fatal)", org_id, err: msg });
        }
      }

      const skipped = anomalies.length - inserted;
      results.push({ org_id, inserted, skipped });

      log.info({
        msg: "cron: anomaly-persist org done",
        org_id,
        anomalies_detected: anomalies.length,
        inserted,
        skipped,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ msg: "cron: anomaly-persist org threw", org_id, err: msg });
      results.push({ org_id, inserted: 0, skipped: 0, error: msg });
    }
  }

  const elapsed_ms = Date.now() - startedAt;
  const totalInserted = results.reduce((s, r) => s + r.inserted, 0);
  const totalErrors   = results.filter((r) => r.error).length;

  log.info({
    msg: "cron: anomaly-persist done",
    elapsed_ms,
    orgs: orgs.length,
    inserted: totalInserted,
    errors: totalErrors,
  });

  return NextResponse.json({
    ok: true,
    elapsed_ms,
    orgs: orgs.length,
    inserted: totalInserted,
    errors: totalErrors,
  });
}
