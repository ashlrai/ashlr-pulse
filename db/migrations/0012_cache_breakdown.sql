-- 0012_cache_breakdown.sql
--
-- Anthropic's prompt cache pricing splits by ephemeral lifetime:
--   - 5-minute cache write: 1.25× input rate
--   - 1-hour cache write:    2.00× input rate
--   - read:                  0.10× input rate
-- Claude Code emits both as separate fields in the JSONL:
--   message.usage.cache_creation.ephemeral_5m_input_tokens
--   message.usage.cache_creation.ephemeral_1h_input_tokens
-- Pre-2026-04 the agent was flattening these into the single
-- cache_creation_input_tokens field and the server stored just
-- tokens_cache_write — which we then priced at the 5m rate, undercount
-- for any session using 1h cache (cmux + long-running sessions
-- DOMINANTLY use 1h cache).
--
-- This migration adds the split columns going forward AND backfills
-- existing rows from raw_otel_span where the original payload is still
-- present.

ALTER TABLE activity_event
  ADD COLUMN IF NOT EXISTS tokens_cache_5m_write INT,
  ADD COLUMN IF NOT EXISTS tokens_cache_1h_write INT;

-- No backfill: pre-2026-04 rows captured cache_creation_input_tokens as
-- a flat sum (now stored in tokens_cache_write) without the 5m vs 1h
-- breakdown. The pricing code falls back to billing the flat field at
-- the 1h rate (lib/pricing.ts) — a conservative approximation since
-- cmux + long-running Claude Code sessions overwhelmingly use 1h
-- caching by default. New rows populate the split columns directly
-- via the OTel mapping in lib/otel-genai.ts.
