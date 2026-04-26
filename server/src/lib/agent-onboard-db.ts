/**
 * agent-onboard-db.ts — DB helpers for the browser-mediated PAT flow.
 *
 * Code alphabet: 26 chars chosen to be unambiguous on a phone screen
 * (no I/O/0/1; no ambiguous-pair characters). 8 chars give 26^8 ≈ 2e11
 * possibilities which is plenty for a 5-minute TTL with rate-limited
 * approval — and trivially mistypable enough that the user has to look
 * at a screen to enter, not guess.
 */

import { sql } from "./db";

const TTL_MS = 5 * 60 * 1000;
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 chars, no 0/1/I/O

export type CodeStatus = "pending" | "approved";

export interface CodeRow {
  code: string;
  expires_at: string;
  status: CodeStatus;
  user_id: string | null;
  agent_label: string | null;
  created_at: string;
}

export function generateCode(len = 8): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  // Bias is negligible at 32 / 256 = 1/8.
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

/**
 * Insert a fresh code with status='pending' and a 5-minute expiry.
 * Idempotent on the (vanishingly small) chance of a code collision —
 * caller's job to retry with a new code.
 */
export async function startCode(code: string, agentLabel: string | null): Promise<CodeRow> {
  const db = sql();
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  const [row] = await db<CodeRow[]>`
    INSERT INTO agent_onboard_code (code, expires_at, agent_label)
    VALUES (${code}, ${expiresAt}::timestamptz, ${agentLabel})
    RETURNING code, expires_at::text AS expires_at, status,
              user_id::text AS user_id, agent_label, created_at::text AS created_at
  `;
  return row;
}

export async function getCode(code: string): Promise<CodeRow | null> {
  const db = sql();
  const [row] = await db<CodeRow[]>`
    SELECT code, expires_at::text AS expires_at, status,
           user_id::text AS user_id, agent_label, created_at::text AS created_at
    FROM agent_onboard_code
    WHERE code = ${code}
  `;
  return row ?? null;
}

/**
 * Mark a code approved by `userId`. Returns false if the code is
 * missing, expired, or already approved (intentionally conflated to
 * avoid leaking which).
 */
export async function approveCode(code: string, userId: string): Promise<boolean> {
  const db = sql();
  const result = await db`
    UPDATE agent_onboard_code
    SET status = 'approved',
        user_id = ${userId}::uuid
    WHERE code = ${code}
      AND status = 'pending'
      AND expires_at > NOW()
  `;
  return result.count === 1;
}

/**
 * Atomic consume: find an approved code, return its user_id +
 * agent_label, and DELETE the row in the same statement. Returns null
 * if no such code exists (still pending, expired, or already consumed).
 *
 * Returning agent_label here (instead of trusting the caller's earlier
 * SELECT) means the PAT we mint is named from the same atomic snapshot
 * as the user_id — no chance of a torn read between the two.
 */
export async function consumeApprovedCode(
  code: string,
): Promise<{ user_id: string; agent_label: string | null } | null> {
  const db = sql();
  const [row] = await db<{ user_id: string; agent_label: string | null }[]>`
    DELETE FROM agent_onboard_code
    WHERE code = ${code}
      AND status = 'approved'
      AND expires_at > NOW()
    RETURNING user_id::text AS user_id, agent_label
  `;
  return row ?? null;
}

/** Drop expired pending codes. Cheap; fine to call from any cron tick. */
export async function pruneExpired(): Promise<number> {
  const db = sql();
  const result = await db`
    DELETE FROM agent_onboard_code
    WHERE expires_at < NOW()
  `;
  return result.count ?? 0;
}
