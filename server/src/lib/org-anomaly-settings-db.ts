/**
 * org-anomaly-settings-db.ts — DB helpers for org_anomaly_settings.
 *
 * Provides get/upsert for the org-level anomaly calibration settings row
 * introduced by migration 0046_anomaly_settings.sql.
 *
 * Design
 * ──────
 *   • getOrgAnomalySettings() always returns a full AnomalySettings object,
 *     falling back to DEFAULT_ANOMALY_SETTINGS when no row exists yet.
 *   • upsertOrgAnomalySettings() is idempotent (INSERT … ON CONFLICT DO UPDATE).
 *   • Both are thin DB wrappers — no business logic beyond default-filling.
 *
 * Privacy: reads/writes only org_id + numeric/enum configuration columns.
 * No user-content, prompts, or PII is stored or returned.
 */

import { sql } from "./db";
import {
  DEFAULT_ANOMALY_SETTINGS,
  type AnomalySettings,
  type AnomalyKind,
  type AnomalySensitivityLevel,
  ANOMALY_KIND_VALUES,
} from "./realtime-anomaly";

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

interface OrgAnomalySettingsRow {
  anomaly_sensitivity_level: string;
  threshold_overrides:       Record<string, number> | null;
  enabled_detector_types:    string[] | null;
}

// ---------------------------------------------------------------------------
// getOrgAnomalySettings
// ---------------------------------------------------------------------------

/**
 * Load the org's anomaly calibration settings, filling in defaults for any
 * missing fields. Returns DEFAULT_ANOMALY_SETTINGS when no row exists.
 */
export async function getOrgAnomalySettings(orgId: string): Promise<AnomalySettings> {
  const db  = sql();
  const rows = await db<OrgAnomalySettingsRow[]>`
    SELECT anomaly_sensitivity_level, threshold_overrides, enabled_detector_types
    FROM org_anomaly_settings
    WHERE org_id = ${orgId}::uuid
  `;

  if (rows.length === 0) return { ...DEFAULT_ANOMALY_SETTINGS };

  const row = rows[0];

  const level = (["conservative", "moderate", "aggressive"] as const).includes(
    row.anomaly_sensitivity_level as AnomalySensitivityLevel,
  )
    ? (row.anomaly_sensitivity_level as AnomalySensitivityLevel)
    : "moderate";

  const overrides: AnomalySettings["threshold_overrides"] = {};
  if (row.threshold_overrides) {
    if (typeof row.threshold_overrides.cost_spike   === "number") overrides.cost_spike   = row.threshold_overrides.cost_spike;
    if (typeof row.threshold_overrides.velocity_drop === "number") overrides.velocity_drop = row.threshold_overrides.velocity_drop;
  }

  const enabled: AnomalyKind[] = (row.enabled_detector_types ?? []).filter(
    (k): k is AnomalyKind => ANOMALY_KIND_VALUES.includes(k as AnomalyKind),
  );

  return {
    sensitivity_level:      level,
    threshold_overrides:    overrides,
    enabled_detector_types: enabled,
  };
}

// ---------------------------------------------------------------------------
// upsertOrgAnomalySettings
// ---------------------------------------------------------------------------

/**
 * Upsert the org's anomaly calibration settings row. Safe to call repeatedly
 * — last write wins.
 */
export async function upsertOrgAnomalySettings(
  orgId: string,
  settings: AnomalySettings,
): Promise<void> {
  const db = sql();
  const overridesJson = JSON.stringify(settings.threshold_overrides);

  await db`
    INSERT INTO org_anomaly_settings
      (org_id, anomaly_sensitivity_level, threshold_overrides, enabled_detector_types, updated_at)
    VALUES (
      ${orgId}::uuid,
      ${settings.sensitivity_level},
      ${overridesJson}::jsonb,
      ${settings.enabled_detector_types},
      NOW()
    )
    ON CONFLICT (org_id) DO UPDATE SET
      anomaly_sensitivity_level = EXCLUDED.anomaly_sensitivity_level,
      threshold_overrides       = EXCLUDED.threshold_overrides,
      enabled_detector_types    = EXCLUDED.enabled_detector_types,
      updated_at                = NOW()
  `;
}
