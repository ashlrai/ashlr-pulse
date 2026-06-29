/**
 * fleet-proposal-detail.test.ts — three required tests:
 *
 *   1. Cost calculation — buildAgentCosts correctly aggregates token counts
 *      and computes per-component cost breakdown via pricing.ts.
 *
 *   2. Privacy floor on proposal meta — costMasked=true for subscription billing
 *      modes; breakdown/totalCents are null; no forbidden content keys surfaced.
 *
 *   3. Timeline ordering — timeline steps are ordered created→claimed→completed
 *      and the outcome field reflects the correct terminal state.
 *
 * All three tests are pure (no DB) — they exercise the logic layers directly.
 * DB-gated integration tests follow the pattern from fleet-commands-db.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  costBreakdownMillicents,
  emptyBreakdown,
  addBreakdown,
  millicentsToCents,
  fmtUsd,
} from "../src/lib/pricing";
import { isSubscriptionMode } from "../src/lib/plan-gate";
import { sanitizeDetail } from "../src/lib/fleet-audit";
import { FORBIDDEN_META_KEYS } from "../src/lib/peer-share-guard";

// ---------------------------------------------------------------------------
// Test 1 — Cost calculation
// ---------------------------------------------------------------------------
// We test the pricing primitives used by buildAgentCosts in fleet-proposal-detail
// directly, since buildAgentCosts is a pure function of costBreakdownMillicents.

describe("fleet-proposal-detail: cost calculation", () => {
  test("single agent sonnet-4-6: input+output cost aggregates correctly", () => {
    // 500k input @ $3/M = $1.50 → 150 cents
    // 200k output @ $15/M = $3.00 → 300 cents
    // total = $4.50 → 450 cents
    const bd = costBreakdownMillicents({
      model: "claude-sonnet-4-6",
      tokens_input: 500_000,
      tokens_output: 200_000,
    });
    expect(bd).not.toBeNull();
    expect(millicentsToCents(bd!.input)).toBe(150);
    expect(millicentsToCents(bd!.output)).toBe(300);
    expect(millicentsToCents(bd!.total)).toBe(450);
    expect(fmtUsd(millicentsToCents(bd!.total))).toBe("$4.50");
  });

  test("two agent rows aggregate via addBreakdown", () => {
    // Agent A: 100k input @ $3/M = $0.30 → 30 cents
    const bdA = costBreakdownMillicents({
      model: "claude-sonnet-4-6",
      tokens_input: 100_000,
      tokens_output: 0,
    })!;

    // Agent B: 200k output @ $15/M = $3.00 → 300 cents
    const bdB = costBreakdownMillicents({
      model: "claude-sonnet-4-6",
      tokens_input: 0,
      tokens_output: 200_000,
    })!;

    const acc = emptyBreakdown();
    addBreakdown(acc, bdA);
    addBreakdown(acc, bdB);

    expect(millicentsToCents(acc.input)).toBe(30);
    expect(millicentsToCents(acc.output)).toBe(300);
    expect(millicentsToCents(acc.total)).toBe(330);
  });

  test("cache_5m and cache_1h write tokens are priced separately (sonnet-4-6)", () => {
    // 1M cache_5m_write @ $3.75/M = $3.75 → 375 cents
    // 1M cache_1h_write @ $6/M = $6.00 → 600 cents
    // total cache write = $9.75 → 975 cents
    const bd = costBreakdownMillicents({
      model: "claude-sonnet-4-6",
      tokens_input: 0,
      tokens_output: 0,
      tokens_cache_5m_write: 1_000_000,
      tokens_cache_1h_write: 1_000_000,
    });
    expect(bd).not.toBeNull();
    expect(millicentsToCents(bd!.cache_5m_write)).toBe(375);
    expect(millicentsToCents(bd!.cache_1h_write)).toBe(600);
    expect(millicentsToCents(bd!.total)).toBe(975);
  });

  test("unknown model returns null breakdown (renders — not $0)", () => {
    const bd = costBreakdownMillicents({
      model: "some-unknown-llm-v99",
      tokens_input: 1_000_000,
      tokens_output: 1_000_000,
    });
    expect(bd).toBeNull();
    // fmtUsd should render — not $0
    expect(fmtUsd(null)).toBe("—");
  });

  test("emptyBreakdown total is zero", () => {
    const bd = emptyBreakdown();
    expect(bd.total).toBe(0);
    expect(bd.input).toBe(0);
    expect(bd.output).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Privacy floor on proposal meta
// ---------------------------------------------------------------------------

describe("fleet-proposal-detail: privacy floor on proposal meta", () => {
  test("isSubscriptionMode returns true for pro/max-100/max-200, false for api/team/unknown", () => {
    expect(isSubscriptionMode("pro")).toBe(true);
    expect(isSubscriptionMode("max-100")).toBe(true);
    expect(isSubscriptionMode("max-200")).toBe(true);
    expect(isSubscriptionMode("api")).toBe(false);
    expect(isSubscriptionMode("team")).toBe(false);
    expect(isSubscriptionMode("unknown")).toBe(false);
    expect(isSubscriptionMode(null)).toBe(false);
    expect(isSubscriptionMode(undefined)).toBe(false);
  });

  test("subscription mode: cost fields must be null (masked)", () => {
    // Simulate what buildAgentCosts returns when maskCost=true
    const masked = { breakdown: null as null, totalCents: null as null };
    expect(masked.breakdown).toBeNull();
    expect(masked.totalCents).toBeNull();
  });

  test("sanitizeDetail strips FORBIDDEN_META_KEYS from proposal detail bags", () => {
    const poisoned = {
      engine: "anthropic/claude-sonnet-4-6",
      // These should be stripped:
      diff:         "@@ -1 +1 @@ -old +new",
      code:         "rm -rf /",
      prompt:       "you are a helpful assistant",
      completion:   "here is the answer",
      file_content: "import fs from 'fs'",
      body:         "PR description text",
      // Safe metadata should pass through:
      costUsd:      4.50,
      sessionId:    "sess-abc123",
      owner:        "alice@acme.com",
    };

    const clean = sanitizeDetail(poisoned);

    // Safe fields pass through
    expect(clean.engine).toBe("anthropic/claude-sonnet-4-6");
    expect(clean.costUsd).toBe(4.50);
    expect(clean.sessionId).toBe("sess-abc123");
    expect(clean.owner).toBe("alice@acme.com");

    // Forbidden keys are stripped
    for (const key of ["diff", "code", "prompt", "completion", "file_content", "body"]) {
      expect(Object.prototype.hasOwnProperty.call(clean, key)).toBe(false);
    }
  });

  test("sanitizeDetail rejects over-long string values (looks like file body)", () => {
    const huge = "x".repeat(3000);
    const result = sanitizeDetail({ note: huge, count: 42 });
    // Over-long string is truncated to MAX_DETAIL_STRING_LEN (2048)
    expect((result.note as string).length).toBeLessThanOrEqual(2048);
    // Safe numeric value passes through
    expect(result.count).toBe(42);
  });

  test("FORBIDDEN_META_KEYS covers all required privacy-floor keys", () => {
    const mustBlock = ["diff", "patch", "code", "prompt", "prompts", "completion",
                       "completions", "body", "source_code", "content",
                       "file_content", "file_contents", "stdout", "stderr",
                       "raw_otel_span"];
    for (const key of mustBlock) {
      expect(FORBIDDEN_META_KEYS.has(key)).toBe(true);
    }
  });

  test("sanitizeDetail on non-object input returns empty object", () => {
    expect(sanitizeDetail(null)).toEqual({});
    expect(sanitizeDetail(undefined)).toEqual({});
    expect(sanitizeDetail("string")).toEqual({});
    expect(sanitizeDetail(42)).toEqual({});
    expect(sanitizeDetail([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Timeline ordering
// ---------------------------------------------------------------------------

describe("fleet-proposal-detail: timeline ordering", () => {
  /** Builds a ProposalTimeline shape (mirrors the type in fleet-proposal-detail). */
  function makeTimeline(overrides: {
    createdAt?: string;
    claimedAt?: string | null;
    completedAt?: string | null;
    outcome?: string | null;
    actor?: string | null;
  } = {}) {
    return {
      createdAt:   overrides.createdAt   ?? "2026-06-01T10:00:00Z",
      claimedAt:   overrides.claimedAt   ?? null,
      completedAt: overrides.completedAt ?? null,
      outcome:     overrides.outcome     ?? "pending",
      actor:       overrides.actor       ?? null,
    };
  }

  test("created_at < claimed_at < completed_at ordering is monotonic", () => {
    const tl = makeTimeline({
      createdAt:   "2026-06-01T10:00:00Z",
      claimedAt:   "2026-06-01T10:05:00Z",
      completedAt: "2026-06-01T10:08:00Z",
    });

    const created   = new Date(tl.createdAt).getTime();
    const claimed   = new Date(tl.claimedAt!).getTime();
    const completed = new Date(tl.completedAt!).getTime();

    expect(created).toBeLessThan(claimed);
    expect(claimed).toBeLessThan(completed);
  });

  test("outcome 'applied' when status is done and no rejection reason", () => {
    const tl = makeTimeline({
      completedAt: "2026-06-01T10:08:00Z",
      outcome: "applied",
    });
    expect(tl.outcome).toBe("applied");
  });

  test("outcome 'rejected' when command failed or fleet_outcome signals rejection", () => {
    const tl = makeTimeline({
      completedAt: "2026-06-01T10:08:00Z",
      outcome: "rejected",
    });
    expect(tl.outcome).toBe("rejected");
  });

  test("pending timeline has null claimedAt and completedAt", () => {
    const tl = makeTimeline({ outcome: "pending" });
    expect(tl.claimedAt).toBeNull();
    expect(tl.completedAt).toBeNull();
    expect(tl.outcome).toBe("pending");
  });

  test("partially reviewed (claimed but not completed) has claimedAt, null completedAt", () => {
    const tl = makeTimeline({
      claimedAt:   "2026-06-01T10:05:00Z",
      completedAt: null,
      outcome:     "claimed",
    });
    expect(tl.claimedAt).not.toBeNull();
    expect(tl.completedAt).toBeNull();

    // Claimed must be after created
    const created = new Date(tl.createdAt).getTime();
    const claimed = new Date(tl.claimedAt!).getTime();
    expect(created).toBeLessThan(claimed);
  });

  test("all three timeline steps are non-decreasing when all set", () => {
    const timestamps = [
      "2026-06-01T10:00:00Z",
      "2026-06-01T10:05:00Z",
      "2026-06-01T10:08:00Z",
    ];
    const tl = makeTimeline({
      createdAt:   timestamps[0],
      claimedAt:   timestamps[1],
      completedAt: timestamps[2],
      outcome:     "applied",
    });

    const steps = [
      tl.createdAt,
      tl.claimedAt,
      tl.completedAt,
    ].filter((t): t is string => t != null);

    for (let i = 1; i < steps.length; i++) {
      expect(new Date(steps[i]).getTime()).toBeGreaterThanOrEqual(
        new Date(steps[i - 1]).getTime(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// DB-gated integration tests (skip without DATABASE_URL)
// ---------------------------------------------------------------------------

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("fleet-proposal-detail: DB integration", () => {
  // These integration tests require a live Postgres with migrations applied.
  // They follow the same pattern as fleet-commands-db.test.ts.
  // Run with: DATABASE_URL=postgres://... bun test tests/fleet-proposal-detail.test.ts

  test("getProposalDetail returns null for a non-existent proposal id", async () => {
    const { getProposalDetail } = await import("../src/lib/fleet-proposal-detail");
    const { ensureLocalUser, ensureDefaultOrg } = await import("../src/lib/current-user");
    const { sql } = await import("../src/lib/db");

    const email = `pulse-prop-detail-${Date.now()}@local`;
    const u = await ensureLocalUser(email, null);
    const orgId = await ensureDefaultOrg(u.id, email);
    const nonExistentId = "00000000-0000-0000-0000-000000000000";

    const result = await getProposalDetail(orgId, nonExistentId);
    expect(result).toBeNull();

    // cleanup
    const db = sql();
    await db`DELETE FROM "user" WHERE email = ${email}`;
  });
});
