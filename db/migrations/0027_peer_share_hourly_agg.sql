-- 0027_peer_share_hourly_agg.sql
--
-- Adds peer_share_webhook_url to the org table so organisations can
-- receive a signed hourly POST whenever peers share new activity.
--
-- This column is consumed by /api/cron/peer-share-hourly-agg which:
--   1. Materialises past-hour peer_share_hourly_aggregate rows.
--   2. For each active grant whose cost_millicents > 0, POSTs a sanitised
--      JSON payload to peer_share_webhook_url (when set).
--
-- The payload obeys the same privacy floor as every other webhook in Pulse:
-- no prompts, completions, code, diffs, or raw OTel spans — only aggregate
-- counts, costs, token totals, and allowed field names from grant.fields.
--
-- Privacy controls:
--   • repo/model fields are omitted from the payload unless they appear in
--     grant.fields (the viewer-specific whitelist).
--   • The payload is signed with HMAC-SHA256(PULSE_CRON_SECRET, body) so
--     receiving servers can verify authenticity.
--   • A NULL peer_share_webhook_url disables delivery entirely.
--
-- Note: peer_share_hourly_aggregate table is in migration 0036.  This
-- migration only adds the delivery endpoint column to org.

ALTER TABLE org
  ADD COLUMN IF NOT EXISTS peer_share_webhook_url TEXT DEFAULT NULL;
