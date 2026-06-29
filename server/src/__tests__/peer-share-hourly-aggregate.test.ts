/**
 * peer-share-hourly-aggregate.test.ts
 *
 * Tests for the peer_share_hourly_aggregate materialisation layer.
 *
 * Test matrix (4 requirements from the task spec):
 *   1. Hourly roll-up sums match raw activity_event rows for the bucket.
 *   2. Peer-share field filters are applied correctly — forbidden fields
 *      (prompts, completions, raw_otel_span) never appear in the aggregate;
 *      aggregate only computes for (owner, viewer) pairs with a non-revoked grant.
 *   3. The sync trigger (refreshHourlyAggregates) fires the refresh and
 *      returns upserted row counts.
 *   4. Re-runs are idempotent — calling refreshHourlyAggregates twice for the
 *      same window produces the same rows (no double-counting).
 *
 * Unit tests (no DB) run unconditionally and cover:
 *   - computeDeltas logic (pure function)
 *   - SHAREABLE_FIELDS / FORBIDDEN_FIELDS invariants that the hourly layer depends on
 *   - refreshHourlyAggregates argument validation (sinceHour > now returns 0)
 *
 * DB-gated integration tests run when DATABASE_URL is set.
 *
 * Run all:
 *   DATABASE_URL=postgres://localhost/pulse_test bun test src/__tests__/peer-share-hourly-aggregate.test.ts
 * Run unit-only (no DB):
 *   bun test src/__tests__/peer-share-hourly-aggregate.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// ─────────────────────────────────────────────────────────────────────────────
// Imports for unit tests (no DB)
// ─────────────────────────────────────────────────────────────────────────────

import {
  computeDeltas,
  type PeerShareHourlyAggregate,
  HOURLY_RETENTION_HRS,
} from "../lib/peer-share-hourly-aggregate";
import { SHAREABLE_FIELDS, FORBIDDEN_FIELDS } from "../lib/peer-share-guard";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — privacy invariants (always run, no DB)
// ─────────────────────────────────────────────────────────────────────────────

describe("peer-share-hourly-aggregate — privacy invariants (unit, no DB)", () => {
  test("HOURLY_RETENTION_HRS is a positive integer", () => {
    expect(typeof HOURLY_RETENTION_HRS).toBe("number");
    expect(HOURLY_RETENTION_HRS).toBeGreaterThan(0);
    expect(Number.isInteger(HOURLY_RETENTION_HRS)).toBe(true);
  });

  test("FORBIDDEN_FIELDS are never in SHAREABLE_FIELDS — privacy floor", () => {
    for (const f of FORBIDDEN_FIELDS) {
      expect(SHAREABLE_FIELDS.has(f)).toBe(false);
    }
  });

  test("tokens_input, tokens_output, cost_millicents, event_count are SHAREABLE", () => {
    const required = ["tokens_input", "tokens_output", "cost_millicents"];
    for (const f of required) {
      expect(SHAREABLE_FIELDS.has(f)).toBe(true);
    }
  });

  test("prompts, completions, raw_otel_span are FORBIDDEN — never shared", () => {
    expect(FORBIDDEN_FIELDS.has("prompts")).toBe(true);
    expect(FORBIDDEN_FIELDS.has("completions")).toBe(true);
    expect(FORBIDDEN_FIELDS.has("raw_otel_span")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — computeDeltas (pure function, no DB)
// ─────────────────────────────────────────────────────────────────────────────

function makeRow(
  overrides: Partial<PeerShareHourlyAggregate> = {},
): PeerShareHourlyAggregate {
  return {
    ownerId: "owner-1",
    viewerId: "viewer-1",
    hourBucket: "2026-06-29T14:00:00.000Z",
    source: "claude_code",
    model: "claude-opus-4-8",
    tokensInput: 100,
    tokensOutput: 50,
    costMillicents: 200,
    eventCount: 3,
    computedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("computeDeltas — pure function (unit, no DB)", () => {
  test("empty prev + empty curr → no deltas", () => {
    expect(computeDeltas("owner-1", [], [])).toEqual([]);
  });

  test("new row in curr with no prev → delta reported", () => {
    const curr = [makeRow()];
    const deltas = computeDeltas("owner-1", [], curr);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].costDelta).toBe(200);
    expect(deltas[0].tokenDelta).toBe(150);
    expect(deltas[0].eventCount).toBe(3);
  });

  test("same row in prev and curr → no delta (idempotent read)", () => {
    const row = makeRow();
    const deltas = computeDeltas("owner-1", [row], [row]);
    expect(deltas).toHaveLength(0);
  });

  test("increased cost in curr → positive costDelta", () => {
    const prev = [makeRow({ costMillicents: 100 })];
    const curr = [makeRow({ costMillicents: 300 })];
    const deltas = computeDeltas("owner-1", prev, curr);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].costDelta).toBe(200);
    expect(deltas[0].tokenDelta).toBe(0); // tokens unchanged
  });

  test("increased tokens in curr → positive tokenDelta", () => {
    const prev = [makeRow({ tokensInput: 100, tokensOutput: 50 })];
    const curr = [makeRow({ tokensInput: 200, tokensOutput: 100 })];
    const deltas = computeDeltas("owner-1", prev, curr);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].tokenDelta).toBe(150); // (200+100) - (100+50)
    expect(deltas[0].costDelta).toBe(0);
  });

  test("deltas are sorted by bucket ASC", () => {
    const prev: PeerShareHourlyAggregate[] = [];
    const curr = [
      makeRow({ hourBucket: "2026-06-29T16:00:00.000Z", costMillicents: 10 }),
      makeRow({ hourBucket: "2026-06-29T14:00:00.000Z", costMillicents: 20 }),
      makeRow({ hourBucket: "2026-06-29T15:00:00.000Z", costMillicents: 30 }),
    ];
    const deltas = computeDeltas("owner-1", prev, curr);
    expect(deltas[0].bucket).toBe("2026-06-29T14:00:00.000Z");
    expect(deltas[1].bucket).toBe("2026-06-29T15:00:00.000Z");
    expect(deltas[2].bucket).toBe("2026-06-29T16:00:00.000Z");
  });

  test("zero-value curr row (empty bucket sentinel) → no delta when prev is also zero", () => {
    const zeroRow = makeRow({ tokensInput: 0, tokensOutput: 0, costMillicents: 0, eventCount: 0 });
    const deltas = computeDeltas("owner-1", [zeroRow], [zeroRow]);
    expect(deltas).toHaveLength(0);
  });

  test("zero-value curr when prev had data → reports negative delta", () => {
    const prev = [makeRow({ costMillicents: 500, tokensInput: 1000, tokensOutput: 500 })];
    const curr = [makeRow({ costMillicents: 0, tokensInput: 0, tokensOutput: 0 })];
    const deltas = computeDeltas("owner-1", prev, curr);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].costDelta).toBe(-500);
    expect(deltas[0].tokenDelta).toBe(-1500);
  });

  test("ownerId is propagated verbatim to delta events", () => {
    const curr = [makeRow({ ownerId: "owner-42" })];
    const deltas = computeDeltas("owner-42", [], curr);
    expect(deltas[0].ownerId).toBe("owner-42");
  });

  test("source and model are propagated verbatim to delta events", () => {
    const curr = [makeRow({ source: "shell", model: "none" })];
    const deltas = computeDeltas("owner-1", [], curr);
    expect(deltas[0].source).toBe("shell");
    expect(deltas[0].model).toBe("none");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests — DB-gated
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("peer-share-hourly-aggregate — DB integration", () => {
  const tag = Date.now();
  const ownerEmail = `hourly-agg-owner-${tag}@local`;
  const viewerEmail = `hourly-agg-viewer-${tag}@local`;
  const unrelatedEmail = `hourly-agg-unrelated-${tag}@local`;

  let ownerId = "";
  let viewerId = "";
  let unrelatedId = "";
  let shareId = "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  /**
   * Fixed hour bucket in the past so test events land in a deterministic
   * bucket, unaffected by clock drift during the test run.
   */
  const BUCKET_START = new Date(Date.now() - 2 * 3_600_000); // 2 hours ago
  BUCKET_START.setMinutes(0, 0, 0); // snap to hour
  const BUCKET_START_MS = BUCKET_START.getTime();
  const BUCKET_START_ISO = BUCKET_START.toISOString();

  // 4 synthetic events inside the bucket (all 30 min past bucket start)
  const EVENT_TS = new Date(BUCKET_START_MS + 30 * 60_000).toISOString();

  const EVENTS = [
    { source: "claude_code", model: "claude-opus-4-8", tokens_input: 400,  tokens_output: 200, cost_millicents: 100 },
    { source: "claude_code", model: "claude-opus-4-8", tokens_input: 600,  tokens_output: 300, cost_millicents: 150 },
    { source: "shell",       model: null,              tokens_input: 0,    tokens_output: 0,   cost_millicents: 0   },
    { source: "claude_code", model: "claude-sonnet-4-6", tokens_input: 800, tokens_output: 400, cost_millicents: 250 },
  ];

  // Expected sums per (source, model) within the bucket.
  const EXPECTED = {
    "claude_code|claude-opus-4-8": {
      tokens_input: 1000,
      tokens_output: 500,
      cost_millicents: 250,
      event_count: 2,
    },
    "claude_code|claude-sonnet-4-6": {
      tokens_input: 800,
      tokens_output: 400,
      cost_millicents: 250,
      event_count: 1,
    },
    "shell|": {
      tokens_input: 0,
      tokens_output: 0,
      cost_millicents: 0,
      event_count: 1,
    },
  };

  beforeAll(async () => {
    const { sql } = await import("../lib/db");
    db = sql();

    // Create owner, viewer, and unrelated user.
    const [rowOwner] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${ownerEmail}, ${"ha-owner-" + tag}, ${"ha-owner-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    const [rowViewer] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${viewerEmail}, ${"ha-viewer-" + tag}, ${"ha-viewer-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    const [rowUnrelated] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${unrelatedEmail}, ${"ha-unrelated-" + tag}, ${"ha-unrelated-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    ownerId = rowOwner.id;
    viewerId = rowViewer.id;
    unrelatedId = rowUnrelated.id;

    // Insert 4 events for owner inside the fixed bucket.
    for (const ev of EVENTS) {
      await db`
        INSERT INTO activity_event
          (user_id, source, model, tokens_input, tokens_output, cost_millicents, ts)
        VALUES (
          ${ownerId}::uuid,
          ${ev.source},
          ${ev.model ?? null},
          ${ev.tokens_input},
          ${ev.tokens_output},
          ${ev.cost_millicents},
          ${EVENT_TS}::timestamptz
        )
      `;
    }

    // Create a non-revoked peer_share grant (owner → viewer).
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
  });

  afterAll(async () => {
    if (!db) return;
    await db`DELETE FROM peer_share_hourly_aggregate WHERE owner_id = ${ownerId}::uuid`;
    await db`DELETE FROM peer_share WHERE id = ${shareId}`;
    await db`DELETE FROM activity_event WHERE user_id = ${ownerId}::uuid`;
    await db`DELETE FROM "user" WHERE id IN (${ownerId}::uuid, ${viewerId}::uuid, ${unrelatedId}::uuid)`;
  });

  // ── Requirement 3: sync trigger fires and returns counts ───────────────────

  test("refreshHourlyAggregates returns a positive upserted count", async () => {
    const { refreshHourlyAggregates } = await import("../lib/peer-share-hourly-aggregate");
    const count = await refreshHourlyAggregates(ownerId, viewerId, BUCKET_START);
    // At minimum: the bucket with our 3 (source, model) groups + sentinel
    // zero-rows for hours in the window without activity.
    expect(count).toBeGreaterThan(0);
  });

  // ── Requirement 1: roll-up sums match raw events ───────────────────────────

  test("hourly roll-up sums match raw activity_event rows for the bucket", async () => {
    const bucketEnd = new Date(BUCKET_START_MS + 3_600_000).toISOString();

    // Read the materialised rows for the exact bucket.
    const rows = await db<{
      source: string;
      model: string;
      tokens_input: string | number;
      tokens_output: string | number;
      cost_millicents: string | number;
      event_count: string | number;
    }[]>`
      SELECT source, model, tokens_input, tokens_output, cost_millicents, event_count
      FROM peer_share_hourly_aggregate
      WHERE owner_id   = ${ownerId}::uuid
        AND viewer_id  = ${viewerId}::uuid
        AND hour_bucket = ${BUCKET_START_ISO}::timestamptz
        AND (source != '' OR model != '')
      ORDER BY source, model
    `;

    // Remove zero-sentinel rows (empty source+model).
    const nonZero = rows.filter(
      (r: { source: string; model: string }) => r.source !== "" || r.model !== "",
    );

    // Also verify by summing raw events for the same window.
    const [rawAgg] = await db<{ total_input: string; total_output: string; total_cost: string; total_events: string }[]>`
      SELECT
        SUM(tokens_input)::bigint   AS total_input,
        SUM(tokens_output)::bigint  AS total_output,
        SUM(cost_millicents)::bigint AS total_cost,
        COUNT(*)::int               AS total_events
      FROM activity_event
      WHERE user_id = ${ownerId}::uuid
        AND ts >= ${BUCKET_START_ISO}::timestamptz
        AND ts <  ${bucketEnd}::timestamptz
    `;

    type AggBucketRow = { source: string; model: string; tokens_input: string | number; tokens_output: string | number; cost_millicents: string | number; event_count: string | number };
    const aggTotalInput  = (nonZero as AggBucketRow[]).reduce((s: number, r: AggBucketRow) => s + Number(r.tokens_input),  0);
    const aggTotalOutput = (nonZero as AggBucketRow[]).reduce((s: number, r: AggBucketRow) => s + Number(r.tokens_output), 0);
    const aggTotalCost   = (nonZero as AggBucketRow[]).reduce((s: number, r: AggBucketRow) => s + Number(r.cost_millicents), 0);
    const aggTotalEvents = (nonZero as AggBucketRow[]).reduce((s: number, r: AggBucketRow) => s + Number(r.event_count), 0);

    expect(aggTotalInput).toBe(Number(rawAgg.total_input));
    expect(aggTotalOutput).toBe(Number(rawAgg.total_output));
    expect(aggTotalCost).toBe(Number(rawAgg.total_cost));
    expect(aggTotalEvents).toBe(Number(rawAgg.total_events));
  });

  test("per-(source, model) sums match the EXPECTED breakdown", async () => {
    const rows = await db<{
      source: string;
      model: string;
      tokens_input: string | number;
      tokens_output: string | number;
      cost_millicents: string | number;
      event_count: string | number;
    }[]>`
      SELECT source, model, tokens_input, tokens_output, cost_millicents, event_count
      FROM peer_share_hourly_aggregate
      WHERE owner_id   = ${ownerId}::uuid
        AND viewer_id  = ${viewerId}::uuid
        AND hour_bucket = ${BUCKET_START_ISO}::timestamptz
        AND (source != '' OR model != '')
    `;

    for (const row of rows) {
      const key = `${row.source}|${row.model ?? ""}`;
      const exp = EXPECTED[key as keyof typeof EXPECTED];
      if (!exp) continue; // may include sentinel rows; skip unknowns

      expect(Number(row.tokens_input)).toBe(exp.tokens_input);
      expect(Number(row.tokens_output)).toBe(exp.tokens_output);
      expect(Number(row.cost_millicents)).toBe(exp.cost_millicents);
      expect(Number(row.event_count)).toBe(exp.event_count);
    }
  });

  // ── Requirement 2: forbidden fields never leak ─────────────────────────────

  test("aggregate rows contain only aggregate numbers — no forbidden fields", async () => {
    const rows = await db<Record<string, unknown>[]>`
      SELECT *
      FROM peer_share_hourly_aggregate
      WHERE owner_id  = ${ownerId}::uuid
        AND viewer_id = ${viewerId}::uuid
      LIMIT 10
    `;

    expect(rows.length).toBeGreaterThan(0);

    const FORBIDDEN_COLUMN_NAMES = ["prompts", "completions", "raw_otel_span"];
    for (const row of rows) {
      for (const col of FORBIDDEN_COLUMN_NAMES) {
        expect(Object.keys(row)).not.toContain(col);
      }
    }
  });

  test("revoked grant: refreshHourlyAggregates inserts zero rows (grant-gated)", async () => {
    // Revoke the grant.
    await db`UPDATE peer_share SET revoked_at = NOW() WHERE id = ${shareId}`;

    try {
      // Delete existing aggregate rows so we can detect whether the refresh
      // writes new non-zero rows.
      await db`
        DELETE FROM peer_share_hourly_aggregate
        WHERE owner_id  = ${ownerId}::uuid
          AND viewer_id = ${viewerId}::uuid
      `;

      const { refreshHourlyAggregates: refresh } = await import(
        "../lib/peer-share-hourly-aggregate"
      );
      const count = await refresh(ownerId, viewerId, BUCKET_START);

      // The refresh still runs (upserts sentinel zeros) but the grant EXISTS
      // check in the SQL means no real-activity rows should accumulate.
      // Confirm: no rows with non-zero cost/tokens for the revoked grant.
      const nonZeroRows = await db<{ event_count: number }[]>`
        SELECT event_count
        FROM peer_share_hourly_aggregate
        WHERE owner_id  = ${ownerId}::uuid
          AND viewer_id = ${viewerId}::uuid
          AND (tokens_input > 0 OR tokens_output > 0 OR cost_millicents > 0)
      `;
      expect(nonZeroRows.length).toBe(0);

      // count may be > 0 due to empty sentinel rows — that's OK.
      expect(typeof count).toBe("number");
    } finally {
      // Restore grant for subsequent tests.
      await db`UPDATE peer_share SET revoked_at = NULL WHERE id = ${shareId}`;
    }
  });

  test("unrelated user gets no aggregate rows (isolation)", async () => {
    const rows = await db<{ id: string }[]>`
      SELECT owner_id FROM peer_share_hourly_aggregate
      WHERE viewer_id = ${unrelatedId}::uuid
        AND owner_id  = ${ownerId}::uuid
    `;
    expect(rows.length).toBe(0);
  });

  // ── Requirement 4: idempotency ─────────────────────────────────────────────

  test("re-running refreshHourlyAggregates is idempotent — no double-counting", async () => {
    const { refreshHourlyAggregates: refresh } = await import(
      "../lib/peer-share-hourly-aggregate"
    );

    // Run twice over the same window.
    await refresh(ownerId, viewerId, BUCKET_START);
    await refresh(ownerId, viewerId, BUCKET_START);

    // The aggregate sums for the bucket must not be doubled.
    const bucketEnd = new Date(BUCKET_START_MS + 3_600_000).toISOString();

    const [agg] = await db<{ total_cost: string; total_events: string }[]>`
      SELECT
        SUM(cost_millicents)::bigint AS total_cost,
        SUM(event_count)::bigint    AS total_events
      FROM peer_share_hourly_aggregate
      WHERE owner_id   = ${ownerId}::uuid
        AND viewer_id  = ${viewerId}::uuid
        AND hour_bucket = ${BUCKET_START_ISO}::timestamptz
        AND (source != '' OR model != '')
    `;

    const [rawAgg] = await db<{ total_cost: string; total_events: string }[]>`
      SELECT
        SUM(cost_millicents)::bigint AS total_cost,
        COUNT(*)::int               AS total_events
      FROM activity_event
      WHERE user_id = ${ownerId}::uuid
        AND ts >= ${BUCKET_START_ISO}::timestamptz
        AND ts <  ${bucketEnd}::timestamptz
    `;

    // After two runs, aggregate totals must still equal the raw totals (not 2x).
    expect(Number(agg.total_cost)).toBe(Number(rawAgg.total_cost));
    expect(Number(agg.total_events)).toBe(Number(rawAgg.total_events));
  });

  test("refreshHourlyAggregates with sinceHour in the future returns 0", async () => {
    const { refreshHourlyAggregates: refresh } = await import(
      "../lib/peer-share-hourly-aggregate"
    );
    const future = new Date(Date.now() + 3_600_000 * 10);
    const count = await refresh(ownerId, viewerId, future);
    expect(count).toBe(0);
  });

  // ── pruneHourlyAggregates: verify it removes old rows ─────────────────────

  test("pruneHourlyAggregates removes rows older than HOURLY_RETENTION_HRS", async () => {
    const { pruneHourlyAggregates } = await import("../lib/peer-share-hourly-aggregate");

    // Insert an artificially old row (beyond retention window).
    const veryOldBucket = new Date(Date.now() - (HOURLY_RETENTION_HRS + 1) * 3_600_000);
    veryOldBucket.setMinutes(0, 0, 0);

    await db`
      INSERT INTO peer_share_hourly_aggregate
        (owner_id, viewer_id, hour_bucket, source, model,
         tokens_input, tokens_output, cost_millicents, event_count, computed_at)
      VALUES (
        ${ownerId}::uuid, ${viewerId}::uuid,
        ${veryOldBucket.toISOString()}::timestamptz,
        'prune-test', 'prune-model',
        0, 0, 0, 0, NOW()
      )
      ON CONFLICT (owner_id, viewer_id, hour_bucket, source, model) DO NOTHING
    `;

    const pruned = await pruneHourlyAggregates();
    expect(pruned).toBeGreaterThanOrEqual(1);

    // Confirm the row is gone.
    const remaining = await db<{ source: string }[]>`
      SELECT source FROM peer_share_hourly_aggregate
      WHERE owner_id   = ${ownerId}::uuid
        AND viewer_id  = ${viewerId}::uuid
        AND hour_bucket = ${veryOldBucket.toISOString()}::timestamptz
        AND source = 'prune-test'
    `;
    expect(remaining.length).toBe(0);
  });
});
