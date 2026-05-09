/**
 * pat.test.ts — round-trip integration tests for PAT mint/list/revoke.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../src/lib/db";
import { ensureLocalUser } from "../src/lib/current-user";
import { mintPat, listPats, revokePat, verifyPat, normalizePatScopes } from "../src/lib/pat";

describe("normalizePatScopes", () => {
  test("defaults agent tokens to ingest plus heartbeat", () => {
    expect(normalizePatScopes(undefined)).toEqual(["ingest", "heartbeat"]);
  });

  test("dedupes explicit scopes and rejects unknown scopes", () => {
    expect(normalizePatScopes(["ingest", "ingest", "invite:create"])).toEqual(["ingest", "invite:create"]);
    expect(() => normalizePatScopes(["admin"])).toThrow("unknown PAT scope");
  });
});

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("pat round trip", () => {
  const testEmail = `pulse-pat-test-${Date.now()}@local`;
  let userId: string;

  beforeAll(async () => {
    const user = await ensureLocalUser(testEmail, null);
    userId = user.id;
  });

  afterAll(async () => {
    const db = sql();
    await db`DELETE FROM "user" WHERE email = ${testEmail}`;
  });

  test("mint → list → revoke round trip", async () => {
    // Mint two PATs.
    const a = await mintPat(userId, "test-token-a");
    const b = await mintPat(userId, "test-token-b");
    expect(a.token).toMatch(/^pulse_pat_/);
    expect(b.token).toMatch(/^pulse_pat_/);
    expect(a.id).not.toBe(b.id);

    // List returns both.
    const listed = await listPats(userId);
    const ids = listed.map((p) => p.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    // No hashed_token in list output.
    for (const row of listed) {
      expect(Object.keys(row)).not.toContain("hashed_token");
    }

    // verifyPat resolves the plaintext token to userId.
    const resolved = await verifyPat(a.token);
    expect(resolved).toBe(userId);

    // Revoke one.
    expect(await revokePat(a.id, userId)).toBe(true);

    // After revoke, list no longer includes it.
    const after = await listPats(userId);
    expect(after.map((p) => p.id)).not.toContain(a.id);
    expect(after.map((p) => p.id)).toContain(b.id);

    // verifyPat now returns null for the revoked token.
    expect(await verifyPat(a.token)).toBeNull();

    // Double-revoke is a no-op (returns false).
    expect(await revokePat(a.id, userId)).toBe(false);

    // Non-owner cannot revoke.
    expect(await revokePat(b.id, "00000000-0000-0000-0000-000000000000")).toBe(false);

    // Cleanup b.
    expect(await revokePat(b.id, userId)).toBe(true);
  });
});
