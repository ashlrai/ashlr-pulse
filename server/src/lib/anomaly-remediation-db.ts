/**
 * anomaly-remediation-db.ts — DB helpers for the anomaly_remediation table.
 *
 * Responsible for:
 *   1. Deriving the correct remediation actions for a root-cause signal.
 *   2. Inserting new anomaly_remediation rows for a newly-created incident.
 *   3. Updating remediation status (applied / dismissed / in_progress).
 *   4. Fetching remediations for one or many incidents.
 *   5. Updating anomaly_incident.status (open → dismissed | resolved).
 *
 * Privacy: only metadata (timestamps, enums, incident IDs). No user content.
 */

import { sql } from "./db";
import type { RootCauseSignal } from "./anomaly-grouper";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RemediationKind =
  | "reduce_token_window"
  | "switch_model"
  | "increase_budget"
  | "review_cache_config"
  | "investigate_failures"
  | "investigate_peer";

export type RemediationStatus =
  | "suggested"
  | "in_progress"
  | "applied"
  | "dismissed";

export type IncidentStatus =
  | "open"
  | "dismissed"
  | "resolved";

export interface RemediationRow {
  id:               string;
  incident_id:      string;
  remediation_kind: RemediationKind;
  status:           RemediationStatus;
  created_at:       string;
  updated_at:       string;
}

// ─── Remediation rules ────────────────────────────────────────────────────────

/**
 * Return the recommended remediation kinds for a given root-cause signal.
 *
 * These are the actionable steps an ops team would take to resolve the incident.
 * Always return at least 1 and at most 3 suggestions per signal.
 */
export function remediationsForSignal(signal: RootCauseSignal): RemediationKind[] {
  switch (signal) {
    case "new_model_thrashing":
      return ["switch_model", "reduce_token_window"];

    case "cost_spike_with_high_rejection_rate":
      return ["investigate_failures", "increase_budget", "reduce_token_window"];

    case "cache_miss_storm":
      return ["review_cache_config", "reduce_token_window"];

    case "token_explosion_single_repo":
      return ["reduce_token_window", "switch_model"];

    case "peer_cost_divergence":
      return ["investigate_peer", "switch_model"];

    case "tool_failure_cascade":
      return ["investigate_failures", "review_cache_config"];

    case "generic_cost_spike":
    default:
      return ["increase_budget", "reduce_token_window", "switch_model"];
  }
}

// ─── Insert remediations for a new incident ───────────────────────────────────

/**
 * Insert anomaly_remediation rows for a newly-created incident.
 * Derives the remediation kinds from the incident's root_cause_signal.
 *
 * Returns the inserted rows.
 */
export async function insertRemediationsForIncident(
  incidentId: string,
  signal: RootCauseSignal,
): Promise<RemediationRow[]> {
  const kinds = remediationsForSignal(signal);
  const db    = sql();
  const rows: RemediationRow[] = [];

  for (const kind of kinds) {
    const inserted = await db<{
      id: string;
      incident_id: string;
      remediation_kind: string;
      status: string;
      created_at: string;
      updated_at: string;
    }[]>`
      INSERT INTO anomaly_remediation (incident_id, remediation_kind)
      VALUES (${incidentId}::uuid, ${kind})
      RETURNING
        id::text               AS id,
        incident_id::text      AS incident_id,
        remediation_kind,
        status,
        created_at::text       AS created_at,
        updated_at::text       AS updated_at
    `;
    if (inserted[0]) {
      rows.push({
        id:               inserted[0].id,
        incident_id:      inserted[0].incident_id,
        remediation_kind: inserted[0].remediation_kind as RemediationKind,
        status:           inserted[0].status as RemediationStatus,
        created_at:       inserted[0].created_at,
        updated_at:       inserted[0].updated_at,
      });
    }
  }

  return rows;
}

// ─── Fetch remediations ───────────────────────────────────────────────────────

/**
 * Fetch all remediation rows for a single incident (ordered by created_at).
 */
export async function fetchRemediationsForIncident(
  incidentId: string,
): Promise<RemediationRow[]> {
  const db = sql();
  const rows = await db<{
    id: string;
    incident_id: string;
    remediation_kind: string;
    status: string;
    created_at: string;
    updated_at: string;
  }[]>`
    SELECT
      id::text           AS id,
      incident_id::text  AS incident_id,
      remediation_kind,
      status,
      created_at::text   AS created_at,
      updated_at::text   AS updated_at
    FROM anomaly_remediation
    WHERE incident_id = ${incidentId}::uuid
    ORDER BY created_at ASC
  `;
  return rows.map((r) => ({
    id:               r.id,
    incident_id:      r.incident_id,
    remediation_kind: r.remediation_kind as RemediationKind,
    status:           r.status as RemediationStatus,
    created_at:       r.created_at,
    updated_at:       r.updated_at,
  }));
}

/**
 * Fetch remediations for multiple incidents in a single query.
 * Returns a map of incident_id → RemediationRow[].
 */
export async function fetchRemediationsForIncidents(
  incidentIds: string[],
): Promise<Map<string, RemediationRow[]>> {
  if (incidentIds.length === 0) return new Map();

  const db = sql();
  const rows = await db<{
    id: string;
    incident_id: string;
    remediation_kind: string;
    status: string;
    created_at: string;
    updated_at: string;
  }[]>`
    SELECT
      id::text           AS id,
      incident_id::text  AS incident_id,
      remediation_kind,
      status,
      created_at::text   AS created_at,
      updated_at::text   AS updated_at
    FROM anomaly_remediation
    WHERE incident_id = ANY(${incidentIds}::uuid[])
    ORDER BY incident_id, created_at ASC
  `;

  const result = new Map<string, RemediationRow[]>();
  for (const r of rows) {
    const list = result.get(r.incident_id) ?? [];
    list.push({
      id:               r.id,
      incident_id:      r.incident_id,
      remediation_kind: r.remediation_kind as RemediationKind,
      status:           r.status as RemediationStatus,
      created_at:       r.created_at,
      updated_at:       r.updated_at,
    });
    result.set(r.incident_id, list);
  }
  return result;
}

// ─── Update remediation status ────────────────────────────────────────────────

/**
 * Update the status of a single remediation row.
 * Returns true if the row was found and updated.
 */
export async function updateRemediationStatus(
  remediationId: string,
  status: RemediationStatus,
): Promise<boolean> {
  const db = sql();
  const rows = await db<{ id: string }[]>`
    UPDATE anomaly_remediation
    SET    status     = ${status},
           updated_at = NOW()
    WHERE  id = ${remediationId}::uuid
    RETURNING id::text AS id
  `;
  return rows.length > 0;
}

// ─── Update incident status ───────────────────────────────────────────────────

/**
 * Update the status of an anomaly_incident row.
 * Sets closed_at when transitioning to 'resolved' or 'dismissed'.
 * Returns true if the row was found and updated.
 */
export async function updateIncidentStatus(
  incidentId: string,
  status: IncidentStatus,
): Promise<boolean> {
  const db = sql();
  const shouldClose = status === "resolved" || status === "dismissed";

  const rows = await db<{ id: string }[]>`
    UPDATE anomaly_incident
    SET    status    = ${status},
           closed_at = CASE WHEN ${shouldClose} THEN NOW() ELSE closed_at END
    WHERE  id = ${incidentId}::uuid
    RETURNING id::text AS id
  `;
  return rows.length > 0;
}
