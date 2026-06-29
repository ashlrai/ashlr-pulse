/**
 * per-source-subscription.test.ts — exercises the pure helpers in
 * `org-db.ts` that compute the subscription source set + apply cost
 * zeroing. Database-touching paths (setSourceSubscriptionMode,
 * maybeAutoDefaultCodexSubscription) are exercised by the existing
 * integration test pattern when DATABASE_URL is set; they're skipped
 * here without a DB.
 */

import { describe, expect, test } from "bun:test";
import {
  subscriptionSourcesFor,
  effectiveCostMillicents,
  type OrgRow,
} from "../src/lib/org-db";

function mockOrg(overrides: Partial<OrgRow> = {}): OrgRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Test Org",
    slug: "test",
    plan: "pro",
    plan_seats: 1,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    subscription_status: "active",
    current_period_end: null,
    trial_ends_at: null,
    created_at: "2026-01-01T00:00:00Z",
    billing_mode: "api",
    source_subscription_modes: {},
    monthly_budget_usd: null,
    digest_frequency: "daily",
    ...overrides,
  };
}

describe("subscriptionSourcesFor", () => {
  test("empty map + api billing_mode → empty set", () => {
    const set = subscriptionSourcesFor(mockOrg());
    expect(set.size).toBe(0);
  });

  test("explicit per-source overrides go into the set", () => {
    const set = subscriptionSourcesFor(mockOrg({
      source_subscription_modes: {
        codex: "subscription",
        cursor: "api_priced",
        copilot: "subscription",
      },
    }));
    expect(set.has("codex")).toBe(true);
    expect(set.has("copilot")).toBe(true);
    // api_priced sources are NOT in the set.
    expect(set.has("cursor")).toBe(false);
    expect(set.size).toBe(2);
  });

  test("legacy billing_mode=pro adds claude_code when no explicit override", () => {
    const set = subscriptionSourcesFor(mockOrg({ billing_mode: "pro" }));
    expect(set.has("claude_code")).toBe(true);
  });

  test("legacy billing_mode=max-200 adds claude_code", () => {
    const set = subscriptionSourcesFor(mockOrg({ billing_mode: "max-200" }));
    expect(set.has("claude_code")).toBe(true);
  });

  test("legacy billing_mode=api does NOT add claude_code", () => {
    const set = subscriptionSourcesFor(mockOrg({ billing_mode: "api" }));
    expect(set.has("claude_code")).toBe(false);
  });

  test("explicit claude_code=api_priced overrides billing_mode=pro", () => {
    // User on Pro plan but explicitly says they ALSO use the raw API for
    // some workflows — they want claude_code costs visible.
    const set = subscriptionSourcesFor(mockOrg({
      billing_mode: "pro",
      source_subscription_modes: { claude_code: "api_priced" },
    }));
    expect(set.has("claude_code")).toBe(false);
  });

  test("null org returns empty set", () => {
    expect(subscriptionSourcesFor(null).size).toBe(0);
    expect(subscriptionSourcesFor(undefined).size).toBe(0);
  });

  test("missing source_subscription_modes field treated as empty map", () => {
    const set = subscriptionSourcesFor({
      ...mockOrg(),
      source_subscription_modes: undefined as unknown as Record<string, "subscription" | "api_priced">,
    });
    expect(set.size).toBe(0);
  });

  test("real-world: codex auto-defaulted + claude on Max plan", () => {
    // Common case after first Codex span ingest on a Pro user.
    const set = subscriptionSourcesFor(mockOrg({
      billing_mode: "max-200",
      source_subscription_modes: { codex: "subscription" },
    }));
    expect(set.has("claude_code")).toBe(true);  // legacy from billing_mode
    expect(set.has("codex")).toBe(true);        // explicit
    expect(set.has("cursor")).toBe(false);      // not flagged
  });
});

describe("effectiveCostMillicents", () => {
  test("returns 0 when source is in the subscription set", () => {
    const set = new Set(["codex", "claude_code"]);
    expect(effectiveCostMillicents("codex", 12345, set)).toBe(0);
    expect(effectiveCostMillicents("claude_code", 999_999, set)).toBe(0);
  });

  test("returns the rate-card cost when source is NOT in the set", () => {
    const set = new Set(["codex"]);
    expect(effectiveCostMillicents("cursor", 5000, set)).toBe(5000);
  });

  test("treats null cost as 0 when not subscribed", () => {
    const set = new Set<string>();
    // A row with no priced model contributes 0, not NaN/null cascading.
    expect(effectiveCostMillicents("cursor", null, set)).toBe(0);
  });

  test("empty subscription set → all costs pass through", () => {
    const set = new Set<string>();
    expect(effectiveCostMillicents("codex", 10_000, set)).toBe(10_000);
    expect(effectiveCostMillicents("claude_code", 50_000, set)).toBe(50_000);
  });

  test("token counts are unaffected — this only zeroes COST", () => {
    // The contract: subscription mode zeroes COST but not tokens. This
    // function only handles cost; the test just documents that contract.
    // Token aggregation lives in dashboard-data.ts and adds tokens
    // unconditionally — see the related test in dashboard-data tests.
    const set = new Set(["codex"]);
    const cost = effectiveCostMillicents("codex", 100_000, set);
    expect(cost).toBe(0);
    // No token assertion here — that's covered in the dashboard data tests.
  });
});

describe("integration: cost zeroing via subscription set + effectiveCostMillicents", () => {
  test("simulated mixed-source aggregate: codex zeroes, others sum", () => {
    // Mock 5 events from different sources with rate-card costs.
    const events = [
      { source: "claude_code", cost: 12_000 },
      { source: "codex",       cost: 100_000 }, // would be huge if API-priced
      { source: "cursor",      cost: 3_000 },
      { source: "codex",       cost: 50_000 },
      { source: "shell",       cost: 0 },
    ];
    const subset = new Set(["codex"]);
    const total = events.reduce(
      (acc, e) => acc + effectiveCostMillicents(e.source, e.cost, subset),
      0,
    );
    // codex events zeroed; everything else summed: 12000 + 0 + 3000 + 0 + 0 = 15000
    expect(total).toBe(15_000);
  });
});
