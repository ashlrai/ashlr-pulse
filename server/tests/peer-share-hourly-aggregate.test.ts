/**
 * peer-share-hourly-aggregate.test.ts — compute correctness, delta ordering,
 * and privacy guards on subscriber visibility.
 *
 * DB-gated (describe.skipIf(!HAS_DB)) following the pattern in
 * peer-share-aggregate.test.ts.
 *
 * To run against a real DB:
 *   createdb pulse_test && DATABASE_URL=postgres://localhost/pulse_test \
 *     bun run migrate && \
 *     DATABASE_URL=... bun test tests/peer-share-hourly-aggregate.test.ts ; \
 *     dropdb pulse_test
 *
 * What this tests:
 *   1.  refreshHourlyAggregates inserts a row for the current hour bucket.
 *   2.  Cost and event totals match the seeded activity_event rows.
 *   3.  The upsert is idempotent — re-running does not double-count.
 *   4.  readHourlyRows returns rows within the requested bucket range.
 *   5.  computeDeltas returns only changed rows and orders by bucket ASC.
 *   6.  computeDeltas returns an empty array when nothing changed.
 *   7.  PRIVACY: revoked grants produce no aggregate rows.
 *   8.  PRIVACY: a second viewer (no grant) cannot see owner rows via
 *       readHourlyRows — the EXISTS grant-check in refreshHourlyAggregates
 *       prevents rows from being written for ungrated pairs.
 *   9.  pruneHourlyAggregates removes rows older than HOURLY_RETENTION_HRS.
 *   10. runHourlyAggregateCron processes active pairs and skips revoked grants.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../src/lib/db";
import {
  refreshHourlyAggregates,
  readHourlyRows,
  pruneHourlyAggregates,
  computeDeltas,
  runHourlyAggregateCron,
  HOURLY_RETENTION_HRS,
  type PeerShareHourlyAggregate,
} from "../src/lib/peer-share-hourly-aggregate";
import {
  sanitisePayload,
  signWebhookPayload,
  deliverPeerShareWebhook,
  aggregatePastHour,
  upsertHourlyAggregate,
  runPeerShareHourlyAgg,
  MAX_RETRIES,
  type ActiveGrant,
} from "../src/lib/peer-share-agg";

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("peer_share_hourly_aggregate", () => {
  const tag = Date.now();
  const ownerEmail    = `pulse-pha-owner-${tag}@local`;
  const viewerEmail   = `pulse-pha-viewer-${tag}@local`;
  const stranger      = `pulse-pha-stranger-${tag}@local`;

  let ownerId    = "";
  let viewerId   = "";
  let strangerId = "";
  let shareId    = "";

  // Current UTC hour bucket (truncated to hour start).
  const nowMs = Date.now();
  const currentHourMs = nowMs - (nowMs % 3_600_000);
  const currentBucket = new Date(currentHourMs);

  const COST_A = 2000; // millicents
  const COST_B = 3500; // millicents
  const TOTAL_COST = COST_A + COST_B;

  let db: ReturnType<typeof sql>;

  beforeAll(async () => {
    db = sql();

    // Owner
    const [ownerRow] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${ownerEmail}, ${"pha-owner-" + tag}, ${"pha-owner-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    ownerId = ownerRow.id;

    // Viewer (has a grant)
    const [viewerRow] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${viewerEmail}, ${"pha-viewer-" + tag}, ${"pha-viewer-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    viewerId = viewerRow.id;

    // Stranger (no grant)
    const [strangerRow] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${stranger}, ${"pha-stranger-" + tag}, ${"pha-stranger-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    strangerId = strangerRow.id;

    // Active grant from owner → viewer
    const [shareRow] = await db<{ id: string }[]>`
      INSERT INTO peer_share (owner_id, viewer_id, scope_type, scope_value, granularity, fields)
      VALUES (
        ${ownerId}::uuid, ${viewerId}::uuid,
        'all', NULL, 'realtime',
        ARRAY['ts','source','model','tokens_input','tokens_output','cost_millicents']
      )
      RETURNING id::text AS id
    `;
    shareId = shareRow.id;

    // Seed two activity_event rows for the owner inside the current hour bucket.
    const eventTs = new Date(currentHourMs + 60_000).toISOString(); // +1 min into bucket
    await db`
      INSERT INTO activity_event
        (user_id, source, model, tokens_input, tokens_output, cost_millicents, ts)
      VALUES
        (${ownerId}::uuid, 'ashlr', 'claude-sonnet-4-5', 100, 200, ${COST_A}, ${eventTs}::timestamptz),
        (${ownerId}::uuid, 'ashlr', 'claude-haiku-4-5',   50, 100, ${COST_B}, ${eventTs}::timestamptz)
    `;
  });

  afterAll(async () => {
    await db`DELETE FROM peer_share_hourly_aggregate WHERE owner_id = ${ownerId}::uuid`;
    await db`DELETE FROM activity_event WHERE user_id = ${ownerId}::uuid`;
    await db`DELETE FROM peer_share WHERE id = ${shareId}`;
    await db`DELETE FROM "user" WHERE id IN (${ownerId}::uuid, ${viewerId}::uuid, ${strangerId}::uuid)`;
  });

  // ---------------------------------------------------------------------------
  // Test 1: basic insert
  // ---------------------------------------------------------------------------
  test("refreshHourlyAggregates inserts a row for the current bucket", async () => {
    const since = new Date(currentHourMs);
    const count = await refreshHourlyAggregates(ownerId, viewerId, since);
    expect(count).toBeGreaterThan(0);

    const rows = await db<{ cost_millicents: number; event_count: number }[]>`
      SELECT
        SUM(cost_millicents)::bigint AS cost_millicents,
        SUM(event_count)::int        AS event_count
      FROM peer_share_hourly_aggregate
      WHERE owner_id   = ${ownerId}::uuid
        AND viewer_id  = ${viewerId}::uuid
        AND hour_bucket = ${currentBucket.toISOString()}::timestamptz
    `;
    expect(rows.length).toBeGreaterThan(0);
    const agg = rows[0];
    expect(agg).toBeDefined();

    // Cost rollup must match raw sum within 1 millicent.
    expect(Math.abs(Number(agg.cost_millicents) - TOTAL_COST)).toBeLessThanOrEqual(1);

    // Event count must match seeded rows (2 events).
    expect(Number(agg.event_count)).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Test 2: idempotency
  // ---------------------------------------------------------------------------
  test("upsert is idempotent — re-running does not double-count", async () => {
    const since = new Date(currentHourMs);
    await refreshHourlyAggregates(ownerId, viewerId, since);
    await refreshHourlyAggregates(ownerId, viewerId, since);

    const rows = await db<{ cost_millicents: number; event_count: number }[]>`
      SELECT
        SUM(cost_millicents)::bigint AS cost_millicents,
        SUM(event_count)::int        AS event_count
      FROM peer_share_hourly_aggregate
      WHERE owner_id   = ${ownerId}::uuid
        AND viewer_id  = ${viewerId}::uuid
        AND hour_bucket = ${currentBucket.toISOString()}::timestamptz
    `;
    const agg = rows[0];
    expect(Math.abs(Number(agg.cost_millicents) - TOTAL_COST)).toBeLessThanOrEqual(1);
    expect(Number(agg.event_count)).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Test 3: readHourlyRows returns rows in the requested range
  // ---------------------------------------------------------------------------
  test("readHourlyRows returns rows within the bucket range", async () => {
    const from = new Date(currentHourMs);
    const to   = new Date(currentHourMs + 3_600_000); // up to next hour
    const rows = await readHourlyRows(ownerId, viewerId, from, to);
    expect(rows.length).toBeGreaterThan(0);
    // All returned rows must be within range
    for (const r of rows) {
      const ts = new Date(r.hourBucket).getTime();
      expect(ts).toBeGreaterThanOrEqual(currentHourMs);
      expect(ts).toBeLessThanOrEqual(currentHourMs + 3_600_000);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 4: computeDeltas returns only changed rows
  // ---------------------------------------------------------------------------
  test("computeDeltas emits deltas for changed rows only", async () => {
    const from = new Date(currentHourMs);
    const to   = new Date(currentHourMs + 3_600_000);
    const curr = await readHourlyRows(ownerId, viewerId, from, to);

    // Against empty prev — all non-zero rows should produce deltas.
    const deltas = computeDeltas(ownerId, [], curr);
    const nonZeroCurr = curr.filter(
      (r) => r.costMillicents > 0 || r.tokensInput + r.tokensOutput > 0,
    );
    expect(deltas.length).toBe(nonZeroCurr.length);

    // All deltas carry the ownerId.
    for (const d of deltas) {
      expect(d.ownerId).toBe(ownerId);
      expect(d.type).toBe("delta");
    }
  });

  // ---------------------------------------------------------------------------
  // Test 5: computeDeltas orders by bucket ASC
  // ---------------------------------------------------------------------------
  test("computeDeltas orders deltas by bucket ASC", async () => {
    const from = new Date(currentHourMs - 2 * 3_600_000);
    const to   = new Date(currentHourMs + 3_600_000);
    const curr = await readHourlyRows(ownerId, viewerId, from, to);
    const deltas = computeDeltas(ownerId, [], curr);

    for (let i = 1; i < deltas.length; i++) {
      expect(deltas[i].bucket >= deltas[i - 1].bucket).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 6: computeDeltas returns empty when nothing changed
  // ---------------------------------------------------------------------------
  test("computeDeltas returns empty array when snapshot is identical", async () => {
    const from = new Date(currentHourMs);
    const to   = new Date(currentHourMs + 3_600_000);
    const curr = await readHourlyRows(ownerId, viewerId, from, to);
    // Prev == curr → no deltas.
    const deltas = computeDeltas(ownerId, curr, curr);
    expect(deltas).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 7: PRIVACY — revoked grant produces no aggregate rows
  // ---------------------------------------------------------------------------
  test("PRIVACY: revoked grant — refreshHourlyAggregates writes no rows for revoked pair", async () => {
    // Revoke the grant temporarily.
    await db`UPDATE peer_share SET revoked_at = NOW() WHERE id = ${shareId}`;

    // Delete existing rows for this pair.
    await db`
      DELETE FROM peer_share_hourly_aggregate
      WHERE owner_id = ${ownerId}::uuid AND viewer_id = ${viewerId}::uuid
    `;

    // Attempt refresh — should produce 0 non-zero rows because the grant check
    // inside the SQL EXISTS fails. Zero-placeholder rows may still be written
    // (the empty-bucket sentinel), so we check cost + event totals are zero.
    const since = new Date(currentHourMs);
    await refreshHourlyAggregates(ownerId, viewerId, since);

    const rows = await db<{ total_cost: number; total_events: number }[]>`
      SELECT
        COALESCE(SUM(cost_millicents), 0)::bigint AS total_cost,
        COALESCE(SUM(event_count), 0)::int        AS total_events
      FROM peer_share_hourly_aggregate
      WHERE owner_id  = ${ownerId}::uuid
        AND viewer_id = ${viewerId}::uuid
        AND hour_bucket = ${currentBucket.toISOString()}::timestamptz
    `;
    expect(Number(rows[0]?.total_cost   ?? 0)).toBe(0);
    expect(Number(rows[0]?.total_events ?? 0)).toBe(0);

    // Restore for remaining tests.
    await db`UPDATE peer_share SET revoked_at = NULL WHERE id = ${shareId}`;
  });

  // ---------------------------------------------------------------------------
  // Test 8: PRIVACY — stranger (no grant) sees no rows
  // ---------------------------------------------------------------------------
  test("PRIVACY: stranger with no grant cannot see owner rows", async () => {
    // Attempt to refresh aggregates for strangerId as viewer — no grant exists.
    const since = new Date(currentHourMs);
    await refreshHourlyAggregates(ownerId, strangerId, since);

    // readHourlyRows for stranger should return only zero-sentinel rows or nothing.
    const from = new Date(currentHourMs);
    const to   = new Date(currentHourMs + 3_600_000);
    const rows = await readHourlyRows(ownerId, strangerId, from, to);

    // Any rows present must have zero cost and zero events (sentinel rows only).
    const nonZero = rows.filter(
      (r) => r.costMillicents > 0 || r.eventCount > 0,
    );
    expect(nonZero).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 9: pruneHourlyAggregates removes stale rows
  // ---------------------------------------------------------------------------
  test("pruneHourlyAggregates removes rows older than HOURLY_RETENTION_HRS", async () => {
    // Insert a very old row (HOURLY_RETENTION_HRS + 2 hours ago).
    const oldBucket = new Date(
      Date.now() - (HOURLY_RETENTION_HRS + 2) * 3_600_000,
    );
    const oldBucketIso = new Date(
      oldBucket.getTime() - (oldBucket.getTime() % 3_600_000),
    ).toISOString();

    await db`
      INSERT INTO peer_share_hourly_aggregate
        (owner_id, viewer_id, hour_bucket, source, model,
         tokens_input, tokens_output, cost_millicents, event_count, computed_at)
      VALUES (
        ${ownerId}::uuid, ${viewerId}::uuid,
        ${oldBucketIso}::timestamptz, 'ashlr', 'claude-sonnet-4-5',
        0, 0, 0, 0, NOW()
      )
      ON CONFLICT (owner_id, viewer_id, hour_bucket, source, model) DO UPDATE SET computed_at = NOW()
    `;

    const pruned = await pruneHourlyAggregates();
    expect(pruned).toBeGreaterThanOrEqual(1);

    const check = await db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM peer_share_hourly_aggregate
      WHERE owner_id   = ${ownerId}::uuid
        AND viewer_id  = ${viewerId}::uuid
        AND hour_bucket = ${oldBucketIso}::timestamptz
    `;
    expect(Number(check[0]?.n ?? 0)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 10: runHourlyAggregateCron processes pairs and skips revoked
  // ---------------------------------------------------------------------------
  test("runHourlyAggregateCron processes active pairs and skips revoked grants", async () => {
    // Run once — should include our active pair.
    const result = await runHourlyAggregateCron();
    expect(result.pairs).toBeGreaterThanOrEqual(1);
    expect(result.rowsUpserted).toBeGreaterThan(0);
    expect(typeof result.rowsPruned).toBe("number");

    // Now revoke the grant and verify the pair is excluded.
    await db`UPDATE peer_share SET revoked_at = NOW() WHERE id = ${shareId}`;
    await db`
      DELETE FROM peer_share_hourly_aggregate
      WHERE owner_id = ${ownerId}::uuid AND viewer_id = ${viewerId}::uuid
    `;

    await runHourlyAggregateCron();

    const rows = await db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM peer_share_hourly_aggregate
      WHERE owner_id  = ${ownerId}::uuid
        AND viewer_id = ${viewerId}::uuid
        AND (cost_millicents > 0 OR event_count > 0)
    `;
    expect(Number(rows[0]?.n ?? 0)).toBe(0);

    // Restore for afterAll cleanup.
    await db`UPDATE peer_share SET revoked_at = NULL WHERE id = ${shareId}`;
  });
});

// ---------------------------------------------------------------------------
// Pure unit tests — no DB required
// ---------------------------------------------------------------------------

describe("computeDeltas (unit)", () => {
  const makeRow = (
    overrides: Partial<PeerShareHourlyAggregate>,
  ): PeerShareHourlyAggregate => ({
    ownerId: "owner-1",
    viewerId: "viewer-1",
    hourBucket: "2026-06-29T14:00:00.000Z",
    source: "ashlr",
    model: "claude-sonnet-4-5",
    tokensInput: 0,
    tokensOutput: 0,
    costMillicents: 0,
    eventCount: 0,
    computedAt: new Date().toISOString(),
    ...overrides,
  });

  test("emits delta when cost increases", () => {
    const prev = [makeRow({ costMillicents: 100 })];
    const curr = [makeRow({ costMillicents: 250 })];
    const deltas = computeDeltas("owner-1", prev, curr);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].costDelta).toBe(150);
    expect(deltas[0].type).toBe("delta");
  });

  test("emits delta when token count increases", () => {
    const prev = [makeRow({ tokensInput: 50, tokensOutput: 50 })];
    const curr = [makeRow({ tokensInput: 100, tokensOutput: 100 })];
    const deltas = computeDeltas("owner-1", prev, curr);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].tokenDelta).toBe(100);
  });

  test("no delta when values are unchanged", () => {
    const row = makeRow({ costMillicents: 500, tokensInput: 100, tokensOutput: 200 });
    const deltas = computeDeltas("owner-1", [row], [row]);
    expect(deltas).toHaveLength(0);
  });

  test("emits delta for new row not in prev", () => {
    const curr = [makeRow({ costMillicents: 700, hourBucket: "2026-06-29T15:00:00.000Z" })];
    const deltas = computeDeltas("owner-1", [], curr);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].costDelta).toBe(700);
  });

  test("orders output by bucket ASC", () => {
    const curr = [
      makeRow({ hourBucket: "2026-06-29T16:00:00.000Z", costMillicents: 10 }),
      makeRow({ hourBucket: "2026-06-29T14:00:00.000Z", costMillicents: 20 }),
      makeRow({ hourBucket: "2026-06-29T15:00:00.000Z", costMillicents: 30 }),
    ];
    const deltas = computeDeltas("owner-1", [], curr);
    expect(deltas.map((d) => d.bucket)).toEqual([
      "2026-06-29T14:00:00.000Z",
      "2026-06-29T15:00:00.000Z",
      "2026-06-29T16:00:00.000Z",
    ]);
  });

  test("differentiates rows by source+model+bucket key", () => {
    const prev = [
      makeRow({ source: "ashlr",  model: "claude-sonnet-4-5", costMillicents: 100 }),
      makeRow({ source: "cursor", model: "gpt-4o",             costMillicents: 200 }),
    ];
    const curr = [
      makeRow({ source: "ashlr",  model: "claude-sonnet-4-5", costMillicents: 150 }),
      makeRow({ source: "cursor", model: "gpt-4o",             costMillicents: 200 }),
    ];
    const deltas = computeDeltas("owner-1", prev, curr);
    // Only the ashlr row changed.
    expect(deltas).toHaveLength(1);
    expect(deltas[0].source).toBe("ashlr");
    expect(deltas[0].costDelta).toBe(50);
  });

  test("zero-cost zero-token rows produce no delta", () => {
    const prev = [makeRow({ costMillicents: 0, tokensInput: 0, tokensOutput: 0 })];
    const curr = [makeRow({ costMillicents: 0, tokensInput: 0, tokensOutput: 0 })];
    const deltas = computeDeltas("owner-1", prev, curr);
    expect(deltas).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sanitisePayload — privacy floor unit tests (no DB required)
// ---------------------------------------------------------------------------

describe("sanitisePayload (unit)", () => {
  const baseGrant: ActiveGrant = {
    share_id: "share-abc",
    owner_id: "owner-1",
    viewer_id: "viewer-1",
    fields: ["ts", "source", "tokens_input", "tokens_output", "cost_millicents"],
    org_id: "org-1",
    peer_share_webhook_url: "https://hooks.example.com/peer",
  };

  const bucket = "2026-06-29T14:00:00.000Z";
  const triggeredAt = "2026-06-29T15:05:00.000Z";

  test("always includes base aggregate fields", () => {
    const payload = sanitisePayload(
      baseGrant,
      bucket,
      { tokens_input: 100, tokens_output: 200, cost_millicents: 500, event_count: 3 },
      triggeredAt,
    );
    expect(payload.event).toBe("peer_share_activity");
    expect(payload.share_id).toBe("share-abc");
    expect(payload.owner_id).toBe("owner-1");
    expect(payload.viewer_id).toBe("viewer-1");
    expect(payload.hour_bucket).toBe(bucket);
    expect(payload.tokens_input).toBe(100);
    expect(payload.tokens_output).toBe(200);
    expect(payload.cost_millicents).toBe(500);
    expect(payload.event_count).toBe(3);
    expect(payload.triggered_at).toBe(triggeredAt);
  });

  test("PRIVACY: model is omitted when not in grant.fields", () => {
    const payload = sanitisePayload(
      baseGrant, // fields does not include "model"
      bucket,
      { tokens_input: 100, tokens_output: 200, cost_millicents: 500, event_count: 3, model: "claude-sonnet-4-5" },
      triggeredAt,
    );
    expect(payload.model).toBeUndefined();
  });

  test("model is included when grant.fields contains 'model'", () => {
    const grantWithModel: ActiveGrant = { ...baseGrant, fields: [...baseGrant.fields, "model"] };
    const payload = sanitisePayload(
      grantWithModel,
      bucket,
      { tokens_input: 100, tokens_output: 200, cost_millicents: 500, event_count: 3, model: "claude-sonnet-4-5" },
      triggeredAt,
    );
    expect(payload.model).toBe("claude-sonnet-4-5");
  });

  test("PRIVACY: repo_name is omitted when not in grant.fields", () => {
    const payload = sanitisePayload(
      baseGrant, // fields does not include "repo_name"
      bucket,
      { tokens_input: 100, tokens_output: 200, cost_millicents: 500, event_count: 3, repo_name: "secret-repo" },
      triggeredAt,
    );
    expect(payload.repo_name).toBeUndefined();
  });

  test("repo_name is included when grant.fields contains 'repo_name'", () => {
    const grantWithRepo: ActiveGrant = { ...baseGrant, fields: [...baseGrant.fields, "repo_name"] };
    const payload = sanitisePayload(
      grantWithRepo,
      bucket,
      { tokens_input: 100, tokens_output: 200, cost_millicents: 500, event_count: 3, repo_name: "my-repo" },
      triggeredAt,
    );
    expect(payload.repo_name).toBe("my-repo");
  });

  test("PRIVACY: model undefined in agg does not appear in payload even with field permission", () => {
    const grantWithModel: ActiveGrant = { ...baseGrant, fields: [...baseGrant.fields, "model"] };
    const payload = sanitisePayload(
      grantWithModel,
      bucket,
      { tokens_input: 10, tokens_output: 10, cost_millicents: 100, event_count: 1 },
      triggeredAt,
    );
    expect(payload.model).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// signWebhookPayload — HMAC signing unit tests (no DB required)
// ---------------------------------------------------------------------------

describe("signWebhookPayload (unit)", () => {
  test("returns a sha256=<hex> string", () => {
    const sig = signWebhookPayload("supersecret", '{"event":"peer_share_activity"}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  test("same secret + body → same signature (deterministic)", () => {
    const body = JSON.stringify({ a: 1 });
    const sig1 = signWebhookPayload("s3cr3t", body);
    const sig2 = signWebhookPayload("s3cr3t", body);
    expect(sig1).toBe(sig2);
  });

  test("different secrets → different signatures", () => {
    const body = '{"event":"test"}';
    expect(signWebhookPayload("secret-a", body)).not.toBe(signWebhookPayload("secret-b", body));
  });

  test("different bodies → different signatures", () => {
    const secret = "fixed-secret";
    expect(signWebhookPayload(secret, '{"a":1}')).not.toBe(signWebhookPayload(secret, '{"a":2}'));
  });
});

// ---------------------------------------------------------------------------
// deliverPeerShareWebhook — retry / backoff unit tests (no DB required)
// ---------------------------------------------------------------------------

describe("deliverPeerShareWebhook (unit)", () => {
  const makePayload = (): Parameters<typeof deliverPeerShareWebhook>[1] => ({
    event: "peer_share_activity",
    share_id: "s1",
    owner_id: "o1",
    viewer_id: "v1",
    hour_bucket: "2026-06-29T14:00:00.000Z",
    tokens_input: 100,
    tokens_output: 200,
    cost_millicents: 500,
    event_count: 2,
    triggered_at: new Date().toISOString(),
  });

  /** Helper: patch globalThis.fetch with a compatible mock, preserving extra props. */
  function patchFetch(impl: (url: URL | RequestInfo, init?: RequestInit) => Promise<Response>) {
    const original = globalThis.fetch;
    // Cast avoids the Bun-specific `preconnect` property requirement in tests.
    (globalThis as Record<string, unknown>).fetch = Object.assign(impl, original);
    return () => { globalThis.fetch = original; };
  }

  test("returns ok:true on 200 response", async () => {
    let callCount = 0;
    const restore = patchFetch(async () => {
      callCount++;
      return new Response("{}", { status: 200 });
    });
    try {
      const result = await deliverPeerShareWebhook("https://hooks.example.com", makePayload(), null);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status).toBe(200);
        expect(result.attempt).toBe(1);
      }
      expect(callCount).toBe(1);
    } finally {
      restore();
    }
  });

  test("does not retry on 4xx response", async () => {
    let callCount = 0;
    const restore = patchFetch(async () => {
      callCount++;
      return new Response("Not Found", { status: 404 });
    });
    try {
      const result = await deliverPeerShareWebhook("https://hooks.example.com", makePayload(), null);
      expect(result.ok).toBe(false);
      expect(callCount).toBe(1); // no retry on 4xx
      if (!result.ok) {
        expect(result.error).toContain("4xx");
      }
    } finally {
      restore();
    }
  });

  test(`retries on 5xx up to MAX_RETRIES (${MAX_RETRIES}) times`, async () => {
    let callCount = 0;
    const restore = patchFetch(async () => {
      callCount++;
      return new Response("Server Error", { status: 500 });
    });
    try {
      const result = await deliverPeerShareWebhook("https://hooks.example.com", makePayload(), null);
      expect(result.ok).toBe(false);
      expect(callCount).toBe(MAX_RETRIES);
    } finally {
      restore();
    }
  });

  test("succeeds on second attempt after initial 5xx", async () => {
    let callCount = 0;
    const restore = patchFetch(async () => {
      callCount++;
      if (callCount === 1) return new Response("Error", { status: 503 });
      return new Response("{}", { status: 200 });
    });
    try {
      const result = await deliverPeerShareWebhook("https://hooks.example.com", makePayload(), null);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.attempt).toBe(2);
      }
    } finally {
      restore();
    }
  });

  test("includes x-pulse-signature header when secret is provided", async () => {
    let capturedHeaders: Record<string, string> = {};
    const restore = patchFetch(async (_url, init) => {
      const h = init?.headers as Record<string, string> | undefined;
      if (h) capturedHeaders = h;
      return new Response("{}", { status: 200 });
    });
    try {
      await deliverPeerShareWebhook("https://hooks.example.com", makePayload(), "my-secret");
      expect(capturedHeaders["x-pulse-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    } finally {
      restore();
    }
  });

  test("omits x-pulse-signature header when secret is null", async () => {
    let capturedHeaders: Record<string, string> = {};
    const restore = patchFetch(async (_url, init) => {
      const h = init?.headers as Record<string, string> | undefined;
      if (h) capturedHeaders = h;
      return new Response("{}", { status: 200 });
    });
    try {
      await deliverPeerShareWebhook("https://hooks.example.com", makePayload(), null);
      expect(capturedHeaders["x-pulse-signature"]).toBeUndefined();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// DB-gated tests for peer-share-agg aggregation + runPeerShareHourlyAgg
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("peer-share-agg DB integration", () => {
  const tag = `agg-${Date.now()}`;
  const ownerEmail  = `pulse-agg-owner-${tag}@local`;
  const viewerEmail = `pulse-agg-viewer-${tag}@local`;

  let ownerId  = "";
  let viewerId = "";
  let shareId  = "";

  const nowMs = Date.now();
  const prevHourMs = (nowMs - (nowMs % 3_600_000)) - 3_600_000;
  const bucketStart = new Date(prevHourMs);

  const COST_X = 1500;
  const COST_Y = 2500;
  const TOTAL  = COST_X + COST_Y;

  let db: ReturnType<typeof sql>;

  beforeAll(async () => {
    db = sql();

    const [ownerRow] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${ownerEmail}, ${"agg-owner-" + tag}, ${"agg-owner-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    ownerId = ownerRow.id;

    const [viewerRow] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${viewerEmail}, ${"agg-viewer-" + tag}, ${"agg-viewer-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    viewerId = viewerRow.id;

    const [shareRow] = await db<{ id: string }[]>`
      INSERT INTO peer_share (owner_id, viewer_id, scope_type, scope_value, granularity, fields)
      VALUES (
        ${ownerId}::uuid, ${viewerId}::uuid,
        'all', NULL, 'realtime',
        ARRAY['ts','source','model','tokens_input','tokens_output','cost_millicents']
      )
      RETURNING id::text AS id
    `;
    shareId = shareRow.id;

    // Seed events inside the previous full-hour bucket.
    const eventTs = new Date(prevHourMs + 60_000).toISOString();
    await db`
      INSERT INTO activity_event
        (user_id, source, model, tokens_input, tokens_output, cost_millicents, ts)
      VALUES
        (${ownerId}::uuid, 'ashlr', 'claude-sonnet-4-5', 80, 160, ${COST_X}, ${eventTs}::timestamptz),
        (${ownerId}::uuid, 'ashlr', 'claude-haiku-4-5',  40,  80, ${COST_Y}, ${eventTs}::timestamptz)
    `;
  });

  afterAll(async () => {
    await db`DELETE FROM peer_share_hourly_aggregate WHERE owner_id = ${ownerId}::uuid`;
    await db`DELETE FROM activity_event WHERE user_id = ${ownerId}::uuid`;
    await db`DELETE FROM peer_share WHERE id = ${shareId}`;
    await db`DELETE FROM "user" WHERE id IN (${ownerId}::uuid, ${viewerId}::uuid)`;
  });

  test("aggregatePastHour returns correct totals for active grant", async () => {
    const rows = await aggregatePastHour(ownerId, viewerId, bucketStart);
    const totalCost = rows.reduce((s, r) => s + r.cost_millicents, 0);
    const totalEvents = rows.reduce((s, r) => s + r.event_count, 0);
    expect(totalCost).toBe(TOTAL);
    expect(totalEvents).toBe(2);
  });

  test("aggregatePastHour returns empty for revoked grant", async () => {
    await db`UPDATE peer_share SET revoked_at = NOW() WHERE id = ${shareId}`;
    const rows = await aggregatePastHour(ownerId, viewerId, bucketStart);
    expect(rows).toHaveLength(0);
    await db`UPDATE peer_share SET revoked_at = NULL WHERE id = ${shareId}`;
  });

  test("upsertHourlyAggregate writes rows and is idempotent", async () => {
    const aggRows = await aggregatePastHour(ownerId, viewerId, bucketStart);
    const n1 = await upsertHourlyAggregate(shareId, ownerId, viewerId, bucketStart, aggRows);
    expect(n1).toBeGreaterThan(0);

    // Second upsert — idempotent
    const n2 = await upsertHourlyAggregate(shareId, ownerId, viewerId, bucketStart, aggRows);
    expect(n2).toBeGreaterThan(0);

    const rows = await db<{ total_cost: number; total_events: number }[]>`
      SELECT
        SUM(cost_millicents)::bigint AS total_cost,
        SUM(event_count)::int        AS total_events
      FROM peer_share_hourly_aggregate
      WHERE owner_id   = ${ownerId}::uuid
        AND viewer_id  = ${viewerId}::uuid
        AND hour_bucket = ${bucketStart.toISOString()}::timestamptz
    `;
    // Must not double-count after two upserts.
    expect(Math.abs(Number(rows[0]?.total_cost ?? 0) - TOTAL)).toBeLessThanOrEqual(1);
    expect(Number(rows[0]?.total_events ?? 0)).toBe(2);
  });

  test("runPeerShareHourlyAgg processes the active pair and skips revoked", async () => {
    // Clean up previous upserts so counts are deterministic.
    await db`DELETE FROM peer_share_hourly_aggregate WHERE owner_id = ${ownerId}::uuid`;

    const result = await runPeerShareHourlyAgg("test-secret");
    expect(result.pairs).toBeGreaterThanOrEqual(1);
    // Rows should have been written for the active pair.
    expect(result.rowsUpserted).toBeGreaterThan(0);
    // No webhook URL configured → webhooks_sent should be 0.
    expect(result.webhooksSent).toBe(0);

    // Revoke and re-run — revoked pair should not produce aggregate rows.
    await db`UPDATE peer_share SET revoked_at = NOW() WHERE id = ${shareId}`;
    await db`DELETE FROM peer_share_hourly_aggregate WHERE owner_id = ${ownerId}::uuid`;

    const result2 = await runPeerShareHourlyAgg("test-secret");
    const check = await db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM peer_share_hourly_aggregate
      WHERE owner_id  = ${ownerId}::uuid
        AND viewer_id = ${viewerId}::uuid
        AND (cost_millicents > 0 OR event_count > 0)
    `;
    expect(Number(check[0]?.n ?? 0)).toBe(0);

    // Restore for afterAll cleanup.
    await db`UPDATE peer_share SET revoked_at = NULL WHERE id = ${shareId}`;
  });

  test("runPeerShareHourlyAgg webhook fires when cost > 0 and URL configured", async () => {
    // Patch org with a webhook URL via org table.
    // First ensure owner has an org (or create one).
    let orgId: string | null = null;
    const orgRows = await db<{ org_id: string }[]>`
      SELECT org_id::text FROM membership WHERE user_id = ${ownerId}::uuid LIMIT 1
    `;
    if (orgRows.length > 0) {
      orgId = orgRows[0].org_id;
    } else {
      const [newOrg] = await db<{ id: string }[]>`
        INSERT INTO org (name, slug, plan)
        VALUES (${"test-org-" + tag}, ${"test-org-slug-" + tag}, 'pro')
        RETURNING id::text AS id
      `;
      orgId = newOrg.id;
      await db`
        INSERT INTO membership (org_id, user_id, role)
        VALUES (${orgId}::uuid, ${ownerId}::uuid, 'owner')
      `;
    }

    // Set the webhook URL.
    await db`
      UPDATE org SET peer_share_webhook_url = ${"https://hooks.test.example.com/ps"}
      WHERE id = ${orgId}::uuid
    `;

    // Mock fetch to capture webhook call (cast avoids Bun preconnect type requirement).
    let webhookCalled = false;
    let capturedBody: unknown = null;
    const origFetch = globalThis.fetch;
    const mockImpl = async (_url: URL | RequestInfo, init?: RequestInit) => {
      webhookCalled = true;
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response("{}", { status: 200 });
    };
    (globalThis as Record<string, unknown>).fetch = Object.assign(mockImpl, origFetch);

    await db`DELETE FROM peer_share_hourly_aggregate WHERE owner_id = ${ownerId}::uuid`;

    try {
      const result = await runPeerShareHourlyAgg("test-secret");
      // The pair has cost > 0 and a webhook URL — webhook should have fired.
      expect(result.webhooksSent).toBeGreaterThanOrEqual(1);
      expect(webhookCalled).toBe(true);

      if (capturedBody && typeof capturedBody === "object") {
        const body = capturedBody as Record<string, unknown>;
        expect(body.event).toBe("peer_share_activity");
        // PRIVACY: repo_name must not appear (not in grant.fields).
        expect(body.repo_name).toBeUndefined();
      }
    } finally {
      globalThis.fetch = origFetch;
      // Clean up webhook URL.
      await db`UPDATE org SET peer_share_webhook_url = NULL WHERE id = ${orgId}::uuid`;
    }
  });
});
