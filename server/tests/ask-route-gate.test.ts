/**
 * ask-route-gate.test.ts — unit tests for the ai_features plan gate +
 * per-user rate limit on POST /api/ask.
 *
 * Covers the gate decision tree we added to close the audit finding
 * "/api/ask has zero plan gate and zero rate limit". The token bucket
 * itself is exercised by rate-limit.test.ts; here we verify the ask
 * route's wrapping decisions (free → 402, then over-quota → 429).
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { limitsFor } from "../src/lib/plan-gate";
import { checkBucket, clearBuckets } from "../src/lib/rate-limit";

interface MockOrg {
  plan: "free" | "pro" | "team";
  subscription_status: "active" | "trialing" | "past_due" | "canceled" | "incomplete" | null;
}

/** Mirror of /api/ask gate ordering. */
function checkAskGate(input: {
  userId: string;
  org: MockOrg | null;
  capacity: number;
  refillPerSec: number;
}): { status: 402 | 429; error: string } | null {
  if (input.org && !limitsFor(input.org).ai_features) {
    return {
      status: 402,
      error: "Ask Pulse is a Pro feature. Upgrade to Pro at /billing.",
    };
  }
  const rl = checkBucket(`ask:${input.userId}`, input.capacity, input.refillPerSec);
  if (!rl.ok) return { status: 429, error: "rate limit exceeded — try again shortly" };
  return null;
}

describe("ask route gate", () => {
  beforeEach(() => clearBuckets());

  test("free plan blocks → 402", () => {
    const r = checkAskGate({
      userId: "u-free",
      org: { plan: "free", subscription_status: null },
      capacity: 30,
      refillPerSec: 0.00833,
    });
    expect(r).not.toBeNull();
    expect(r!.status).toBe(402);
    expect(r!.error).toContain("Pro");
  });

  test("pro active passes through gate", () => {
    const r = checkAskGate({
      userId: "u-pro",
      org: { plan: "pro", subscription_status: "active" },
      capacity: 30,
      refillPerSec: 0.00833,
    });
    expect(r).toBeNull();
  });

  test("pro trialing passes through gate", () => {
    const r = checkAskGate({
      userId: "u-pro-trial",
      org: { plan: "pro", subscription_status: "trialing" },
      capacity: 30,
      refillPerSec: 0.00833,
    });
    expect(r).toBeNull();
  });

  test("pro past_due reverts to free → 402 (non-payment hard floor)", () => {
    const r = checkAskGate({
      userId: "u-pd",
      org: { plan: "pro", subscription_status: "past_due" },
      capacity: 30,
      refillPerSec: 0.00833,
    });
    expect(r).not.toBeNull();
    expect(r!.status).toBe(402);
  });

  test("hammered pro user → 429 after capacity exhausted", () => {
    const userId = "u-hammer";
    const org: MockOrg = { plan: "pro", subscription_status: "active" };
    // Burn the bucket. 5 capacity, 0 refill (effectively).
    let last: ReturnType<typeof checkAskGate> = null;
    for (let i = 0; i < 6; i++) {
      last = checkAskGate({ userId, org, capacity: 5, refillPerSec: 0.0001 });
    }
    expect(last).not.toBeNull();
    expect(last!.status).toBe(429);
  });

  test("rate limit is per-user — one user's exhaustion does not affect another", () => {
    const noisyId = "u-noisy";
    const quietId = "u-quiet";
    const org: MockOrg = { plan: "pro", subscription_status: "active" };
    // Exhaust noisy user.
    for (let i = 0; i < 6; i++) {
      checkAskGate({ userId: noisyId, org, capacity: 5, refillPerSec: 0.0001 });
    }
    // Quiet user still gets through.
    const r = checkAskGate({ userId: quietId, org, capacity: 5, refillPerSec: 0.0001 });
    expect(r).toBeNull();
  });
});
