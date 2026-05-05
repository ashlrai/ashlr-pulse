-- 0016_dashboard_views.sql
--
-- Saved dashboard views: a per-user named bookmark of (window, repos[],
-- models[], sources[], project_id) filters that pin to the top of /app.
-- Removes the "I have to retype my filters every time I visit" papercut
-- that's the #1 complaint when teams onboard onto Pulse.
--
-- The default view "All" is implicit (renders when no view is selected)
-- so the table only stores user-customized views.
--
-- filter_json schema (validated server-side before insert; see
-- server/src/lib/dashboard-view-db.ts):
--   {
--     win:      "7" | "14" | "30" | "90",
--     repos:    string[],     // exact match against activity_event.repo_name
--     models:   string[],     // exact match against activity_event.model
--     sources:  string[],     // enum subset
--     project:  string | null // project.id (uuid) when filtering by project
--   }
--
-- created_at lets us order the user's views chronologically by default.
-- last_used_at would let us promote-by-recency, but we keep the schema
-- minimal until that's a real ask.

CREATE TABLE IF NOT EXISTS dashboard_view (
  id           UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      UUID         NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  name         TEXT         NOT NULL,
  filter_json  JSONB        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Per-user uniqueness on name so the tab strip doesn't render
  -- duplicates. Matches case-insensitively to be friendly.
  UNIQUE (user_id, name)
);

-- Render order: oldest views appear leftmost (the user's "primary"
-- views accumulate by use; new ones land on the right).
CREATE INDEX IF NOT EXISTS idx_dashboard_view_user_created
  ON dashboard_view (user_id, created_at);
