/**
 * peer-share-aggregate.test.ts — e2e test for peer_share_daily_aggregate.
 *
 * DB-gated (describe.skipIf(!HAS_DB)) following fleet-oversight.test.ts.
 * To run: point DATABASE_URL at a throwaway DB that has had `bun run migrate`
 * applied, then `bun test tests/peer-share-aggregate.test.ts`. E.g.:
 *   createdb pulse_test && DATABASE_URL=postgres://localhost/pulse_test \
 *     bun run migrate && DATABASE_URL=... bun test tests/peer-share-aggregate.test.ts \
 *     ; dropdb pulse_test
 *
 * What this tests:
 *   1. Create two users (owner, viewer) and a peer_share grant between them.
 *   2. Seed two activity_event rows for the owner on yesterday's UTC date.
 *   3. Run refreshPeerShareAggregates() for the pair covering yesterday.
 *   4. Assert an aggregate row exists for (owner, viewer, yesterday).
 *   5. Assert cost_millicents in the aggregate matches the raw sum within
 *      1 millicent (allows for any rounding in the aggregation).
 *   6. Assert event_count matches the number of seeded rows.
 *   7. Assert readPeerShareSummaries() returns the viewer with correct totals.
 *   8. Assert prunePeerShareAggregates() removes rows older than RETENTION_DAYS.
 *   9. Assert revoked grants are excluded from runPeerShareAggregatesCron().
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../src/lib/db";
import {
  refreshPeerShareAggregates,
  runPeerShareAggregatesCron,
  readPeerShareSummaries,
  prunePeerShareAggregates,
  RETENTION_DAYS,
} from "../src/lib/peer-share-aggregate-refresh";

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("peer_share_daily_aggregate", () => {
  const tag = Date.now();
  const ownerEmail  = `pulse-psa-owner-${tag}@local`;
  const viewerEmail = `pulse-psa-viewer-${tag}@local`;

  let ownerId  = "";
  let viewerId = "";
  let shareId  = "";

  // Yesterday UTC as "YYYY-MM-DD"
  const yesterdayUtc = new Date();
  yesterdayUtc.setUTCHours(0, 0, 0, 0);
  yesterdayUtc.setUTCDate(yesterdayUtc.getUTCDate() - 1);
  const yesterday = yesterdayUtc.toISOString().slice(0, 10);

  // Seed: two events for the owner on yesterday
  const COST_A = 1234; // millicents
  const COST_B = 5678; // millicents
  const TOTAL_COST = COST_A + COST_B;

  // db() is called lazily inside tests/hooks to avoid throwing at import time
  // when DATABASE_URL is absent.
  let db: ReturnType<typeof sql>;

  beforeAll(async () => {
    db = sql();
    // Insert owner + viewer users
    const [ownerRow] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${ownerEmail}, ${"psa-owner-" + tag}, ${"psa-owner-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    const [viewerRow] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${viewerEmail}, ${"psa-viewer-" + tag}, ${"psa-viewer-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    ownerId  = ownerRow.id;
    viewerId = viewerRow.id;

    // Create a non-revoked peer_share grant
    const [shareRow] = await db<{ id: string }[]>`
      INSERT INTO peer_share (owner_id, viewer_id, scope_type, scope_value, granularity, fields)
      VALUES (
        ${ownerId}::uuid, ${viewerId}::uuid,
        'all', NULL, 'daily',
        ARRAY['ts','source','model','tokens_input','tokens_output','cost_millicents']
      )
      RETURNING id::text AS id
    `;
    shareId = shareRow.id;

    // Seed two activity_event rows for the owner on yesterday
    const dayTs = `${yesterday}T12:00:00.000Z`;
    await db`
      INSERT INTO activity_event
        (user_id, source, model, tokens_input, tokens_output, cost_millicents, ts)
      VALUES
        (${ownerId}::uuid, 'ashlr', 'claude-3-5-sonnet', 100, 200, ${COST_A}, ${dayTs}::timestamptz),
        (${ownerId}::uuid, 'ashlr', 'claude-3-5-haiku',   50, 100, ${COST_B}, ${dayTs}::timestamptz)
    `;
  });

  afterAll(async () => {
    // Clean up in dependency order
    await db`DELETE FROM peer_share_daily_aggregate WHERE owner_id = ${ownerId}::uuid`;
    await db`DELETE FROM activity_event WHERE user_id = ${ownerId}::uuid`;
    await db`DELETE FROM peer_share WHERE id = ${shareId}`;
    await db`DELETE FROM "user" WHERE id IN (${ownerId}::uuid, ${viewerId}::uuid)`;
  });

  test("refreshPeerShareAggregates inserts an aggregate row for yesterday", async () => {
    const since = new Date(yesterdayUtc);
    const count = await refreshPeerShareAggregates(ownerId, viewerId, since);
    expect(count).toBeGreaterThan(0);

    const rows = await db<{ cost_millicents: number; event_count: number }[]>`
      SELECT
        SUM(cost_millicents)::bigint AS cost_millicents,
        SUM(event_count)::int        AS event_count
      FROM peer_share_daily_aggregate
      WHERE owner_id  = ${ownerId}::uuid
        AND viewer_id = ${viewerId}::uuid
        AND date = ${yesterday}::date
    `;
    expect(rows.length).toBeGreaterThan(0);
    const agg = rows[0];
    expect(agg).toBeDefined();

    // Cost rollup must match raw sum within 1 millicent
    expect(Math.abs(Number(agg.cost_millicents) - TOTAL_COST)).toBeLessThanOrEqual(1);

    // Event count must match seeded rows (2 events)
    expect(Number(agg.event_count)).toBe(2);
  });

  test("aggregate is idempotent — re-running does not double-count", async () => {
    const since = new Date(yesterdayUtc);
    await refreshPeerShareAggregates(ownerId, viewerId, since);
    await refreshPeerShareAggregates(ownerId, viewerId, since);

    const rows = await db<{ cost_millicents: number; event_count: number }[]>`
      SELECT
        SUM(cost_millicents)::bigint AS cost_millicents,
        SUM(event_count)::int        AS event_count
      FROM peer_share_daily_aggregate
      WHERE owner_id  = ${ownerId}::uuid
        AND viewer_id = ${viewerId}::uuid
        AND date = ${yesterday}::date
    `;
    const agg = rows[0];
    expect(Math.abs(Number(agg.cost_millicents) - TOTAL_COST)).toBeLessThanOrEqual(1);
    expect(Number(agg.event_count)).toBe(2);
  });

  test("readPeerShareSummaries returns viewer with correct totals", async () => {
    const summaries = await readPeerShareSummaries(ownerId);
    const match = summaries.find((s) => s.viewerId === viewerId);
    expect(match).toBeDefined();
    expect(match!.viewerEmail).toBe(viewerEmail);
    expect(Math.abs(match!.totalCostMillicents - TOTAL_COST)).toBeLessThanOrEqual(1);
    expect(match!.totalEvents).toBeGreaterThanOrEqual(2);
  });

  test("runPeerShareAggregatesCron processes active pairs", async () => {
    const result = await runPeerShareAggregatesCron();
    expect(result.pairs).toBeGreaterThanOrEqual(1);
    expect(result.rowsUpserted).toBeGreaterThan(0);
  });

  test("runPeerShareAggregatesCron skips revoked grants", async () => {
    // Revoke the grant
    await db`
      UPDATE peer_share SET revoked_at = NOW()
      WHERE id = ${shareId}
    `;

    // Delete existing aggregate rows for this pair so we can detect if new ones appear
    await db`
      DELETE FROM peer_share_daily_aggregate
      WHERE owner_id = ${ownerId}::uuid AND viewer_id = ${viewerId}::uuid
    `;

    const result = await runPeerShareAggregatesCron();

    // Our pair should not be in the processed set (grant is revoked)
    const rows = await db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM peer_share_daily_aggregate
      WHERE owner_id = ${ownerId}::uuid AND viewer_id = ${viewerId}::uuid
    `;
    expect(Number(rows[0]?.n ?? 0)).toBe(0);

    // Restore the grant for cleanup
    await db`
      UPDATE peer_share SET revoked_at = NULL
      WHERE id = ${shareId}
    `;

    // Suppress unused-variable warning — result is checked for shape
    expect(typeof result.pairs).toBe("number");
  });

  test("prunePeerShareAggregates removes rows older than RETENTION_DAYS", async () => {
    // Insert a very old aggregate row (RETENTION_DAYS + 2 days ago)
    const oldDate = new Date();
    oldDate.setUTCDate(oldDate.getUTCDate() - (RETENTION_DAYS + 2));
    const oldDateStr = oldDate.toISOString().slice(0, 10);

    await db`
      INSERT INTO peer_share_daily_aggregate
        (owner_id, viewer_id, date, source, model,
         tokens_input, tokens_output, cost_millicents, event_count, computed_at)
      VALUES (
        ${ownerId}::uuid, ${viewerId}::uuid,
        ${oldDateStr}::date, 'ashlr', 'claude-3-5-sonnet',
        0, 0, 0, 0, NOW()
      )
      ON CONFLICT (owner_id, viewer_id, date, source, model) DO UPDATE SET computed_at = NOW()
    `;

    const pruned = await prunePeerShareAggregates();
    expect(pruned).toBeGreaterThanOrEqual(1);

    const rows = await db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM peer_share_daily_aggregate
      WHERE owner_id = ${ownerId}::uuid
        AND viewer_id = ${viewerId}::uuid
        AND date = ${oldDateStr}::date
    `;
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });
});
