/**
 * peer-share-db.test.ts — round-trip integration test against the live
 * Postgres in docker-compose. Skips when DATABASE_URL isn't set (so CI
 * without a DB doesn't fail; ship CI postgres in a follow-up).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../src/lib/db";
import { ensureLocalUser } from "../src/lib/current-user";
import {
  createPeerShare,
  findUserByEmail,
  listGrantsForViewer,
  listGrantsOwnedBy,
  revokeShare,
} from "../src/lib/peer-share-db";

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("peer-share-db round trip", () => {
  const ownerEmail = `pulse-test-owner-${Date.now()}@local`;
  const viewerEmail = `pulse-test-viewer-${Date.now()}@local`;
  let ownerId = "";
  let viewerId = "";

  beforeAll(async () => {
    const owner = await ensureLocalUser(ownerEmail, "test owner");
    const viewer = await ensureLocalUser(viewerEmail, "test viewer");
    ownerId = owner.id;
    viewerId = viewer.id;
  });

  afterAll(async () => {
    const db = sql();
    await db`DELETE FROM peer_share WHERE owner_id = ${ownerId} OR viewer_id = ${viewerId}`;
    await db`DELETE FROM "user" WHERE id IN (${ownerId}, ${viewerId})`;
  });

  test("create + list + revoke", async () => {
    const grant = await createPeerShare({
      owner_id: ownerId,
      viewer_id: viewerId,
      scope_type: "repo_pattern",
      scope_value: "client-*",
      granularity: "weekly",
      fields: ["ts", "source", "model", "tokens_input"],
    });
    expect(grant.owner_email).toBe(ownerEmail);
    expect(grant.viewer_email).toBe(viewerEmail);
    expect(grant.fields).toEqual(["ts", "source", "model", "tokens_input"]);

    const owned = await listGrantsOwnedBy(ownerId);
    expect(owned.map((g) => g.id)).toContain(grant.id);

    const granted = await listGrantsForViewer(viewerId);
    expect(granted.map((g) => g.id)).toContain(grant.id);

    const revoked = await revokeShare(grant.id, ownerId);
    expect(revoked).toBe(true);

    // After revoke neither side should see it as active.
    const owned2 = await listGrantsOwnedBy(ownerId);
    expect(owned2.map((g) => g.id)).not.toContain(grant.id);
    const granted2 = await listGrantsForViewer(viewerId);
    expect(granted2.map((g) => g.id)).not.toContain(grant.id);
  });

  test("revoke is idempotent + ownership-checked", async () => {
    const grant = await createPeerShare({
      owner_id: ownerId,
      viewer_id: viewerId,
      scope_type: "all",
      scope_value: null,
      granularity: "daily",
      fields: ["ts", "source"],
    });
    // First revoke wins.
    expect(await revokeShare(grant.id, ownerId)).toBe(true);
    // Second is a no-op (already revoked → not found).
    expect(await revokeShare(grant.id, ownerId)).toBe(false);
    // Even fresh grants can't be revoked by non-owner.
    const grant2 = await createPeerShare({
      owner_id: ownerId,
      viewer_id: viewerId,
      scope_type: "all",
      scope_value: null,
      granularity: "monthly",
      fields: ["ts"],
    });
    expect(await revokeShare(grant2.id, viewerId)).toBe(false);
    expect(await revokeShare(grant2.id, ownerId)).toBe(true);
  });

  test("findUserByEmail returns null for unknown email", async () => {
    expect(await findUserByEmail("nobody-here@local")).toBeNull();
    expect((await findUserByEmail(ownerEmail))?.id).toBe(ownerId);
  });
});
