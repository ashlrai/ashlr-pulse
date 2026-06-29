-- 0042_cursor_admin_token.sql
--
-- Add cursor_admin_token (encrypted bytea) and cursor_org_id (TEXT) to the
-- org table so the Cursor ingest scheduler can fetch usage on behalf of an
-- organisation without storing the plaintext admin token.
--
-- Encryption: AES-256-GCM via server/src/lib/token-crypto.ts.
-- Format on disk: [ 12 bytes IV ][ 16 bytes auth tag ][ N bytes ciphertext ]
--
-- cursor_org_id is the Cursor organisation ID used in the API path:
--   GET https://api.cursor.sh/api/v1/organizations/{cursor_org_id}/usage
--
-- Privacy: only the encrypted admin token is stored. Cursor IDE code context,
-- editor selections, and keystroke data are NEVER fetched or stored.

ALTER TABLE org
  ADD COLUMN IF NOT EXISTS cursor_admin_token BYTEA,
  ADD COLUMN IF NOT EXISTS cursor_org_id      TEXT;

COMMENT ON COLUMN org.cursor_admin_token IS
  'AES-256-GCM encrypted Cursor admin API token. NULL = not configured.';
COMMENT ON COLUMN org.cursor_org_id IS
  'Cursor organisation ID for the usage API path. NULL = not configured.';
