-- 0007_otlp_idempotency.sql
--
-- Prevent agent retries from double-counting tokens.
--
-- Background: the Rust agent debounces filesystem events at 5s intervals
-- and re-scans every JSONL file from its last byte offset. If a network
-- blip drops the OTLP response *after* the server's INSERT committed,
-- the next scan re-emits the same span and we'd insert it twice.
--
-- Fix: every OTLP span carries a 16-byte spanId in raw_otel_span. We
-- pull it out into a typed column and add a partial unique index on
-- (user_id, span_id). The ingest route now does ON CONFLICT DO NOTHING.
--
-- Backfill: existing rows get span_id from raw_otel_span->>'spanId'.
-- Rows with no spanId (older shape) get NULL and are not deduplicated —
-- they're already in the DB once, retries from now on are protected.

ALTER TABLE activity_event
  ADD COLUMN IF NOT EXISTS span_id TEXT;

UPDATE activity_event
   SET span_id = raw_otel_span->>'spanId'
 WHERE span_id IS NULL
   AND raw_otel_span IS NOT NULL
   AND raw_otel_span->>'spanId' IS NOT NULL;

-- Dedupe historical rows BEFORE creating the unique index. Prior to this
-- migration, the agent's retry logic could double-insert spans when an
-- HTTP response was lost mid-flight. Keep the earliest insertion (lowest
-- ts) per (user_id, span_id); drop the rest.
DELETE FROM activity_event ae
USING (
  SELECT id
  FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY user_id, span_id
        ORDER BY ts ASC, id ASC
      ) AS rn
    FROM activity_event
    WHERE span_id IS NOT NULL
  ) ranked
  WHERE rn > 1
) dupes
WHERE ae.id = dupes.id;

-- Partial unique index: NULL span_ids are allowed (legacy rows that had
-- no spanId in raw_otel_span + the shell-hook tailer's spans both fit
-- cleanly under the partial predicate).
CREATE UNIQUE INDEX IF NOT EXISTS activity_event_user_span_uniq
  ON activity_event (user_id, span_id)
  WHERE span_id IS NOT NULL;
