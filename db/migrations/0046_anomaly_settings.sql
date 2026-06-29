-- 0046_anomaly_settings.sql
--
-- Org-level anomaly sensitivity settings for the calibration dashboard
-- (/settings/anomalies).
--
-- Each org gets one row (upserted by the settings API). The row stores:
--   anomaly_sensitivity_level  — 'conservative' | 'moderate' | 'aggressive'
--                                 Maps to z-score / ratio multipliers applied
--                                 on top of the built-in detector thresholds.
--   threshold_overrides        — JSONB with per-detector absolute overrides,
--                                 e.g. { cost_spike: 200, velocity_drop: 30 }
--                                 (millicents & percent respectively).
--   enabled_detector_types     — TEXT[] of detector kinds active for this org.
--                                 Empty array = all defaults enabled.
--
-- Rows are upserted by POST /api/settings/anomalies when the calibration
-- form is submitted. GET reads the stored row (or falls back to defaults).

CREATE TABLE IF NOT EXISTS org_anomaly_settings (
  org_id                   UUID        PRIMARY KEY REFERENCES org(id) ON DELETE CASCADE,
  anomaly_sensitivity_level TEXT        NOT NULL DEFAULT 'moderate'
                              CHECK (anomaly_sensitivity_level IN ('conservative', 'moderate', 'aggressive')),
  threshold_overrides      JSONB       NOT NULL DEFAULT '{}',
  enabled_detector_types   TEXT[]      NOT NULL DEFAULT '{}',
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE org_anomaly_settings IS
  'Per-org anomaly calibration settings: sensitivity level, threshold overrides, enabled detectors.';

COMMENT ON COLUMN org_anomaly_settings.anomaly_sensitivity_level IS
  'conservative = 2× thresholds (fewer alerts), moderate = 1× (default), aggressive = 0.5× (more alerts).';

COMMENT ON COLUMN org_anomaly_settings.threshold_overrides IS
  'Absolute per-detector threshold overrides. Keys: cost_spike (millicents), velocity_drop (percent 0-100). Empty = use defaults.';

COMMENT ON COLUMN org_anomaly_settings.enabled_detector_types IS
  'List of enabled AnomalyKind values. Empty array means all 6 defaults are enabled.';
