-- 0015_intent_notes.sql
--
-- One-line "what I'm intending to focus on this week" notes that the
-- /attention page diffs against actual effort. The pattern from
-- ROADMAP.md v0.3:
--
--   "where the team's effort is actually landing vs. where you said
--    it should — pair with a lightweight weekly 'intent' note"
--
-- Schema is deliberately minimal — one row per (user, week) — so the
-- write path on the dashboard quick-form is a tiny upsert and the read
-- path is a single index lookup.
--
-- week_start is the user's local Monday (00:00 in their digest_tz),
-- normalized to UTC for storage. Computing it server-side avoids
-- timezone arithmetic in the browser.
--
-- One note per (user, week). The attention page renders the latest
-- and lets the user overwrite. Body capped at 280 chars to keep this
-- a forcing-function "what's the most important thing" — not a journal.

CREATE TABLE IF NOT EXISTS intent_note (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  week_start   DATE NOT NULL,
  body         TEXT NOT NULL CHECK (char_length(body) <= 280),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, week_start)
);

CREATE INDEX IF NOT EXISTS intent_note_user_week_idx
  ON intent_note (user_id, week_start DESC);
