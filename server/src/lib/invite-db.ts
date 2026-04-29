/**
 * invite-db.ts — DB access for the cofounder / teammate invite flow.
 *
 * Token alphabet: 32-char Crockford-ish (no 0/1/I/O), same as
 * agent_onboard_code. 16 chars = 32^16 ≈ 1.2e24 possibilities — treated
 * as a one-shot bearer capability.
 */

import { sql } from "./db";

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export type ScopeType = "all" | "project" | "repo_pattern";
export type Granularity = "realtime" | "daily" | "weekly" | "monthly";

export interface InviteRow {
  token: string;
  owner_id: string;
  owner_email: string;
  expires_at: string;
  suggested_scope_type: ScopeType | null;
  suggested_scope_value: string | null;
  suggested_granularity: Granularity | null;
  suggested_fields: string[] | null;
  label: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  created_at: string;
}

export function generateToken(len = 16): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

export interface CreateInviteInput {
  owner_id: string;
  label?: string | null;
  suggested_scope_type?: ScopeType | null;
  suggested_scope_value?: string | null;
  suggested_granularity?: Granularity | null;
  suggested_fields?: string[] | null;
}

export async function createInvite(input: CreateInviteInput): Promise<InviteRow> {
  const db = sql();
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  // Generate-and-retry on the (vanishingly unlikely) collision case.
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateToken();
    try {
      const [row] = await db<InviteRow[]>`
        INSERT INTO invite (
          token, owner_id, expires_at,
          suggested_scope_type, suggested_scope_value,
          suggested_granularity, suggested_fields, label
        )
        VALUES (
          ${token}, ${input.owner_id}::uuid, ${expiresAt}::timestamptz,
          ${input.suggested_scope_type ?? null},
          ${input.suggested_scope_value ?? null},
          ${input.suggested_granularity ?? null},
          ${input.suggested_fields ?? null},
          ${input.label ?? null}
        )
        RETURNING token, owner_id::text AS owner_id,
          (SELECT email FROM "user" WHERE id = invite.owner_id) AS owner_email,
          expires_at::text AS expires_at,
          suggested_scope_type, suggested_scope_value,
          suggested_granularity, suggested_fields, label,
          accepted_by::text AS accepted_by,
          accepted_at::text AS accepted_at,
          created_at::text AS created_at
      `;
      return row;
    } catch (err) {
      // Token collision (PRIMARY KEY violation) → retry with new token.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("duplicate key")) throw err;
    }
  }
  throw new Error("could not allocate unique invite token after 5 attempts");
}

export async function getInviteByToken(token: string): Promise<InviteRow | null> {
  const db = sql();
  const [row] = await db<InviteRow[]>`
    SELECT
      i.token,
      i.owner_id::text AS owner_id,
      o.email          AS owner_email,
      i.expires_at::text AS expires_at,
      i.suggested_scope_type, i.suggested_scope_value,
      i.suggested_granularity, i.suggested_fields, i.label,
      i.accepted_by::text AS accepted_by,
      i.accepted_at::text AS accepted_at,
      i.created_at::text AS created_at
    FROM invite i
    JOIN "user" o ON o.id = i.owner_id
    WHERE i.token = ${token}
  `;
  return row ?? null;
}

/**
 * Mark an invite accepted by `acceptedById`. Returns false when the
 * token doesn't exist, has expired, or was already accepted.
 *
 * If the invite carries a complete suggested peer_share spec
 * (scope_type + granularity + fields all non-null), we also auto-create
 * a peer_share row so the inviter doesn't have to set it up manually.
 * Self-grants are forbidden — if owner_id == acceptedById we skip the
 * peer_share creation.
 */
export async function acceptInvite(
  token: string,
  acceptedById: string,
): Promise<{ ok: true; createdShare: boolean; ownerId: string } | { ok: false; reason: string }> {
  const db = sql();
  return db.begin(async (tx) => {
    const [invite] = await tx<{ owner_id: string; suggested_scope_type: ScopeType | null; suggested_scope_value: string | null; suggested_granularity: Granularity | null; suggested_fields: string[] | null }[]>`
      UPDATE invite
      SET accepted_by = ${acceptedById}::uuid, accepted_at = NOW()
      WHERE token = ${token}
        AND expires_at > NOW()
        AND accepted_at IS NULL
      RETURNING
        owner_id::text AS owner_id,
        suggested_scope_type,
        suggested_scope_value,
        suggested_granularity,
        suggested_fields
    `;
    if (!invite) return { ok: false as const, reason: "expired or already accepted" };

    let createdShare = false;
    const canShare =
      invite.owner_id !== acceptedById &&
      invite.suggested_scope_type &&
      invite.suggested_granularity &&
      invite.suggested_fields &&
      invite.suggested_fields.length > 0;
    if (canShare) {
      try {
        await tx`
          INSERT INTO peer_share (owner_id, viewer_id, scope_type, scope_value, granularity, fields)
          VALUES (
            ${invite.owner_id}::uuid,
            ${acceptedById}::uuid,
            ${invite.suggested_scope_type},
            ${invite.suggested_scope_value},
            ${invite.suggested_granularity},
            ${invite.suggested_fields}
          )
          ON CONFLICT DO NOTHING
        `;
        createdShare = true;
      } catch {
        // Best-effort: a UNIQUE conflict on (owner, viewer, scope) just
        // means a grant already existed — accept anyway.
        createdShare = false;
      }
    }
    return { ok: true as const, createdShare, ownerId: invite.owner_id };
  });
}

/** List all invites this user has created (for the /share UI). */
export async function listInvitesByOwner(ownerId: string): Promise<InviteRow[]> {
  const db = sql();
  return db<InviteRow[]>`
    SELECT
      i.token,
      i.owner_id::text AS owner_id,
      o.email          AS owner_email,
      i.expires_at::text AS expires_at,
      i.suggested_scope_type, i.suggested_scope_value,
      i.suggested_granularity, i.suggested_fields, i.label,
      i.accepted_by::text AS accepted_by,
      i.accepted_at::text AS accepted_at,
      i.created_at::text AS created_at
    FROM invite i
    JOIN "user" o ON o.id = i.owner_id
    WHERE i.owner_id = ${ownerId}::uuid
    ORDER BY i.created_at DESC
  `;
}

export async function pruneExpiredUnaccepted(): Promise<number> {
  const db = sql();
  const r = await db`DELETE FROM invite WHERE expires_at < NOW() AND accepted_at IS NULL`;
  return r.count ?? 0;
}

/**
 * Owner-initiated revocation of a pending invite. Refuses to delete an
 * already-accepted invite — those represent a real grant relationship
 * that should be revoked via the peer_share row instead. Returns the
 * number of rows deleted (0 if not found / not owned / already accepted).
 */
export async function deletePendingInvite(token: string, ownerId: string): Promise<number> {
  const db = sql();
  const r = await db`
    DELETE FROM invite
    WHERE token = ${token}
      AND owner_id = ${ownerId}::uuid
      AND accepted_at IS NULL
  `;
  return r.count ?? 0;
}
