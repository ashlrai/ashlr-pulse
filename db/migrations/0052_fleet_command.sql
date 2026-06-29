-- 0052_fleet_command.sql
--
-- The fleet control-plane queue (the missing keystone for the Map / Radar /
-- proposal-inbox surfaces). The cloud (Pulse) ENQUEUES intent here; the local
-- ashlr-hub daemon POLLS for pending rows, CLAIMS the oldest atomically,
-- executes the work locally, and reports the outcome (done / failed).
--
-- The cloud is strictly pull-only / no-inbound — this table is the entire
-- bridge. Everything is ORG-SCOPED: a daemon authenticated for org A can never
-- see or mutate org B's commands.
--
-- PRIVACY FLOOR: `payload` and `result` are STRUCTURED METADATA ONLY — ids,
-- repo full_names, the goal text a human typed, an opened-PR url. They are run
-- through assertMetadataOnly() (peer-share-guard) before insert and
-- sanitizeDetail() (fleet-audit) on egress, so a buggy caller can never smuggle
-- code / prompts / diffs into a cloud-stored field.
--
-- Referenced by: src/lib/fleet-commands-db.ts, src/lib/fleet-inbox-db.ts,
-- src/lib/fleet-audit-export.ts, src/lib/fleet-proposal-detail.ts.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS fleet_command (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE,

  -- Closed allow-list enforced in app code (FLEET_COMMAND_KINDS / graph-types).
  -- Stored as TEXT (not an enum) so adding a kind is a code-only change.
  kind          TEXT NOT NULL,

  -- Target repo full_name ("owner/repo") or NULL for org-wide commands.
  target        TEXT,

  -- Metadata-only instruction bag. NEVER code/diffs/prompts (see privacy floor).
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Lifecycle: pending → claimed → (done | failed). CHECK keeps junk out even
  -- if a caller bypasses the app layer.
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'claimed', 'done', 'failed')),

  -- local user.id of the enqueuer (NULL for system-generated commands).
  created_by    UUID REFERENCES "user"(id) ON DELETE SET NULL,

  -- Opaque daemon/agent identifier that claimed the row (NULL until claimed).
  claimed_by    TEXT,

  -- Metadata-only outcome bag, present once terminal (NULL otherwise).
  result        JSONB,

  -- Short failure reason when status = 'failed' (NULL otherwise).
  error         TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);

-- Daemon poll hot path: oldest pending row for an org. Partial index so it
-- stays tiny (only un-drained rows) and the queue scales with backlog, not
-- with total history.
CREATE INDEX IF NOT EXISTS fleet_command_poll_idx
  ON fleet_command (org_id, created_at)
  WHERE status = 'pending';

-- Inbox / audit reads: status counts + newest-first listing per org.
CREATE INDEX IF NOT EXISTS fleet_command_org_created_idx
  ON fleet_command (org_id, created_at DESC);

-- Proposal drill-down: approve_proposal / reject_proposal lookups per org.
CREATE INDEX IF NOT EXISTS fleet_command_org_kind_idx
  ON fleet_command (org_id, kind, created_at DESC);
