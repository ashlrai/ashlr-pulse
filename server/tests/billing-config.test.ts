/**
 * billing-config tests — env-driven price ↔ plan resolution.
 *
 * The reverse lookup (price → plan) is load-bearing for the Stripe webhook:
 * if it returns null we leave the org's plan unchanged rather than mis-
 * classifying. So both directions need to round-trip cleanly + handle the
 * "env var unset" case without crashing.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  priceIdFor,
  planFromPriceId,
  configuredPrices,
} from "../src/lib/billing-config";

const ENV_KEYS = [
  "STRIPE_PRICE_PRO_MONTHLY",
  "STRIPE_PRICE_PRO_ANNUAL",
  "STRIPE_PRICE_TEAM_MONTHLY",
  "STRIPE_PRICE_TEAM_ANNUAL",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

describe("billing-config", () => {
  let snap: Record<string, string | undefined>;

  beforeEach(() => {
    snap = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => restoreEnv(snap));

  describe("priceIdFor", () => {
    test("returns null when env var unset", () => {
      expect(priceIdFor({ plan: "pro", interval: "monthly" })).toBeNull();
    });

    test("returns the configured price id", () => {
      process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_m";
      expect(priceIdFor({ plan: "pro", interval: "monthly" })).toBe("price_pro_m");
    });

    test("each plan/interval combination is independent", () => {
      process.env.STRIPE_PRICE_PRO_MONTHLY  = "price_pro_m";
      process.env.STRIPE_PRICE_PRO_ANNUAL   = "price_pro_a";
      process.env.STRIPE_PRICE_TEAM_MONTHLY = "price_team_m";
      process.env.STRIPE_PRICE_TEAM_ANNUAL  = "price_team_a";

      expect(priceIdFor({ plan: "pro",  interval: "monthly" })).toBe("price_pro_m");
      expect(priceIdFor({ plan: "pro",  interval: "annual"  })).toBe("price_pro_a");
      expect(priceIdFor({ plan: "team", interval: "monthly" })).toBe("price_team_m");
      expect(priceIdFor({ plan: "team", interval: "annual"  })).toBe("price_team_a");
    });
  });

  describe("planFromPriceId (webhook reverse lookup)", () => {
    test("returns null for unknown price id", () => {
      process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_m";
      expect(planFromPriceId("price_random_unknown")).toBeNull();
    });

    test("returns null when no env vars are set", () => {
      expect(planFromPriceId("price_anything")).toBeNull();
    });

    test("maps pro prices to 'pro' regardless of interval", () => {
      process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_m";
      process.env.STRIPE_PRICE_PRO_ANNUAL  = "price_pro_a";
      expect(planFromPriceId("price_pro_m")).toBe("pro");
      expect(planFromPriceId("price_pro_a")).toBe("pro");
    });

    test("maps team prices to 'team'", () => {
      process.env.STRIPE_PRICE_TEAM_MONTHLY = "price_team_m";
      process.env.STRIPE_PRICE_TEAM_ANNUAL  = "price_team_a";
      expect(planFromPriceId("price_team_m")).toBe("team");
      expect(planFromPriceId("price_team_a")).toBe("team");
    });

    test("round-trips priceIdFor → planFromPriceId for every configured combo", () => {
      process.env.STRIPE_PRICE_PRO_MONTHLY  = "price_pro_m";
      process.env.STRIPE_PRICE_PRO_ANNUAL   = "price_pro_a";
      process.env.STRIPE_PRICE_TEAM_MONTHLY = "price_team_m";
      process.env.STRIPE_PRICE_TEAM_ANNUAL  = "price_team_a";

      for (const plan of ["pro", "team"] as const) {
        for (const interval of ["monthly", "annual"] as const) {
          const id = priceIdFor({ plan, interval });
          expect(id).not.toBeNull();
          expect(planFromPriceId(id!)).toBe(plan);
        }
      }
    });
  });

  describe("configuredPrices", () => {
    test("returns empty when nothing is configured", () => {
      expect(configuredPrices()).toEqual([]);
    });

    test("only returns combos whose env var is set", () => {
      process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_m";
      // PRO_ANNUAL, TEAM_* deliberately unset
      const out = configuredPrices();
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({ plan: "pro", interval: "monthly", priceId: "price_pro_m" });
    });

    test("returns all four when fully configured", () => {
      process.env.STRIPE_PRICE_PRO_MONTHLY  = "price_pro_m";
      process.env.STRIPE_PRICE_PRO_ANNUAL   = "price_pro_a";
      process.env.STRIPE_PRICE_TEAM_MONTHLY = "price_team_m";
      process.env.STRIPE_PRICE_TEAM_ANNUAL  = "price_team_a";
      expect(configuredPrices()).toHaveLength(4);
    });

    test("entries identify both their plan tier and billing interval", () => {
      process.env.STRIPE_PRICE_PRO_ANNUAL  = "price_pro_a";
      process.env.STRIPE_PRICE_TEAM_MONTHLY = "price_team_m";
      const out = configuredPrices().sort((a, b) => a.plan.localeCompare(b.plan));
      expect(out[0]).toEqual({ plan: "pro", interval: "annual", priceId: "price_pro_a" });
      expect(out[1]).toEqual({ plan: "team", interval: "monthly", priceId: "price_team_m" });
    });
  });
});
