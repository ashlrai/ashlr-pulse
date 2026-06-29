-- 0048_anomaly_incident.sql
--
-- Anomaly incident grouping table.
--
-- Rather than surfacing every individual anomaly_event as a separate alert,
-- the incident layer groups related anomalies (same kind, same org, overlapping
-- repo/owner scope, within a 2-hour window) into a single incident row.
--
-- Lifecycle
-- ─────────
--   open      — first_detected_at set, closed_at IS NULL
--   updated   — last_seen_at bumped on each matching anomaly, severity
--               re-computed as MAX(existing, incoming)
--   closed    — closed_at set by the auto-close cron (last_seen_at >4h ago)
--               or by user action; closed incidents are retained for audit
--
-- context JSONB schema (no user content — numeric/enum metadata only)
-- ───────────────────────────────────────────────────────────────────
--   {
--     "repo_names": ["repo-a", "repo-b"],   -- distinct repos seen in incident
--     "models":     ["claude-opus-4"],      -- distinct models seen
--     "owners":     ["alice", "bob"],       -- fleet_owner values (handles only)
--     "span_ids":   ["<uuid>", ...]         -- anomaly_event ids contributing
--   }
--
-- Privacy: no prompt text, no completion text, no user-content fields.
-- repo_names and owners mirror what is already visible in the Alerts tab.

CREATE TABLE IF NOT EXISTS anomaly_incident (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  first_detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at             TIMESTAMPTZ,
  kind                  TEXT        NOT NULL CHECK (kind IN (
                          'cost_spike', 'token_explosion', 'tool_failure_rate',
                          'model_thrash', 'cache_miss_storm', 'peer_divergence'
                        )),
  severity              TEXT        NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  -- Running cost impact tally across all contributing anomaly events (millicents).
  -- May be 0 when the kind is not cost-bearing (e.g. tool_failure_rate).
  cost_impact_millicents BIGINT     NOT NULL DEFAULT 0,
  -- Number of anomaly events that contributed to this incident.
  event_count           INT         NOT NULL DEFAULT 1,
  -- Aggregated context — repo/owner/model scope + contributing span IDs.
  context               JSONB       NOT NULL DEFAULT '{
    "repo_names": [],
    "models":     [],
    "owners":     [],
    "span_ids":   []
  }'::jsonb
);

COMMENT ON TABLE anomaly_incident IS
  'Grouped anomaly incidents — multiple related anomaly_event rows coalesced by kind/scope/time-window.';

COMMENT ON COLUMN anomaly_incident.kind IS
  'Anomaly type matching anomaly_event.kind: cost_spike | token_explosion | tool_failure_rate | model_thrash | cache_miss_storm | peer_divergence';

COMMENT ON COLUMN anomaly_incident.severity IS
  'Max severity seen across all contributing anomaly events (low < medium < high).';

COMMENT ON COLUMN anomaly_incident.cost_impact_millicents IS
  'Sum of batch_cost_millicents from contributing cost_spike events, else 0.';

COMMENT ON COLUMN anomaly_incident.event_count IS
  'Count of anomaly_event rows grouped into this incident.';

COMMENT ON COLUMN anomaly_incident.context IS
  'Aggregated context: {repo_names, models, owners, span_ids}. No user content.';

COMMENT ON COLUMN anomaly_incident.closed_at IS
  'Null = open. Set by auto-close cron when last_seen_at >4h ago, or by user action.';

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary dashboard query: open incidents for an org, most-recent-first.
CREATE INDEX IF NOT EXISTS anomaly_incident_org_first_detected_idx
  ON anomaly_incident (org_id, first_detected_at DESC);

-- Retention / close-cron query: find open incidents with stale last_seen_at.
CREATE INDEX IF NOT EXISTS anomaly_incident_org_closed_idx
  ON anomaly_incident (org_id, closed_at)
  WHERE closed_at IS NULL;

-- Grouping lookup: open incidents by (org, kind) for the 2-hour merge window.
CREATE INDEX IF NOT EXISTS anomaly_incident_org_kind_open_idx
  ON anomaly_incident (org_id, kind, last_seen_at DESC)
  WHERE closed_at IS NULL;
