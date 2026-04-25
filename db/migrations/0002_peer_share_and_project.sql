-- 0002_peer_share_and_project.sql
--
-- Scaffolds the v0.2 sharing/grouping schema while v0.1 (single-user
-- dashboard) is still the only thing the UI uses. Creating these tables
-- now means peer-share + portfolio features land without a schema rebuild.
--
-- Mirrors ARCHITECTURE.md:99-147.
--
-- Privacy floor: peer_share.fields is a TEXT[] whitelist of activity_event
-- columns the viewer is allowed to read. The hard floor (prompts /
-- completions / raw_otel_span never shareable) is enforced server-side in
-- lib/peer-share-guard.ts at every insert path; not a CHECK constraint
-- because TEXT[] containment checks are awkward at the DB layer and the
-- guard wants to return a useful 4xx error rather than a constraint
-- violation.

CREATE TABLE IF NOT EXISTS peer_share (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  viewer_id   UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  scope_type  TEXT NOT NULL CHECK (scope_type IN ('all','project','repo_pattern')),
  scope_value TEXT,
  granularity TEXT NOT NULL CHECK (granularity IN ('realtime','daily','weekly','monthly')),
  fields      TEXT[] NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ,

  CHECK (owner_id <> viewer_id),
  UNIQUE (owner_id, viewer_id, scope_type, scope_value)
);

CREATE INDEX IF NOT EXISTS peer_share_owner_active_idx
  ON peer_share (owner_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS peer_share_viewer_active_idx
  ON peer_share (viewer_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS project (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('saas','client','internal','experiment')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS project_repo (
  project_id UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  repo_name  TEXT NOT NULL,

  PRIMARY KEY (project_id, repo_name)
);

CREATE INDEX IF NOT EXISTS project_repo_repo_idx ON project_repo (repo_name);
