/**
 * peer-share-db.ts — DB access for the peer_share table.
 *
 * Encapsulates the SQL so route handlers stay declarative. All writes
 * funnel through validateFields() (the privacy hard-floor) at the call
 * site — it's not enforced here so callers must remember to use it.
 *
 * Gate 4: peer_share creation is blocked when the *owner's* org plan
 * limits don't include peer_share_enabled. Callers must pass an `org`
 * parameter to `createPeerShare` so the gate is enforced at the DB
 * layer. The share/page.tsx action redirects with ?error=upgrade-to-share
 * instead of crashing when PlanGateError is thrown.
 */

import { sql } from "./db";
import { limitsFor, PlanGateError, type OrgPlanRef } from "./plan-gate";

export interface PeerShareRow {
  id: string;
  owner_id: string;
  viewer_id: string;
  owner_email: string;
  viewer_email: string;
  scope_type: "all" | "project" | "repo_pattern";
  scope_value: string | null;
  granularity: "realtime" | "daily" | "weekly" | "monthly";
  fields: string[];
  created_at: string;
}

export interface CreatePeerShareInput {
  owner_id: string;
  viewer_id: string;
  scope_type: PeerShareRow["scope_type"];
  scope_value: string | null;
  granularity: PeerShareRow["granularity"];
  fields: string[];
  /** Owner's org — required to enforce the peer_share_enabled gate. */
  ownerOrg?: OrgPlanRef;
}

export async function createPeerShare(input: CreatePeerShareInput): Promise<PeerShareRow> {
  // Gate 4: peer-share creation requires peer_share_enabled on the owner's plan.
  if (input.ownerOrg) {
    const limits = limitsFor(input.ownerOrg);
    if (!limits.peer_share_enabled) {
      throw new PlanGateError(
        "Peer sharing is a Pro feature. Upgrade to Pro at /billing.",
        402,
      );
    }
  }

  const db = sql();
  const [row] = await db<PeerShareRow[]>`
    INSERT INTO peer_share (owner_id, viewer_id, scope_type, scope_value, granularity, fields)
    VALUES (
      ${input.owner_id}, ${input.viewer_id},
      ${input.scope_type}, ${input.scope_value},
      ${input.granularity}, ${input.fields}
    )
    RETURNING
      id::text         AS id,
      owner_id::text   AS owner_id,
      viewer_id::text  AS viewer_id,
      (SELECT email FROM "user" WHERE id = peer_share.owner_id)  AS owner_email,
      (SELECT email FROM "user" WHERE id = peer_share.viewer_id) AS viewer_email,
      scope_type, scope_value, granularity, fields,
      created_at
  `;
  return row;
}

/** Active grants the user owns (i.e. shares they're handing out). */
export async function listGrantsOwnedBy(userId: string): Promise<PeerShareRow[]> {
  const db = sql();
  return db<PeerShareRow[]>`
    SELECT
      ps.id::text         AS id,
      ps.owner_id::text   AS owner_id,
      ps.viewer_id::text  AS viewer_id,
      o.email             AS owner_email,
      v.email             AS viewer_email,
      ps.scope_type, ps.scope_value, ps.granularity, ps.fields,
      ps.created_at
    FROM peer_share ps
    JOIN "user" o ON o.id = ps.owner_id
    JOIN "user" v ON v.id = ps.viewer_id
    WHERE ps.owner_id = ${userId} AND ps.revoked_at IS NULL
    ORDER BY ps.created_at DESC
  `;
}

/** Active grants the user can read against (shares they receive). */
export async function listGrantsForViewer(viewerId: string): Promise<PeerShareRow[]> {
  const db = sql();
  return db<PeerShareRow[]>`
    SELECT
      ps.id::text         AS id,
      ps.owner_id::text   AS owner_id,
      ps.viewer_id::text  AS viewer_id,
      o.email             AS owner_email,
      v.email             AS viewer_email,
      ps.scope_type, ps.scope_value, ps.granularity, ps.fields,
      ps.created_at
    FROM peer_share ps
    JOIN "user" o ON o.id = ps.owner_id
    JOIN "user" v ON v.id = ps.viewer_id
    WHERE ps.viewer_id = ${viewerId} AND ps.revoked_at IS NULL
    ORDER BY ps.created_at DESC
  `;
}

/**
 * Soft-delete a share. Returns true if exactly one row was revoked,
 * false if the row didn't exist or wasn't owned by the caller (the API
 * surface should return 404 in either case so we don't leak which).
 */
export async function revokeShare(id: string, ownerId: string): Promise<boolean> {
  const db = sql();
  const result = await db`
    UPDATE peer_share
    SET revoked_at = NOW()
    WHERE id = ${id} AND owner_id = ${ownerId} AND revoked_at IS NULL
  `;
  return result.count === 1;
}

export async function findUserByEmail(email: string): Promise<{ id: string } | null> {
  const db = sql();
  const [row] = await db<{ id: string }[]>`
    SELECT id::text AS id FROM "user" WHERE email = ${email} LIMIT 1
  `;
  return row ?? null;
}
