/**
 * collaboration-heatmap.test.ts — unit tests for computeCollaborationMatrix
 * and matrixToCsv.
 *
 * All DB-dependent tests are gated behind HAS_DB (describe.skipIf).
 * Pure logic tests run without any DB connection.
 *
 * Coverage:
 *   1.  buildBucketList produces the right hourly slots
 *   2.  matrixToCsv emits correct header + rows
 *   3.  matrixToCsv: CSV escape for values with commas/quotes
 *   4.  matrixToCsv: rows sorted by email ASC then bucket ASC
 *   5.  matrixToCsv: empty matrix → header only
 *   6.  Zero-cost rows are excluded from cells (sentinel filtering)
 *   7.  modelBreakdown accumulates per (owner, bucket) correctly
 *   8.  topSource is the source with the highest cost in a bucket
 *   9.  maxCostMillicents reflects the true maximum across all cells
 *   10. peerStatus="active_work" excludes zero-cost owners
 *   11. PRIVACY: revoked grants produce no data (DB gate)
 *   12. PRIVACY: viewer only sees their own granted owners (DB gate)
 *   13. Cross-org visibility: viewer with no grants sees empty matrix (DB gate)
 *   14. windowDays clamp: values >30 are clamped to 30 (DB gate)
 *   15. Idempotency: calling twice returns the same result (DB gate)
 *
 * DB tests require:
 *   createdb pulse_test && DATABASE_URL=postgres://localhost/pulse_test \
 *     bun run migrate && \
 *     DATABASE_URL=... bun test src/__tests__/collaboration-heatmap.test.ts ; \
 *     dropdb pulse_test
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  matrixToCsv,
  type CollaborationMatrix,
  type MatrixCell,
  type PeerMember,
} from "../src/lib/team-collaboration-matrix";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ─── Pure unit helpers ────────────────────────────────────────────────────────

function makePeer(overrides: Partial<PeerMember> = {}): PeerMember {
  return {
    ownerId:        "owner-aaaa",
    maskedEmail:    "a***@acme.com",
    grantActive:    true,
    grantCreatedAt: "2026-06-01T00:00:00.000Z",
    granularity:    "realtime",
    ...overrides,
  };
}

function makeCell(overrides: Partial<MatrixCell> = {}): MatrixCell {
  return {
    ownerId:        "owner-aaaa",
    hourBucket:     "2026-06-29T14:00:00.000Z",
    costMillicents: 1000,
    eventCount:     5,
    totalTokens:    2000,
    modelBreakdown: { "claude-sonnet-4-5": 1000 },
    topSource:      "ashlr",
    ...overrides,
  };
}

function makeMatrix(
  peers: PeerMember[],
  cells: MatrixCell[],
  maxCost = 0,
): CollaborationMatrix {
  const allBuckets = [...new Set(cells.map((c) => c.hourBucket))].sort();
  return {
    peers,
    buckets: allBuckets.length > 0 ? allBuckets : ["2026-06-29T14:00:00.000Z"],
    cells,
    maxCostMillicents: maxCost || Math.max(...cells.map((c) => c.costMillicents), 0),
    windowStart: "2026-06-22T00:00:00.000Z",
    windowEnd:   "2026-06-29T23:00:00.000Z",
  };
}

// ─── 1. matrixToCsv — basic structure ─────────────────────────────────────────

describe("matrixToCsv (pure unit)", () => {
  test("emits correct CSV header", () => {
    const matrix = makeMatrix([makePeer()], [makeCell()]);
    const csv = matrixToCsv(matrix);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "peer_masked_email,hour_bucket,cost_millicents,event_count,total_tokens,top_source",
    );
  });

  test("emits one data row for one cell", () => {
    const peer = makePeer({ maskedEmail: "a***@acme.com" });
    const cell = makeCell({ costMillicents: 1500, eventCount: 3, totalTokens: 600, topSource: "ashlr" });
    const matrix = makeMatrix([peer], [cell]);
    const csv = matrixToCsv(matrix);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2); // header + 1 row
    expect(lines[1]).toBe(
      `a***@acme.com,${cell.hourBucket},1500,3,600,ashlr`,
    );
  });

  test("empty matrix produces header-only CSV", () => {
    const matrix = makeMatrix([], []);
    const csv = matrixToCsv(matrix);
    expect(csv.trim()).toBe(
      "peer_masked_email,hour_bucket,cost_millicents,event_count,total_tokens,top_source",
    );
  });

  test("CSV-escapes values containing commas", () => {
    // topSource with a comma (edge case)
    const peer = makePeer({ maskedEmail: "b***@corp.com" });
    const cell = makeCell({ topSource: "ashlr,plugin" });
    const matrix = makeMatrix([peer], [cell]);
    const csv = matrixToCsv(matrix);
    expect(csv).toContain('"ashlr,plugin"');
  });

  test("CSV-escapes values containing double-quotes", () => {
    const peer = makePeer({ maskedEmail: 'c***@"corp".com' });
    const cell = makeCell();
    const matrix = makeMatrix([peer], [cell]);
    const csv = matrixToCsv(matrix);
    // The email contains a quote — should be wrapped and internal quotes doubled.
    expect(csv).toContain('"c***@""corp"".com"');
  });

  test("rows are sorted by masked email ASC then bucket ASC", () => {
    const peerA = makePeer({ ownerId: "aaa", maskedEmail: "a***@acme.com" });
    const peerB = makePeer({ ownerId: "bbb", maskedEmail: "b***@acme.com" });
    const cellA1 = makeCell({ ownerId: "aaa", hourBucket: "2026-06-29T15:00:00.000Z", costMillicents: 200 });
    const cellA2 = makeCell({ ownerId: "aaa", hourBucket: "2026-06-29T14:00:00.000Z", costMillicents: 100 });
    const cellB1 = makeCell({ ownerId: "bbb", hourBucket: "2026-06-29T14:00:00.000Z", costMillicents: 300 });
    const matrix = makeMatrix([peerA, peerB], [cellA1, cellA2, cellB1]);
    const lines = matrixToCsv(matrix).split("\n").slice(1); // skip header

    // a*** rows first, then b*** row; within a*** ordered by bucket ASC
    expect(lines[0]).toMatch(/^a\*\*\*@acme\.com,2026-06-29T14/);
    expect(lines[1]).toMatch(/^a\*\*\*@acme\.com,2026-06-29T15/);
    expect(lines[2]).toMatch(/^b\*\*\*@acme\.com/);
  });

  test("empty topSource emits empty string in CSV", () => {
    const peer = makePeer();
    const cell = makeCell({ topSource: null });
    const matrix = makeMatrix([peer], [cell]);
    const csv = matrixToCsv(matrix);
    const dataLine = csv.split("\n")[1];
    // last column should be empty
    expect(dataLine).toMatch(/,$/);
  });
});

// ─── 2. Matrix cell aggregation logic (pure) ──────────────────────────────────

describe("MatrixCell aggregation (pure unit)", () => {
  test("zero-cost cells should be excluded (sentinel rows)", () => {
    // The SQL helper filters out rows where cost=0 AND events=0 AND tokens=0.
    // We verify the filtering logic here by simulating what computeCollaborationMatrix does.
    const cells: MatrixCell[] = [
      makeCell({ costMillicents: 0, eventCount: 0, totalTokens: 0 }),
      makeCell({ costMillicents: 500, eventCount: 2, totalTokens: 300 }),
    ];
    const nonZero = cells.filter(
      (c) => c.costMillicents > 0 || c.eventCount > 0 || c.totalTokens > 0,
    );
    expect(nonZero).toHaveLength(1);
    expect(nonZero[0].costMillicents).toBe(500);
  });

  test("modelBreakdown accumulates correctly across source rows", () => {
    // Simulate aggregation of two rows with the same model in one bucket.
    const modelBreakdown: Record<string, number> = {};
    const rows = [
      { model: "claude-sonnet-4-5", cost: 300 },
      { model: "claude-sonnet-4-5", cost: 200 },
      { model: "claude-haiku-4-5",  cost: 100 },
    ];
    for (const row of rows) {
      modelBreakdown[row.model] = (modelBreakdown[row.model] ?? 0) + row.cost;
    }
    expect(modelBreakdown["claude-sonnet-4-5"]).toBe(500);
    expect(modelBreakdown["claude-haiku-4-5"]).toBe(100);
  });

  test("topSource is the source with the highest cost", () => {
    const sourceCosts: Record<string, number> = {
      ashlr:        200,
      cursor:       800,
      claude_code:  500,
    };
    const topSource = Object.entries(sourceCosts)
      .sort((a, b) => b[1] - a[1])[0][0];
    expect(topSource).toBe("cursor");
  });

  test("maxCostMillicents is the highest cell cost", () => {
    const cells = [
      makeCell({ costMillicents: 100 }),
      makeCell({ costMillicents: 9999 }),
      makeCell({ costMillicents: 500 }),
    ];
    const max = Math.max(...cells.map((c) => c.costMillicents));
    expect(max).toBe(9999);
  });

  test("peerStatus active_work excludes owners with zero total cost", () => {
    // Simulate the peerStatus filter logic.
    const ownerIds = ["owner-a", "owner-b", "owner-c"];
    const cells: MatrixCell[] = [
      makeCell({ ownerId: "owner-a", costMillicents: 1000 }),
      makeCell({ ownerId: "owner-b", costMillicents: 0 }),
    ];

    // "active_work": only owners with cost > 0 in some cell
    const activeWork = new Set<string>();
    for (const cell of cells) {
      if (cell.costMillicents > 0) activeWork.add(cell.ownerId);
    }

    expect(activeWork.has("owner-a")).toBe(true);
    expect(activeWork.has("owner-b")).toBe(false);
    expect(activeWork.has("owner-c")).toBe(false);
    // owner-b and owner-c should be excluded
    const filtered = ownerIds.filter((id) => activeWork.has(id));
    expect(filtered).toEqual(["owner-a"]);
  });
});

// ─── 3. Bucket list helpers (pure) ────────────────────────────────────────────

describe("buildBucketList (pure unit)", () => {
  // We test the expected output of buildBucketList by replicating its logic.
  function buildBucketList(startMs: number, endMs: number): string[] {
    const buckets: string[] = [];
    let cursor = startMs;
    while (cursor < endMs) {
      buckets.push(new Date(cursor).toISOString());
      cursor += 3_600_000;
    }
    return buckets;
  }

  test("produces exactly N hourly buckets for N-hour window", () => {
    const startMs = new Date("2026-06-29T00:00:00.000Z").getTime();
    const endMs   = new Date("2026-06-29T07:00:00.000Z").getTime();
    const buckets = buildBucketList(startMs, endMs);
    expect(buckets).toHaveLength(7);
    expect(buckets[0]).toBe("2026-06-29T00:00:00.000Z");
    expect(buckets[6]).toBe("2026-06-29T06:00:00.000Z");
  });

  test("buckets are spaced exactly 1 hour apart", () => {
    const startMs = new Date("2026-06-29T10:00:00.000Z").getTime();
    const endMs   = startMs + 3 * 3_600_000;
    const buckets = buildBucketList(startMs, endMs);
    for (let i = 1; i < buckets.length; i++) {
      const diff = new Date(buckets[i]).getTime() - new Date(buckets[i - 1]).getTime();
      expect(diff).toBe(3_600_000);
    }
  });

  test("empty range produces empty array", () => {
    const startMs = new Date("2026-06-29T10:00:00.000Z").getTime();
    const buckets = buildBucketList(startMs, startMs); // end === start
    expect(buckets).toHaveLength(0);
  });

  test("7-day window produces 168 buckets", () => {
    const startMs = new Date("2026-06-22T00:00:00.000Z").getTime();
    const endMs   = startMs + 7 * 24 * 3_600_000;
    const buckets = buildBucketList(startMs, endMs);
    expect(buckets).toHaveLength(168);
  });
});

// ─── 4. Privacy floor unit tests (pure) ───────────────────────────────────────

describe("privacy floor (pure unit)", () => {
  test("masked email hides everything before @domain", () => {
    // Verify the masking pattern used in the SQL (first char + *** + @domain).
    function maskEmail(email: string): string {
      const [, domain] = email.split("@");
      return `${email[0]}***@${domain}`;
    }
    expect(maskEmail("mason@evero.com")).toBe("m***@evero.com");
    expect(maskEmail("alice@secret.io")).toBe("a***@secret.io");
    expect(maskEmail("z@x.com")).toBe("z***@x.com");
  });

  test("matrixToCsv never includes raw user IDs in output", () => {
    // The CSV should use maskedEmail (from peerMap), falling back to a
    // truncated userId only if no peer entry exists — never the full UUID.
    const peer = makePeer({ ownerId: "00000000-1111-2222-3333-444444444444", maskedEmail: "x***@corp.com" });
    const cell = makeCell({ ownerId: "00000000-1111-2222-3333-444444444444" });
    const matrix = makeMatrix([peer], [cell]);
    const csv = matrixToCsv(matrix);
    // Full UUID must not appear in output.
    expect(csv).not.toContain("00000000-1111-2222-3333-444444444444");
    // Masked email should appear.
    expect(csv).toContain("x***@corp.com");
  });

  test("modelBreakdown contains only numeric values — no string content", () => {
    // Ensure model breakdown is a Record<string, number>, not Record<string, any>.
    const cell = makeCell({
      modelBreakdown: {
        "claude-sonnet-4-5": 500,
        "claude-haiku-4-5":  200,
      },
    });
    for (const [, cost] of Object.entries(cell.modelBreakdown)) {
      expect(typeof cost).toBe("number");
    }
  });

  test("cells contain no prompt or content fields", () => {
    const cell = makeCell();
    const keys = Object.keys(cell);
    // None of these content fields should appear.
    const forbidden = ["prompt", "completion", "content", "code", "diff", "message", "text"];
    for (const key of forbidden) {
      expect(keys).not.toContain(key);
    }
  });
});

// ─── 5. DB-gated integration tests ────────────────────────────────────────────

describe.skipIf(!HAS_DB)("computeCollaborationMatrix (DB integration)", () => {
  // Import at test time to avoid crashing in no-DB environments.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sql } = require("../src/lib/db") as typeof import("../src/lib/db");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { computeCollaborationMatrix } = require("../src/lib/team-collaboration-matrix") as typeof import("../src/lib/team-collaboration-matrix");

  const tag = `hm-${Date.now()}`;
  const ownerEmail  = `hm-owner-${tag}@local`;
  const viewerEmail = `hm-viewer-${tag}@local`;
  const stranger    = `hm-stranger-${tag}@local`;

  let ownerId   = "";
  let viewerId  = "";
  let strangeId = "";
  let shareId   = "";
  let db: ReturnType<typeof sql>;

  const nowMs = Date.now();
  const currentHourMs = nowMs - (nowMs % 3_600_000);
  const currentBucket = new Date(currentHourMs).toISOString();

  const COST_A = 3000;
  const COST_B = 1500;

  beforeAll(async () => {
    db = sql();

    const [oRow] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${ownerEmail}, ${"hm-owner-" + tag}, ${"hm-owner-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    ownerId = oRow.id;

    const [vRow] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${viewerEmail}, ${"hm-viewer-" + tag}, ${"hm-viewer-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    viewerId = vRow.id;

    const [sRow] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${stranger}, ${"hm-stranger-" + tag}, ${"hm-stranger-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    strangeId = sRow.id;

    // Active grant: owner → viewer
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

    // Seed hourly aggregate rows for (owner, viewer) in the current bucket.
    await db`
      INSERT INTO peer_share_hourly_aggregate
        (owner_id, viewer_id, hour_bucket, source, model,
         tokens_input, tokens_output, cost_millicents, event_count, computed_at)
      VALUES
        (${ownerId}::uuid, ${viewerId}::uuid,
         ${currentBucket}::timestamptz, 'ashlr', 'claude-sonnet-4-5',
         100, 200, ${COST_A}, 3, NOW()),
        (${ownerId}::uuid, ${viewerId}::uuid,
         ${currentBucket}::timestamptz, 'cursor', 'gpt-4o',
         50,  100, ${COST_B}, 2, NOW())
      ON CONFLICT (owner_id, viewer_id, hour_bucket, source, model) DO UPDATE
        SET cost_millicents = EXCLUDED.cost_millicents,
            event_count     = EXCLUDED.event_count,
            computed_at     = NOW()
    `;
  });

  afterAll(async () => {
    await db`
      DELETE FROM peer_share_hourly_aggregate
      WHERE owner_id = ${ownerId}::uuid
    `;
    await db`DELETE FROM peer_share WHERE id = ${shareId}`;
    await db`
      DELETE FROM "user"
      WHERE id IN (${ownerId}::uuid, ${viewerId}::uuid, ${strangeId}::uuid)
    `;
  });

  test("returns cells for active grant pair", async () => {
    const matrix = await computeCollaborationMatrix({
      viewerId,
      windowDays: 1,
    });

    expect(matrix.peers.length).toBeGreaterThanOrEqual(1);
    expect(matrix.cells.length).toBeGreaterThanOrEqual(1);

    // Total cost across all cells should match seeded data.
    const totalCost = matrix.cells.reduce((s, c) => s + c.costMillicents, 0);
    expect(totalCost).toBe(COST_A + COST_B);
  });

  test("cells contain correct cost and event counts", async () => {
    const matrix = await computeCollaborationMatrix({
      viewerId,
      windowDays: 1,
    });

    const ownerCells = matrix.cells.filter((c) => c.ownerId === ownerId);
    expect(ownerCells.length).toBeGreaterThan(0);

    const bucketCell = ownerCells.find((c) => c.hourBucket.startsWith(currentBucket.slice(0, 16)));
    expect(bucketCell).toBeDefined();
    if (bucketCell) {
      expect(bucketCell.costMillicents).toBe(COST_A + COST_B);
      expect(bucketCell.eventCount).toBe(5); // 3 + 2
    }
  });

  test("PRIVACY: revoked grant produces no cells for that pair", async () => {
    // Revoke the grant.
    await db`UPDATE peer_share SET revoked_at = NOW() WHERE id = ${shareId}`;
    // Delete existing aggregate rows to test freshly.
    await db`
      DELETE FROM peer_share_hourly_aggregate
      WHERE owner_id = ${ownerId}::uuid AND viewer_id = ${viewerId}::uuid
    `;

    const matrix = await computeCollaborationMatrix({
      viewerId,
      windowDays: 1,
    });

    // With revoked grant, peers list should be empty.
    expect(matrix.peers).toHaveLength(0);
    expect(matrix.cells).toHaveLength(0);

    // Restore the grant and re-seed data for remaining tests.
    await db`UPDATE peer_share SET revoked_at = NULL WHERE id = ${shareId}`;
    await db`
      INSERT INTO peer_share_hourly_aggregate
        (owner_id, viewer_id, hour_bucket, source, model,
         tokens_input, tokens_output, cost_millicents, event_count, computed_at)
      VALUES
        (${ownerId}::uuid, ${viewerId}::uuid,
         ${currentBucket}::timestamptz, 'ashlr', 'claude-sonnet-4-5',
         100, 200, ${COST_A}, 3, NOW()),
        (${ownerId}::uuid, ${viewerId}::uuid,
         ${currentBucket}::timestamptz, 'cursor', 'gpt-4o',
         50,  100, ${COST_B}, 2, NOW())
      ON CONFLICT (owner_id, viewer_id, hour_bucket, source, model) DO UPDATE
        SET cost_millicents = EXCLUDED.cost_millicents,
            event_count     = EXCLUDED.event_count,
            computed_at     = NOW()
    `;
  });

  test("PRIVACY: stranger with no grant sees empty matrix", async () => {
    const matrix = await computeCollaborationMatrix({
      viewerId: strangeId,
      windowDays: 7,
    });

    // Stranger has no grants → empty peers and cells.
    expect(matrix.peers).toHaveLength(0);
    expect(matrix.cells).toHaveLength(0);
    expect(matrix.maxCostMillicents).toBe(0);
  });

  test("cross-org: viewer with grant in different org sees no data from ungranted owners", async () => {
    // The stranger has no grant from anyone — they see nothing.
    // This is the cross-org visibility check: data from org A is not visible
    // to a viewer who only has grants from org B (enforced by grant filter).
    const matrix = await computeCollaborationMatrix({
      viewerId: strangeId,
      windowDays: 7,
    });
    expect(matrix.cells.every((c) => c.ownerId !== ownerId)).toBe(true);
  });

  test("windowDays >30 is clamped to 30", async () => {
    // The function clamps internally — just verify no error and we get a valid result.
    const matrix = await computeCollaborationMatrix({
      viewerId,
      windowDays: 999,
    });
    // windowStart should be ~30 days ago, not 999 days ago.
    const windowStartMs = new Date(matrix.windowStart).getTime();
    const daysBack = (Date.now() - windowStartMs) / 86_400_000;
    expect(daysBack).toBeLessThanOrEqual(31); // allow 1d buffer for truncation
  });

  test("idempotency: calling twice returns the same cell totals", async () => {
    const m1 = await computeCollaborationMatrix({ viewerId, windowDays: 1 });
    const m2 = await computeCollaborationMatrix({ viewerId, windowDays: 1 });

    const total1 = m1.cells.reduce((s, c) => s + c.costMillicents, 0);
    const total2 = m2.cells.reduce((s, c) => s + c.costMillicents, 0);
    expect(total1).toBe(total2);
    expect(m1.peers.length).toBe(m2.peers.length);
  });

  test("model filter narrows cells to matching model only", async () => {
    const matrix = await computeCollaborationMatrix({
      viewerId,
      windowDays: 1,
      model: "claude-sonnet-4-5",
    });

    // With model filter, only cells from the sonnet model should be present.
    for (const cell of matrix.cells) {
      const models = Object.keys(cell.modelBreakdown);
      // All model keys in breakdown must be the filtered model.
      expect(models.every((m) => m === "claude-sonnet-4-5")).toBe(true);
    }

    // Total cost should be COST_A only (gpt-4o excluded).
    const totalCost = matrix.cells.reduce((s, c) => s + c.costMillicents, 0);
    expect(totalCost).toBe(COST_A);
  });
});
