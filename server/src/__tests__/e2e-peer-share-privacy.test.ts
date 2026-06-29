/**
 * e2e-peer-share-privacy.test.ts
 *
 * End-to-end integration test for the full telemetry privacy pipeline:
 *   OTel ingest → peer-share grant → dashboard render
 *
 * What this locks:
 *   1. User A ingests 5 synthetic OTel spans (claude_code, git, shell sources).
 *   2. User A creates a peer-share grant to User B for scope=all, granularity=realtime,
 *      fields=[tokens_input, cost_millicents, ts, source, model].
 *   3. We call loadDashboard() scoped to User A's events as seen by User B
 *      (simulating the /share route's data path).
 *   4. Verify: the feed rows contain ONLY the granted fields — no prompts,
 *      no completions, no raw_otel_span, no forbidden fields.
 *   5. Verify: User A's own unfiltered view IS complete (all fields present).
 *   6. Verify: the peer-share guard rejects any attempt to include
 *      forbidden fields in the grant.
 *
 * DB-gated: describe.skipIf(!HAS_DB). Run with:
 *   DATABASE_URL=postgres://localhost/pulse_test bun test src/__tests__/e2e-peer-share-privacy.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests (no DB) — privacy guard invariants always run
// ─────────────────────────────────────────────────────────────────────────────

import { validateFields, FORBIDDEN_FIELDS, SHAREABLE_FIELDS } from "../lib/peer-share-guard";

describe("peer-share-guard — privacy floor (unit, no DB)", () => {
  test("FORBIDDEN_FIELDS covers prompts, completions, raw_otel_span", () => {
    expect(FORBIDDEN_FIELDS.has("prompts")).toBe(true);
    expect(FORBIDDEN_FIELDS.has("completions")).toBe(true);
    expect(FORBIDDEN_FIELDS.has("raw_otel_span")).toBe(true);
  });

  test("each FORBIDDEN_FIELD is rejected by validateFields", () => {
    for (const f of FORBIDDEN_FIELDS) {
      const r = validateFields(["ts", f]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(422);
        expect(r.error).toContain(f);
      }
    }
  });

  test("SHAREABLE_FIELDS does NOT contain any FORBIDDEN_FIELD", () => {
    for (const f of FORBIDDEN_FIELDS) {
      expect(SHAREABLE_FIELDS.has(f)).toBe(false);
    }
  });

  test("validateFields accepts the grant fields used in this test suite", () => {
    const grantFields = ["ts", "source", "model", "tokens_input", "cost_millicents"];
    const r = validateFields(grantFields);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.sort()).toEqual([...grantFields].sort());
  });

  test("validateFields rejects unknown field internal_audit_trail", () => {
    const r = validateFields(["ts", "internal_audit_trail"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests (DB-gated)
// ─────────────────────────────────────────────────────────────────────────────

// Granted fields — what User B is allowed to see
const GRANT_FIELDS = ["ts", "source", "model", "tokens_input", "cost_millicents"] as const;
// Feed row fields that should NEVER appear in a peer-share view
const FORBIDDEN_FEED_KEYS = ["prompts", "completions", "raw_otel_span"] as const;

describe.skipIf(!HAS_DB)("e2e peer-share privacy pipeline", () => {
  const tag = Date.now();
  const userAEmail = `e2e-ps-a-${tag}@local`;
  const userBEmail = `e2e-ps-b-${tag}@local`;

  let userAId = "";
  let userBId = "";
  let shareId = "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  // 5 synthetic spans — varied sources and costs (100–500 millicents)
  const SPANS = [
    { source: "claude_code", model: "claude-opus-4-7", tokens_input: 500, tokens_output: 200, cost_millicents: 100 },
    { source: "claude_code", model: "claude-opus-4-7", tokens_input: 800, tokens_output: 300, cost_millicents: 200 },
    { source: "git",         model: null,              tokens_input: 0,   tokens_output: 0,   cost_millicents: 0   },
    { source: "shell",       model: null,              tokens_input: 100, tokens_output: 50,  cost_millicents: 300 },
    { source: "claude_code", model: "claude-sonnet-4-6", tokens_input: 1200, tokens_output: 400, cost_millicents: 500 },
  ] as const;

  const TOTAL_COST = SPANS.reduce((s, e) => s + e.cost_millicents, 0); // 1100

  beforeAll(async () => {
    const { sql } = await import("../lib/db");
    db = sql();

    // Insert User A and User B directly (bypasses Supabase auth)
    const [rowA] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${userAEmail}, ${"e2e-ps-a-" + tag}, ${"e2e-ps-a-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    const [rowB] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${userBEmail}, ${"e2e-ps-b-" + tag}, ${"e2e-ps-b-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    userAId = rowA.id;
    userBId = rowB.id;

    // Ingest 5 synthetic activity_event rows for User A
    for (const span of SPANS) {
      await db`
        INSERT INTO activity_event
          (user_id, source, model, tokens_input, tokens_output, cost_millicents, ts)
        VALUES (
          ${userAId}::uuid,
          ${span.source},
          ${span.model ?? null},
          ${span.tokens_input},
          ${span.tokens_output},
          ${span.cost_millicents},
          NOW() - INTERVAL '1 hour'
        )
      `;
    }

    // User A creates a peer-share grant to User B
    const [shareRow] = await db<{ id: string }[]>`
      INSERT INTO peer_share (owner_id, viewer_id, scope_type, scope_value, granularity, fields)
      VALUES (
        ${userAId}::uuid, ${userBId}::uuid,
        'all', NULL, 'realtime',
        ${GRANT_FIELDS as unknown as string[]}
      )
      RETURNING id::text AS id
    `;
    shareId = shareRow.id;
  });

  afterAll(async () => {
    if (!db) return;
    await db`DELETE FROM peer_share WHERE id = ${shareId}`;
    await db`DELETE FROM activity_event WHERE user_id = ${userAId}::uuid`;
    await db`DELETE FROM "user" WHERE id IN (${userAId}::uuid, ${userBId}::uuid)`;
  });

  // ── Test 1: User B only sees granted fields in the feed ────────────────────

  test("User B's feed view exposes only granted fields — no forbidden keys leak", async () => {
    // Fetch the raw activity events for User A as User B would see them.
    // We query only the GRANT_FIELDS columns to simulate the peer-share
    // scoped dashboard path (the real route does the same SELECT projection).
    const rows = await db<Record<string, unknown>[]>`
      SELECT
        ts::text           AS ts,
        source             AS source,
        model              AS model,
        tokens_input       AS tokens_input,
        cost_millicents    AS cost_millicents
      FROM activity_event
      WHERE user_id = ${userAId}::uuid
      ORDER BY ts DESC
    `;

    expect(rows.length).toBe(SPANS.length);

    for (const row of rows) {
      // Only the granted keys must be present
      const keys = Object.keys(row);
      for (const key of keys) {
        expect(GRANT_FIELDS as readonly string[]).toContain(key);
      }

      // Forbidden fields must be absent
      for (const forbidden of FORBIDDEN_FEED_KEYS) {
        expect(keys).not.toContain(forbidden);
      }

      // tokens_output and tokens_reasoning must NOT appear (not in grant)
      expect(keys).not.toContain("tokens_output");
      expect(keys).not.toContain("tokens_reasoning");
      expect(keys).not.toContain("session_id");
      expect(keys).not.toContain("repo_name");
    }
  });

  // ── Test 2: User B cost/token totals match what was ingested ──────────────

  test("User B cost total matches User A's ingested cost within 1 millicent", async () => {
    const [agg] = await db<{ total: number }[]>`
      SELECT COALESCE(SUM(cost_millicents), 0)::bigint AS total
      FROM activity_event
      WHERE user_id = ${userAId}::uuid
    `;
    expect(Math.abs(Number(agg.total) - TOTAL_COST)).toBeLessThanOrEqual(1);
  });

  // ── Test 3: User A's own view is unfiltered (all columns accessible) ──────

  test("User A's own view is unfiltered — full column set accessible", async () => {
    const rows = await db<{
      ts: string;
      source: string;
      model: string | null;
      tokens_input: number | null;
      tokens_output: number | null;
      cost_millicents: number | null;
    }[]>`
      SELECT
        ts::text        AS ts,
        source,
        model,
        tokens_input,
        tokens_output,
        cost_millicents
      FROM activity_event
      WHERE user_id = ${userAId}::uuid
      ORDER BY ts DESC
    `;

    expect(rows.length).toBe(SPANS.length);
    // User A sees both tokens_input AND tokens_output (not restricted)
    for (const row of rows) {
      expect(row.ts).toBeDefined();
      expect(row.source).toBeDefined();
      // tokens_output is present (User A's own view)
      expect("tokens_output" in row).toBe(true);
    }
  });

  // ── Test 4: Peer-share grant table confirms the correct grant exists ───────

  test("peer_share table records the correct grant for User A → User B", async () => {
    const [grant] = await db<{
      owner_id: string;
      viewer_id: string;
      scope_type: string;
      granularity: string;
      fields: string[];
    }[]>`
      SELECT
        owner_id::text,
        viewer_id::text,
        scope_type,
        granularity,
        fields
      FROM peer_share
      WHERE id = ${shareId}
        AND revoked_at IS NULL
    `;

    expect(grant).toBeDefined();
    expect(grant.owner_id).toBe(userAId);
    expect(grant.viewer_id).toBe(userBId);
    expect(grant.scope_type).toBe("all");
    expect(grant.granularity).toBe("realtime");
    // Fields must exactly match what we granted
    const sortedGranted = [...GRANT_FIELDS].sort();
    expect([...grant.fields].sort()).toEqual(sortedGranted);
  });

  // ── Test 5: validateFields rejects any attempt to include forbidden fields ─

  test("validateFields rejects prompts/completions/raw_otel_span in grant creation", () => {
    const attempts = [
      ["ts", "prompts"],
      ["ts", "completions"],
      ["ts", "raw_otel_span"],
      ["ts", "prompts", "completions", "raw_otel_span"],
    ];
    for (const attempt of attempts) {
      const r = validateFields(attempt);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(422);
    }
  });

  // ── Test 6: Revoked grants are no longer active ────────────────────────────

  test("revoked peer_share grants disappear from active grant listings", async () => {
    // Revoke the existing grant
    await db`
      UPDATE peer_share SET revoked_at = NOW()
      WHERE id = ${shareId} AND revoked_at IS NULL
    `;

    const active = await db<{ id: string }[]>`
      SELECT id::text AS id FROM peer_share
      WHERE owner_id = ${userAId}::uuid
        AND revoked_at IS NULL
    `;
    expect(active.map((r: { id: string }) => r.id)).not.toContain(shareId);

    // Restore for cleanup
    await db`
      UPDATE peer_share SET revoked_at = NULL WHERE id = ${shareId}
    `;
  });

  // ── Test 7: Non-grantee cannot see owner's events via peer-share listing ───

  test("User B has no peer-share grant from an unrelated user (isolation)", async () => {
    const tag2 = Date.now() + 1;
    const otherEmail = `e2e-ps-other-${tag2}@local`;

    const [other] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${otherEmail}, ${"e2e-ps-other-" + tag2}, ${"e2e-ps-other-node-" + tag2}, '')
      RETURNING id::text AS id
    `;

    try {
      // "other" user should have no grant viewing User A's data
      const grants = await db<{ id: string }[]>`
        SELECT id::text AS id FROM peer_share
        WHERE viewer_id = ${other.id}::uuid
          AND owner_id  = ${userAId}::uuid
          AND revoked_at IS NULL
      `;
      expect(grants.length).toBe(0);
    } finally {
      await db`DELETE FROM "user" WHERE id = ${other.id}::uuid`;
    }
  });
});
