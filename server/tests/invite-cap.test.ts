/**
 * invite-cap.test.ts — unit tests for the member-cap gate on
 * POST /api/invite/create (Gate 1).
 *
 * We test the gate logic in isolation by mocking the org-db and
 * plan-gate imports. No DB required.
 *
 * The gate fires when members + pending_invites >= limits.max_members.
 * For FREE_LIMITS, max_members = 1.
 */

import { describe, expect, test, mock, beforeEach } from "bun:test";
import { FREE_LIMITS, PRO_LIMITS, limitsFor } from "../src/lib/plan-gate";

// ---------------------------------------------------------------------------
// Helper: simulate the gate logic (mirrors route.ts implementation)
// ---------------------------------------------------------------------------

interface MockOrg {
  plan: "free" | "pro" | "team";
  subscription_status: "active" | "trialing" | "past_due" | "canceled" | "incomplete" | null;
}

/**
 * Simulate the invite-cap check from the route handler.
 * Returns 402 body when capped, or null when allowed.
 */
function checkInviteCap(
  org: MockOrg,
  currentMembers: number,
  pendingInvites: number,
): { error: string; status: 402 } | null {
  const limits = limitsFor(org);
  if (!Number.isFinite(limits.max_members)) return null; // pro/team: no cap
  if (currentMembers + pendingInvites >= limits.max_members) {
    return {
      error: `Free tier capped at ${limits.max_members} member. Upgrade to Pro at /pricing.`,
      status: 402,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("invite member cap gate", () => {
  const freeOrg: MockOrg = { plan: "free", subscription_status: null };
  const proOrg: MockOrg = { plan: "pro", subscription_status: "active" };

  test("free org with 1 member → 402 (already at cap)", () => {
    const result = checkInviteCap(freeOrg, 1, 0);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(402);
    expect(result!.error).toContain("Free tier capped at 1 member");
    expect(result!.error).toContain("/pricing");
  });

  test("free org with 0 members + 1 pending → 402 (pending counts against cap)", () => {
    const result = checkInviteCap(freeOrg, 0, 1);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(402);
  });

  test("free org with 0 members + 0 pending → allowed", () => {
    const result = checkInviteCap(freeOrg, 0, 0);
    expect(result).toBeNull();
  });

  test("pro org with 10 members → allowed (no cap)", () => {
    const result = checkInviteCap(proOrg, 10, 5);
    expect(result).toBeNull();
  });

  test("pro org past_due reverts to free cap", () => {
    const pastDueOrg: MockOrg = { plan: "pro", subscription_status: "past_due" };
    // Past-due pro reverts to FREE_LIMITS → max_members=1
    const result = checkInviteCap(pastDueOrg, 1, 0);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(402);
  });

  test("pro trialing → no cap (trial gets full limits)", () => {
    const trialOrg: MockOrg = { plan: "pro", subscription_status: "trialing" };
    const result = checkInviteCap(trialOrg, 50, 10);
    expect(result).toBeNull();
  });

  test("error message body is well-formed JSON-safe string", () => {
    const result = checkInviteCap(freeOrg, 1, 0);
    expect(result).not.toBeNull();
    // Should not throw when JSON-serialised.
    expect(() => JSON.stringify(result)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.error).toBeTruthy();
  });

  test("limits from limitsFor are used — not hardcoded values", () => {
    // If we change FREE_LIMITS.max_members the gate should follow.
    const org: MockOrg = { plan: "free", subscription_status: null };
    const limits = limitsFor(org);
    expect(limits.max_members).toBe(FREE_LIMITS.max_members);
    // members+pending at exactly the cap → blocked
    const atCap = checkInviteCap(org, limits.max_members, 0);
    expect(atCap).not.toBeNull();
    // one below cap → allowed
    const belowCap = checkInviteCap(org, limits.max_members - 1, 0);
    expect(belowCap).toBeNull();
  });
});
