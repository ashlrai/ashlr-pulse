/**
 * anomaly-incident-grouping.ts — pure helper for coalescing RealtimeAnomaly
 * streams into grouped AnomalyIncident records.
 *
 * Design
 * ──────
 * Anomalies arrive as a flat stream (one entry per detection run). This module
 * groups them into incidents so the dashboard can show "3 cost-spike anomalies
 * across 2 hours in repo X" as one incident rather than three separate alerts.
 *
 * Grouping rules
 * ──────────────
 *   1. An incoming anomaly can join an existing open incident if:
 *        a. Same org (enforced by the caller — recentIncidents is already
 *           filtered to the org).
 *        b. Same kind.
 *        c. The incident's last_seen_at is within the 2-hour merge window.
 *        d. At least one of: same repo_name (when non-null), same owner
 *           already in context.owners, OR the existing incident has no
 *           repo/owner scope (org-wide anomaly).
 *   2. If multiple open incidents match, pick the most-recently-seen one.
 *   3. On match: bump last_seen_at, increment event_count, re-compute
 *      severity as max(existing, incoming), append span_id and merge
 *      repo_names / models / owners from the new anomaly.
 *   4. On no match: create a new incident.
 *
 * Privacy
 * ───────
 * Incident context carries only numeric/enum metadata (repo_names, models,
 * owners, span_ids). No prompt text, completion text, or PII is stored.
 *
 * Pure
 * ────
 * No DB, no network, no side effects. Returns { created, updated } for the
 * caller (anomaly-persist cron) to upsert in the database.
 */

import type { RealtimeAnomaly, AnomalySeverity } from "./realtime-anomaly";

// ─── Public types ─────────────────────────────────────────────────────────────

/** Context shape stored in anomaly_incident.context JSONB. */
export interface IncidentContext {
  repo_names: string[];
  models:     string[];
  owners:     string[];
  span_ids:   string[];
}

/**
 * In-memory representation of an anomaly_incident row.
 * Mirrors the DB schema; id is present on existing rows, absent on new ones.
 */
export interface AnomalyIncident {
  /** UUID from DB (present on existing incidents, undefined on newly created). */
  id?:                    string;
  org_id:                 string;
  first_detected_at:      string; // ISO-8601
  last_seen_at:           string; // ISO-8601
  closed_at:              string | null;
  kind:                   string;
  severity:               AnomalySeverity;
  cost_impact_millicents: number;
  event_count:            number;
  context:                IncidentContext;
}

/**
 * Result of groupAnomaliesToIncidents().
 *
 * created — new incidents to INSERT into anomaly_incident.
 * updated — existing incidents to UPDATE (by id) in anomaly_incident.
 */
export interface GroupingResult {
  created: AnomalyIncident[];
  updated: AnomalyIncident[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum age of last_seen_at (ms) for an incident to still accept merges. */
export const INCIDENT_MERGE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Incidents with last_seen_at older than this (ms) are auto-closed by cron. */
export const INCIDENT_AUTO_CLOSE_MS = 4 * 60 * 60 * 1000; // 4 hours

// ─── Severity helpers ─────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<AnomalySeverity, number> = { high: 2, medium: 1, low: 0 };

/** Return the higher of two severities. */
export function maxSeverity(a: AnomalySeverity, b: AnomalySeverity): AnomalySeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

// ─── Overlap helpers ──────────────────────────────────────────────────────────

/**
 * Return true if the anomaly and incident share enough scope to be grouped.
 *
 * Rules (any one sufficient):
 *   - Both have no specific scope (org-wide anomaly, org-wide incident).
 *   - The incident already has no scoped repos/owners (org-wide incident
 *     absorbs the incoming scoped anomaly).
 *   - repo_name matches an entry in context.repo_names.
 *   - user_id / fleet_owner matches an entry in context.owners.
 */
function scopeOverlaps(
  anomaly: RealtimeAnomaly,
  incident: AnomalyIncident,
): boolean {
  const ctx = incident.context;

  // Org-wide on both sides.
  if (!anomaly.repo_name && !anomaly.user_id) return true;

  // Incident has no scoped repos and no scoped owners — it absorbs everything.
  if (ctx.repo_names.length === 0 && ctx.owners.length === 0) return true;

  // Repo overlap.
  if (anomaly.repo_name && ctx.repo_names.includes(anomaly.repo_name)) return true;

  // Owner overlap — user_id on RealtimeAnomaly maps to owners in the incident
  // context (fleet_owner handle). We store both when available.
  if (anomaly.user_id && ctx.owners.includes(anomaly.user_id)) return true;

  return false;
}

// ─── Context merge ────────────────────────────────────────────────────────────

/** Append unique values from `incoming` into `existing` (in-place). */
function mergeUnique(existing: string[], incoming: (string | null | undefined)[]): void {
  for (const v of incoming) {
    if (v && !existing.includes(v)) existing.push(v);
  }
}

/** Extract cost_impact contribution from a RealtimeAnomaly's context (if any). */
function extractCostImpact(anomaly: RealtimeAnomaly): number {
  if (anomaly.kind !== "cost_spike") return 0;
  const v = anomaly.context["batch_cost_millicents"];
  return typeof v === "number" ? v : 0;
}

/** Extract model from anomaly context (if present). */
function extractModel(anomaly: RealtimeAnomaly): string | null {
  const m = anomaly.context["model"];
  return typeof m === "string" ? m : null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Group a batch of incoming RealtimeAnomaly objects into AnomalyIncident
 * records, merging with any matching open recent incidents.
 *
 * @param batch           Incoming anomalies from this detection run.
 * @param recentIncidents Open (closed_at IS NULL) incidents fetched from DB
 *                        for this org — only these are eligible for merging.
 * @param now             Timestamp of the detection run (injectable for tests).
 * @returns               { created, updated } — caller persists to DB.
 */
export function groupAnomaliesToIncidents(
  batch: RealtimeAnomaly[],
  recentIncidents: AnomalyIncident[],
  now: Date = new Date(),
): GroupingResult {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  // Work set: mutable copies of open incidents eligible for merge.
  // We only mutate incidents within the 2-hour window (strictly < boundary).
  const eligible = recentIncidents.filter((inc) => {
    if (inc.closed_at !== null) return false;
    const age = nowMs - new Date(inc.last_seen_at).getTime();
    return age < INCIDENT_MERGE_WINDOW_MS;
  });

  // Track which incidents from `eligible` were modified.
  const updatedSet = new Set<AnomalyIncident>();
  // New incidents created in this run.
  const created: AnomalyIncident[] = [];

  for (const anomaly of batch) {
    // Find the best-matching open incident: same kind, in-window, scope overlap.
    const candidates = eligible.filter(
      (inc) => inc.kind === anomaly.kind && scopeOverlaps(anomaly, inc),
    );

    // Pick the most recently seen (closest to now = least stale).
    candidates.sort(
      (a, b) => new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime(),
    );

    const match = candidates[0] ?? null;

    if (match) {
      // ── Merge into existing incident ──────────────────────────────────────
      match.last_seen_at          = nowIso;
      match.severity              = maxSeverity(match.severity, anomaly.severity);
      match.event_count          += 1;
      match.cost_impact_millicents += extractCostImpact(anomaly);

      mergeUnique(match.context.repo_names, [anomaly.repo_name]);
      mergeUnique(match.context.owners,     [anomaly.user_id]);
      mergeUnique(match.context.models,     [extractModel(anomaly)]);
      // span_ids: anomaly doesn't carry a span_id yet — the caller supplies it
      // after inserting the anomaly_event row. Leave empty here; the cron
      // handler appends the newly created anomaly_event.id after INSERT.

      updatedSet.add(match);
    } else {
      // ── Create new incident ───────────────────────────────────────────────
      const newIncident: AnomalyIncident = {
        org_id:                 "", // caller must fill from org context
        first_detected_at:      nowIso,
        last_seen_at:           nowIso,
        closed_at:              null,
        kind:                   anomaly.kind,
        severity:               anomaly.severity,
        cost_impact_millicents: extractCostImpact(anomaly),
        event_count:            1,
        context: {
          repo_names: anomaly.repo_name ? [anomaly.repo_name] : [],
          models:     extractModel(anomaly) ? [extractModel(anomaly)!] : [],
          owners:     anomaly.user_id ? [anomaly.user_id] : [],
          span_ids:   [],
        },
      };
      created.push(newIncident);
      // Add to eligible so later anomalies in the same batch can merge into it.
      eligible.push(newIncident);
    }
  }

  return {
    created,
    updated: [...updatedSet],
  };
}

/**
 * Filter a list of incidents to those that should be auto-closed.
 * An incident is stale when its last_seen_at is older than INCIDENT_AUTO_CLOSE_MS
 * and it is still open (closed_at IS NULL).
 *
 * Pure helper — used by the auto-close cron route for in-memory filtering
 * before issuing DB updates.
 */
export function findStaleIncidents(
  incidents: AnomalyIncident[],
  now: Date = new Date(),
): AnomalyIncident[] {
  const nowMs = now.getTime();
  return incidents.filter((inc) => {
    if (inc.closed_at !== null) return false;
    const age = nowMs - new Date(inc.last_seen_at).getTime();
    return age > INCIDENT_AUTO_CLOSE_MS;
  });
}
