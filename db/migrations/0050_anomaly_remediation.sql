-- 0050_anomaly_remediation.sql
--
-- Adds the anomaly_remediation table to track suggested remediation actions
-- for anomaly incidents, and extends anomaly_incident with root-cause signal
-- and description fields for the incident grouper.
--
-- New columns on anomaly_incident:
--   description        — auto-generated human-readable narrative for the incident
--   root_cause_signal  — machine-readable root-cause enum
--   severity_score     — 0-100 composite score from member anomaly severities
--   status             — open | dismissed | resolved (richer than closed_at)
--
-- New table anomaly_remediation:
--   Tracks suggested remediation actions surfaced to ops teams.
--   remediation_kind: reduce_token_window | switch_model | increase_budget |
--                     review_cache_config | investigate_failures | investigate_peer
--   status: suggested | in_progress | applied | dismissed
--
-- Privacy: no prompt text, no completion text, no user-content fields.

-- ── anomaly_incident new columns ──────────────────────────────────────────────

ALTER TABLE anomaly_incident
  ADD COLUMN IF NOT EXISTS description       TEXT,
  ADD COLUMN IF NOT EXISTS root_cause_signal TEXT
    CHECK (root_cause_signal IS NULL OR root_cause_signal IN (
      'new_model_thrashing',
      'cost_spike_with_high_rejection_rate',
      'cache_miss_storm',
      'token_explosion_single_repo',
      'peer_cost_divergence',
      'tool_failure_cascade',
      'generic_cost_spike'
    )),
  ADD COLUMN IF NOT EXISTS severity_score    SMALLINT NOT NULL DEFAULT 0
    CHECK (severity_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'dismissed', 'resolved'));

COMMENT ON COLUMN anomaly_incident.description IS
  'Auto-generated human-readable narrative describing the incident cluster.';

COMMENT ON COLUMN anomaly_incident.root_cause_signal IS
  'Machine-readable root-cause classification for fast ops triage.';

COMMENT ON COLUMN anomaly_incident.severity_score IS
  '0-100 composite severity: high=100 base, medium=50, low=20, scaled by event_count.';

COMMENT ON COLUMN anomaly_incident.status IS
  'Lifecycle: open (active) | dismissed (suppressed by ops) | resolved (remediation applied).';

-- ── anomaly_remediation table ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS anomaly_remediation (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id       UUID        NOT NULL REFERENCES anomaly_incident(id) ON DELETE CASCADE,
  remediation_kind  TEXT        NOT NULL CHECK (remediation_kind IN (
                      'reduce_token_window',
                      'switch_model',
                      'increase_budget',
                      'review_cache_config',
                      'investigate_failures',
                      'investigate_peer'
                    )),
  status            TEXT        NOT NULL DEFAULT 'suggested'
                      CHECK (status IN ('suggested', 'in_progress', 'applied', 'dismissed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE anomaly_remediation IS
  'Suggested remediation actions for anomaly incidents. One row per suggestion per incident.';

COMMENT ON COLUMN anomaly_remediation.remediation_kind IS
  'Type of remediation: reduce_token_window | switch_model | increase_budget | review_cache_config | investigate_failures | investigate_peer';

COMMENT ON COLUMN anomaly_remediation.status IS
  'Action lifecycle: suggested → in_progress → applied | dismissed';

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Look up all remediations for an incident (dashboard expand).
CREATE INDEX IF NOT EXISTS anomaly_remediation_incident_id_idx
  ON anomaly_remediation (incident_id, created_at DESC);

-- Status filter: find all open/suggested remediations.
CREATE INDEX IF NOT EXISTS anomaly_remediation_status_idx
  ON anomaly_remediation (status, created_at DESC)
  WHERE status IN ('suggested', 'in_progress');

-- Index for incident status queries (open incidents needing attention).
CREATE INDEX IF NOT EXISTS anomaly_incident_status_idx
  ON anomaly_incident (org_id, status, first_detected_at DESC)
  WHERE status = 'open';
