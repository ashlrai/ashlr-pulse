/**
 * pat.ts — personal access token mint + verify.
 *
 * Format: `pulse_pat_<32 hex chars>`. The token is shown to the user
 * exactly once, at mint time. We persist only its SHA-256 hash, so a DB
 * read can never replay a token, and a leaked DB dump can't be turned
 * back into working credentials.
 *
 * PATs are ingest-only — no read scope. The OTLP route uses verifyPat()
 * to map a token to a user_id and write activity_event rows on that
 * user's behalf. Reads always go through the cookie-based session flow.
 */

import { sql } from "./db";

const PREFIX = "pulse_pat_";

export interface MintedPat {
  /** The plaintext token. Show once; we cannot reproduce it. */
  token: string;
  /** The DB row id of the PAT, for management UIs. */
  id: string;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return hex(digest);
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function mintPat(userId: string, name: string): Promise<MintedPat> {
  const token = randomToken();
  const hashed = await sha256(token);
  const db = sql();
  const [row] = await db<{ id: string }[]>`
    INSERT INTO personal_access_token (user_id, name, hashed_token)
    VALUES (${userId}, ${name}, ${hashed})
    RETURNING id
  `;
  return { token, id: row.id };
}

/**
 * Validate a bearer token. Returns the owning user_id on hit, null on miss.
 * Updates last_used_at on hit (best-effort — failure is silent).
 */
export async function verifyPat(token: string): Promise<string | null> {
  if (!token.startsWith(PREFIX)) return null;
  const hashed = await sha256(token);
  const db = sql();
  const [row] = await db<{ id: string; user_id: string }[]>`
    SELECT id, user_id::text AS user_id
    FROM personal_access_token
    WHERE hashed_token = ${hashed}
      AND revoked_at IS NULL
    LIMIT 1
  `;
  if (!row) return null;
  // Best-effort timestamp update; intentionally not awaited.
  void db`UPDATE personal_access_token SET last_used_at = NOW() WHERE id = ${row.id}`.catch(() => {});
  return row.user_id;
}
