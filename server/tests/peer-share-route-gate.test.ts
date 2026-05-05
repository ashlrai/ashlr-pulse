/**
 * peer-share-route-gate.test.ts — unit tests for the plan-gate
 * pre-check on POST /api/peer-share (Gate 4).
 *
 * The route handler at /api/peer-share/route.ts now does:
 *   ownerOrg = primaryOrgForUser(me.id)
 *   if (ownerOrg && !limitsFor(ownerOrg).peer_share_enabled) → 402
 *
 * Before this test landed, the route silently bypassed the gate
 * because it didn't pass `ownerOrg` to createPeerShare and the gate
 * inside createPeerShare was wrapped in `if (input.ownerOrg)`.
 *
 * We simulate the gate logic in isolation here (matches the
 * invite-cap.test.ts pattern). The createPeerShare DB-side fallback is
 * already covered by peer-share-db.test.ts when DATABASE_URL is set.
 */

import { describe, expect, test } from "bun:test";
import { limitsFor } from "../src/lib/plan-gate";

interface MockOrg {
  plan: "free" | "pro" | "team";
  subscription_status: "active" | "trialing" | "past_due" | "canceled" | "incomplete" | null;
}

/** Mirror of the route's gate decision (peer-share/route.ts:103-108). */
function checkPeerShareGate(
  ownerOrg: MockOrg | null,
): { error: string; status: 402 } | null {
  if (ownerOrg && !limitsFor(ownerOrg).peer_share_enabled) {
    return {
      error: "Peer sharing is a Pro feature. Upgrade to Pro at /billing.",
      status: 402,
    };
  }
  return null;
}

describe("peer-share gate (Gate 4)", () => {
  test("free plan blocks → 402", () => {
    const r = checkPeerShareGate({ plan: "free", subscription_status: null });
    expect(r).not.toBeNull();
    expect(r!.status).toBe(402);
    expect(r!.error).toContain("Pro");
  });

  test("pro active passes", () => {
    const r = checkPeerShareGate({ plan: "pro", subscription_status: "active" });
    expect(r).toBeNull();
  });

  test("pro trialing passes (trial gets full access)", () => {
    const r = checkPeerShareGate({ plan: "pro", subscription_status: "trialing" });
    expect(r).toBeNull();
  });

  test("team active passes", () => {
    const r = checkPeerShareGate({ plan: "team", subscription_status: "active" });
    expect(r).toBeNull();
  });

  test("pro past_due reverts to free → 402", () => {
    // Non-payment is treated as free per limitsFor() — paid features
    // shouldn't keep working when the card stops working.
    const r = checkPeerShareGate({ plan: "pro", subscription_status: "past_due" });
    expect(r).not.toBeNull();
    expect(r!.status).toBe(402);
  });

  test("team canceled reverts to free → 402", () => {
    const r = checkPeerShareGate({ plan: "team", subscription_status: "canceled" });
    expect(r).not.toBeNull();
    expect(r!.status).toBe(402);
  });

  test("null org skips the gate (defense for users mid-signup)", () => {
    // primaryOrgForUser can briefly return null during signup. The route
    // intentionally falls through rather than 500'ing — the underlying
    // DB-layer gate in createPeerShare still backstops the bad case.
    const r = checkPeerShareGate(null);
    expect(r).toBeNull();
  });
});
