/**
 * pat.ts — personal access token mint + verify.
 *
 * Format: `pulse_pat_<32 hex chars>`. The token is shown to the user
 * exactly once, at mint time. We persist only its SHA-256 hash, so a DB
 * read can never replay a token, and a leaked DB dump can't be turned
 * back into working credentials.
 *
 * PAT scopes are intentionally narrow. Default agent tokens can ingest
 * spans and heartbeat only; invite creation requires an explicit scope.
 * Reads always go through the cookie-based session flow.
 */

import { sql } from "./db";

const PREFIX = "pulse_pat_";
export const PAT_SCOPES = ["ingest", "heartbeat", "invite:create"] as const;
export type PatScope = (typeof PAT_SCOPES)[number];
const DEFAULT_AGENT_SCOPES: PatScope[] = ["ingest", "heartbeat"];

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

export function normalizePatScopes(scopes: readonly string[] | undefined): PatScope[] {
  if (!scopes || scopes.length === 0) return [...DEFAULT_AGENT_SCOPES];
  const out: PatScope[] = [];
  for (const scope of scopes) {
    if (!PAT_SCOPES.includes(scope as PatScope)) {
      throw new Error(`unknown PAT scope: ${scope}`);
    }
    if (!out.includes(scope as PatScope)) out.push(scope as PatScope);
  }
  return out;
}

export async function mintPat(
  userId: string,
  name: string,
  scopes: readonly string[] = DEFAULT_AGENT_SCOPES,
): Promise<MintedPat> {
  const token = randomToken();
  const hashed = await sha256(token);
  const normalizedScopes = normalizePatScopes(scopes);
  const db = sql();
  const [row] = await db<{ id: string }[]>`
    INSERT INTO personal_access_token (user_id, name, hashed_token, scopes)
    VALUES (${userId}, ${name}, ${hashed}, ${normalizedScopes})
    RETURNING id
  `;
  return { token, id: row.id };
}

export interface PatRow {
  id: string;
  name: string;
  scopes: PatScope[];
  last_used_at: string | null;
  created_at: string;
}

/** List all active (non-revoked) PATs for a user. Never returns hashed_token. */
export async function listPats(userId: string): Promise<PatRow[]> {
  const db = sql();
  return db<PatRow[]>`
    SELECT id::text AS id, name,
           COALESCE(scopes, ARRAY['ingest','heartbeat']::text[]) AS scopes,
           last_used_at, created_at
    FROM personal_access_token
    WHERE user_id = ${userId}
      AND revoked_at IS NULL
    ORDER BY created_at DESC
  `;
}

/**
 * Soft-revoke a PAT. Returns true if the row was revoked, false if it
 * didn't exist or wasn't owned by the caller (intentionally conflated).
 */
export async function revokePat(id: string, userId: string): Promise<boolean> {
  const db = sql();
  const result = await db`
    UPDATE personal_access_token
    SET revoked_at = NOW()
    WHERE id = ${id}
      AND user_id = ${userId}
      AND revoked_at IS NULL
  `;
  return result.count === 1;
}

/**
 * Validate a bearer token. Returns the owning user_id on hit, null on miss.
 * Updates last_used_at on hit (best-effort — failure is silent).
 */
export async function verifyPat(
  token: string,
  requiredScope?: PatScope,
): Promise<string | null> {
  if (!token.startsWith(PREFIX)) return null;
  const hashed = await sha256(token);
  const db = sql();
  const [row] = await db<{ id: string; user_id: string; scopes: PatScope[] }[]>`
    SELECT id, user_id::text AS user_id,
           COALESCE(scopes, ARRAY['ingest','heartbeat']::text[]) AS scopes
    FROM personal_access_token
    WHERE hashed_token = ${hashed}
      AND revoked_at IS NULL
    LIMIT 1
  `;
  if (!row) return null;
  if (requiredScope && !row.scopes.includes(requiredScope)) return null;
  // Best-effort timestamp update; intentionally not awaited.
  void db`UPDATE personal_access_token SET last_used_at = NOW() WHERE id = ${row.id}`.catch(() => {});
  return row.user_id;
}
