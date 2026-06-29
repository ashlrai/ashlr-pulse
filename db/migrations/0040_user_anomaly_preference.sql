-- 0040_user_anomaly_preference.sql
--
-- Per-user anomaly alert preferences for the realtime anomaly engine.
--
-- Each row stores a user's toggle state (enabled/disabled) for one anomaly
-- kind plus optional custom severity thresholds (as fractional multipliers
-- relative to the built-in detector thresholds).
--
-- Rows are upserted by the /api/settings/anomalies route whenever the user
-- saves changes. Absence of a row for a given (user_id, kind) pair means
-- "use the default" — the SSE broadcast layer treats it as enabled=true with
-- default thresholds.
--
-- Severity thresholds: floating-point multipliers (1.0 = default boundary).
--   severity_low_threshold   — multiplier for the low/medium boundary
--   severity_high_threshold  — multiplier for the medium/high boundary

CREATE TABLE IF NOT EXISTS user_anomaly_preference (
  user_id                UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind                   TEXT        NOT NULL CHECK (kind IN (
                           'cost_spike', 'token_explosion', 'tool_failure_rate',
                           'model_thrash', 'cache_miss_storm', 'peer_divergence'
                         )),
  enabled                BOOLEAN     NOT NULL DEFAULT TRUE,
  severity_low_threshold  FLOAT8      NOT NULL DEFAULT 1.0
                            CHECK (severity_low_threshold > 0 AND severity_low_threshold <= 10),
  severity_high_threshold FLOAT8      NOT NULL DEFAULT 1.0
                            CHECK (severity_high_threshold > 0 AND severity_high_threshold <= 10),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, kind)
);

COMMENT ON TABLE user_anomaly_preference IS
  'Per-user toggle + threshold preferences for the realtime anomaly alert engine.';

COMMENT ON COLUMN user_anomaly_preference.kind IS
  'Anomaly kind: cost_spike | token_explosion | tool_failure_rate | model_thrash | cache_miss_storm | peer_divergence';

COMMENT ON COLUMN user_anomaly_preference.enabled IS
  'When false the SSE broadcast layer skips this anomaly kind for this user.';

COMMENT ON COLUMN user_anomaly_preference.severity_low_threshold IS
  'Multiplier applied to the built-in low/medium severity boundary (default 1.0 = unchanged).';

COMMENT ON COLUMN user_anomaly_preference.severity_high_threshold IS
  'Multiplier applied to the built-in medium/high severity boundary (default 1.0 = unchanged).';

-- Fast lookup for SSE filter: user + kind.
CREATE INDEX IF NOT EXISTS user_anomaly_preference_user_idx
  ON user_anomaly_preference (user_id);
