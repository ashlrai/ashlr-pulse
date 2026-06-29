/**
 * anomaly-preference-db.ts — DB helpers for user_anomaly_preference.
 *
 * Provides CRUD for per-user anomaly alert preferences. Each preference row
 * stores a toggle (enabled/disabled) and optional custom severity thresholds
 * for one anomaly kind. Absence of a row means "use defaults" — callers
 * should call getEffectivePreferences() which fills in defaults for missing
 * kinds.
 *
 * Design
 * ──────
 *   • All functions are thin wrappers around SQL — no business logic.
 *   • getEffectivePreferences() always returns a full 6-kind map, merging
 *     stored rows with defaults for any missing kinds.
 *   • upsertPreference() is idempotent (INSERT ... ON CONFLICT DO UPDATE).
 *   • filterAnomaliesByPreferences() is a pure function (no DB access) that
 *     filters a RealtimeAnomaly[] against a loaded preference map.
 *
 * Privacy: reads/writes only user_id, kind, enabled, threshold columns.
 * No user-content is stored or returned.
 */

import { sql } from "./db";
import type { AnomalyKind, AnomalySeverity, RealtimeAnomaly } from "./realtime-anomaly";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnomalyPreference {
  kind: AnomalyKind;
  enabled: boolean;
  /** Multiplier for the low/medium severity boundary (default 1.0). */
  severity_low_threshold: number;
  /** Multiplier for the medium/high severity boundary (default 1.0). */
  severity_high_threshold: number;
}

/** Full 6-kind preference map keyed by AnomalyKind. */
export type AnomalyPreferenceMap = Record<AnomalyKind, AnomalyPreference>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ANOMALY_KINDS: AnomalyKind[] = [
  "cost_spike",
  "token_explosion",
  "tool_failure_rate",
  "model_thrash",
  "cache_miss_storm",
  "peer_divergence",
];

const DEFAULT_PREFERENCE: Omit<AnomalyPreference, "kind"> = {
  enabled: true,
  severity_low_threshold: 1.0,
  severity_high_threshold: 1.0,
};

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

interface PreferenceRow {
  kind: string;
  enabled: boolean;
  severity_low_threshold: number;
  severity_high_threshold: number;
}

// ---------------------------------------------------------------------------
// getEffectivePreferences — load + fill defaults
// ---------------------------------------------------------------------------

/**
 * Load all stored preferences for a user and fill in defaults for any
 * anomaly kinds not yet stored. Returns a complete 6-kind map.
 */
export async function getEffectivePreferences(
  userId: string,
): Promise<AnomalyPreferenceMap> {
  const db = sql();
  const rows = await db<PreferenceRow[]>`
    SELECT kind, enabled, severity_low_threshold, severity_high_threshold
    FROM user_anomaly_preference
    WHERE user_id = ${userId}::uuid
  `;

  // Build map from stored rows.
  const stored: Partial<AnomalyPreferenceMap> = {};
  for (const row of rows) {
    if (ANOMALY_KINDS.includes(row.kind as AnomalyKind)) {
      stored[row.kind as AnomalyKind] = {
        kind: row.kind as AnomalyKind,
        enabled: row.enabled,
        severity_low_threshold: row.severity_low_threshold,
        severity_high_threshold: row.severity_high_threshold,
      };
    }
  }

  // Fill in defaults for any missing kinds.
  const result = {} as AnomalyPreferenceMap;
  for (const kind of ANOMALY_KINDS) {
    result[kind] = stored[kind] ?? { kind, ...DEFAULT_PREFERENCE };
  }
  return result;
}

// ---------------------------------------------------------------------------
// upsertPreference — save one preference row
// ---------------------------------------------------------------------------

/**
 * Upsert (insert or update) a single preference row for a user+kind pair.
 * Safe to call repeatedly — last write wins.
 */
export async function upsertPreference(
  userId: string,
  pref: AnomalyPreference,
): Promise<void> {
  const db = sql();
  await db`
    INSERT INTO user_anomaly_preference
      (user_id, kind, enabled, severity_low_threshold, severity_high_threshold, updated_at)
    VALUES (
      ${userId}::uuid,
      ${pref.kind},
      ${pref.enabled},
      ${pref.severity_low_threshold},
      ${pref.severity_high_threshold},
      NOW()
    )
    ON CONFLICT (user_id, kind) DO UPDATE SET
      enabled                 = EXCLUDED.enabled,
      severity_low_threshold  = EXCLUDED.severity_low_threshold,
      severity_high_threshold = EXCLUDED.severity_high_threshold,
      updated_at              = NOW()
  `;
}

// ---------------------------------------------------------------------------
// upsertPreferences — save all preferences at once (bulk upsert)
// ---------------------------------------------------------------------------

/**
 * Bulk-upsert a partial or full preference map. Only the provided kinds are
 * written — unmentioned kinds are left untouched.
 */
export async function upsertPreferences(
  userId: string,
  prefs: Partial<AnomalyPreferenceMap>,
): Promise<void> {
  const entries = Object.values(prefs);
  if (entries.length === 0) return;

  // Run upserts sequentially (small N=6 max, simplicity > performance here).
  for (const pref of entries) {
    await upsertPreference(userId, pref);
  }
}

// ---------------------------------------------------------------------------
// filterAnomaliesByPreferences — pure filter (no DB)
// ---------------------------------------------------------------------------

/**
 * Filter a list of RealtimeAnomaly objects against a loaded preference map.
 * Anomalies whose kind is disabled in the user's preferences are removed.
 * Severity thresholds are applied to potentially downgrade/suppress alerts:
 *   - An anomaly's severity is recalculated against the user's custom
 *     thresholds if they differ from 1.0. This allows a user to make their
 *     personal "medium" threshold stricter (raise threshold) or looser
 *     (lower threshold).
 *
 * Implementation note: threshold multipliers are applied to the ratio stored
 * in the anomaly's context. If context.ratio is absent the anomaly passes
 * through unchanged.
 *
 * Pure function — safe to call without any DB access.
 */
export function filterAnomaliesByPreferences(
  anomalies: RealtimeAnomaly[],
  prefs: AnomalyPreferenceMap,
): RealtimeAnomaly[] {
  const out: RealtimeAnomaly[] = [];

  for (const anomaly of anomalies) {
    const pref = prefs[anomaly.kind];
    if (!pref) {
      // Unknown kind — pass through (defensive).
      out.push(anomaly);
      continue;
    }

    // Drop if the user disabled this kind.
    if (!pref.enabled) continue;

    // Apply custom severity thresholds if they differ from defaults.
    if (
      pref.severity_low_threshold !== 1.0 ||
      pref.severity_high_threshold !== 1.0
    ) {
      const adjusted = applyThresholds(anomaly, pref);
      out.push(adjusted);
    } else {
      out.push(anomaly);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// applyThresholds — adjust severity using user-defined threshold multipliers
// ---------------------------------------------------------------------------

/**
 * Return a copy of the anomaly with severity potentially recalculated using
 * the user's threshold multipliers. The ratio from context (if present) is
 * compared against the adjusted thresholds.
 *
 * Built-in boundaries (raw ratios, before user multipliers):
 *   cost_spike:        low < 2×, medium 2–3×, high ≥3×
 *   token_explosion:   low < 5×, medium 5–10×, high ≥10×
 *   tool_failure_rate: low < 35%, medium 35–50%, high ≥50%
 *   model_thrash:      low < 5 models, medium 5, high ≥6
 *   cache_miss_storm:  low < 90%, medium 90–95%, high ≥95%
 *   peer_divergence:   low < 3×, medium 3–5×, high ≥5×
 *
 * The user's multipliers scale these thresholds. A multiplier of 2.0 means
 * the user wants double the ratio before escalating to the next severity.
 */
function applyThresholds(
  anomaly: RealtimeAnomaly,
  pref: AnomalyPreference,
): RealtimeAnomaly {
  const ratio = typeof anomaly.context.ratio === "number" ? anomaly.context.ratio : null;
  const rate  = typeof anomaly.context.failure_rate === "number" ? anomaly.context.failure_rate :
                typeof anomaly.context.miss_rate === "number" ? anomaly.context.miss_rate : null;
  const models = typeof anomaly.context.distinct_models === "number" ? anomaly.context.distinct_models : null;

  let newSeverity: AnomalySeverity = anomaly.severity;

  switch (anomaly.kind) {
    case "cost_spike":
    case "peer_divergence":
    case "token_explosion": {
      if (ratio === null) break;
      // Built-in low/medium boundary and medium/high boundary (defaults without multiplier).
      const [lowBound, highBound] = kindBoundaries(anomaly.kind);
      const adjLow  = lowBound  * pref.severity_low_threshold;
      const adjHigh = highBound * pref.severity_high_threshold;
      newSeverity = ratio >= adjHigh - 1e-9 ? "high" : ratio >= adjLow - 1e-9 ? "medium" : "low";
      break;
    }
    case "tool_failure_rate": {
      if (rate === null) break;
      const adjLow  = 0.35 * pref.severity_low_threshold;
      const adjHigh = 0.50 * pref.severity_high_threshold;
      newSeverity = rate >= adjHigh ? "high" : rate >= adjLow ? "medium" : "low";
      break;
    }
    case "cache_miss_storm": {
      if (rate === null) break;
      const adjLow  = 0.90 * pref.severity_low_threshold;
      const adjHigh = 0.95 * pref.severity_high_threshold;
      newSeverity = rate >= adjHigh ? "high" : rate >= adjLow ? "medium" : "low";
      break;
    }
    case "model_thrash": {
      if (models === null) break;
      const adjLow  = 5 * pref.severity_low_threshold;
      const adjHigh = 6 * pref.severity_high_threshold;
      newSeverity = models >= adjHigh ? "high" : models >= adjLow ? "medium" : "low";
      break;
    }
  }

  if (newSeverity === anomaly.severity) return anomaly;
  return { ...anomaly, severity: newSeverity };
}

/** Return [low/medium boundary, medium/high boundary] for ratio-based anomaly kinds.
 *  Boundaries match the tolerance-adjusted thresholds in realtime-anomaly.ts. */
function kindBoundaries(kind: AnomalyKind): [number, number] {
  switch (kind) {
    case "cost_spike":      return [2, 3];
    case "token_explosion": return [5, 10];
    // peer_divergence uses 2.99/4.99 tolerance (not exact 3/5) to handle
    // floating-point rounding in integer-based ownerCosts.
    case "peer_divergence": return [2.99, 4.99];
    default:                return [2, 3];
  }
}
