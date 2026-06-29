/**
 * cursor-auth.ts — store and retrieve the Cursor admin API token for an org.
 *
 * The token is encrypted at rest using AES-256-GCM (lib/token-crypto.ts).
 * Format on disk (org.cursor_admin_token): [ 12-byte IV ][ 16-byte tag ][ ciphertext ].
 *
 * Privacy floor: only the opaque admin token is stored. We never store Cursor
 * IDE code context, editor selections, or keystroke data.
 *
 * Callers:
 *   - cursor-ingest.ts:   getCursorToken() → decrypted token string.
 *   - settings routes:    setCursorToken() / clearCursorToken() for org admin UI.
 */

import { sql } from "./db";
import { encryptToken, decryptToken } from "./token-crypto";

export interface CursorOrgConfig {
  org_id: string;
  cursor_org_id: string;
  /** Decrypted admin token — never log or return to the client. */
  admin_token: string;
}

/**
 * Fetch decrypted Cursor admin token for an org.
 * Returns null when the org has not configured Cursor integration.
 */
export async function getCursorToken(orgId: string): Promise<CursorOrgConfig | null> {
  const db = sql();
  const [row] = await db<{ cursor_org_id: string | null; cursor_admin_token: Buffer | null }[]>`
    SELECT cursor_org_id, cursor_admin_token
    FROM org
    WHERE id = ${orgId}::uuid
  `;
  if (!row?.cursor_org_id || !row.cursor_admin_token) return null;

  const admin_token = decryptToken(row.cursor_admin_token);
  return { org_id: orgId, cursor_org_id: row.cursor_org_id, admin_token };
}

/**
 * Persist an encrypted Cursor admin token + org ID for an org.
 * Only org owners/admins should call this (authorization is the caller's responsibility).
 */
export async function setCursorToken(
  orgId: string,
  cursorOrgId: string,
  plainToken: string,
): Promise<void> {
  const encrypted = encryptToken(plainToken);
  // postgres-js sends Buffer as bytea automatically.
  const db = sql();
  await db`
    UPDATE org
    SET cursor_admin_token = ${encrypted},
        cursor_org_id      = ${cursorOrgId}
    WHERE id = ${orgId}::uuid
  `;
}

/**
 * Remove Cursor integration for an org (sets both columns to NULL).
 */
export async function clearCursorToken(orgId: string): Promise<void> {
  const db = sql();
  await db`
    UPDATE org
    SET cursor_admin_token = NULL,
        cursor_org_id      = NULL
    WHERE id = ${orgId}::uuid
  `;
}

/**
 * List every org that has cursor_admin_token configured.
 * Used by the cron scheduler to iterate orgs without loading sensitive data.
 */
export async function listOrgsWithCursorToken(): Promise<Array<{ id: string; name: string }>> {
  const db = sql();
  return db<{ id: string; name: string }[]>`
    SELECT id::text AS id, name
    FROM org
    WHERE cursor_admin_token IS NOT NULL
      AND cursor_org_id IS NOT NULL
  `;
}
