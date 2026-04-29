-- 0017_ai_cache.sql
--
-- Generic LLM-output cache. The dashboard, digest, and weekly recap
-- all generate AI prose; this table memoizes results so we don't bill
-- the model on every request.
--
-- Why a new table instead of widening dashboard_briefing? The existing
-- table uses generated_at-only freshness — it's fine for one briefing
-- per user but doesn't support multiple keyed entries (standup per
-- day, anomaly per metric, recap per week, etc.).
--
-- Cache keys are namespaced by feature: "standup:2026-04-29",
-- "anomaly:tokens:2026-04-29T15:00", "recap:2026-04-27".
-- Pruned via a simple TTL DELETE in app code; no Postgres TTL needed.

CREATE TABLE IF NOT EXISTS ai_cache (
  user_id      UUID         NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  cache_key    TEXT         NOT NULL,
  body         JSONB        NOT NULL,
  source       TEXT         NOT NULL CHECK (source IN ('llm', 'template')),
  generated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  PRIMARY KEY (user_id, cache_key)
);

CREATE INDEX IF NOT EXISTS ai_cache_recent_idx
  ON ai_cache (user_id, generated_at DESC);
