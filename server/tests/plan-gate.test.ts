/**
 * plan-gate.test.ts — unit tests for limitsFor(), retentionCutoff(),
 * requirePlan(), and PlanGateError across all plan/status combinations.
 *
 * No DB required — pure functions.
 */

import { describe, expect, test } from "bun:test";
import {
  limitsFor,
  retentionCutoff,
  requirePlan,
  PlanGateError,
  FREE_LIMITS,
  PRO_LIMITS,
  TEAM_LIMITS,
  type OrgPlanRef,
} from "../src/lib/plan-gate";

// ---------------------------------------------------------------------------
// limitsFor
// ---------------------------------------------------------------------------

describe("limitsFor", () => {
  test("free plan with null status → FREE_LIMITS", () => {
    const org: OrgPlanRef = { plan: "free", subscription_status: null };
    expect(limitsFor(org)).toEqual(FREE_LIMITS);
  });

  test("pro plan active → PRO_LIMITS", () => {
    const org: OrgPlanRef = { plan: "pro", subscription_status: "active" };
    expect(limitsFor(org)).toEqual(PRO_LIMITS);
  });

  test("pro plan trialing → PRO_LIMITS (trial gets full access)", () => {
    const org: OrgPlanRef = { plan: "pro", subscription_status: "trialing" };
    expect(limitsFor(org)).toEqual(PRO_LIMITS);
  });

  test("team plan active → TEAM_LIMITS", () => {
    const org: OrgPlanRef = { plan: "team", subscription_status: "active" };
    expect(limitsFor(org)).toEqual(TEAM_LIMITS);
  });

  test("map_enabled (fleet control plane) is Pro+ gated", () => {
    // Free orgs (incl. lapsed paid plans) can never enqueue fleet commands.
    expect(FREE_LIMITS.map_enabled).toBe(false);
    expect(limitsFor({ plan: "free", subscription_status: null }).map_enabled).toBe(false);
    expect(limitsFor({ plan: "pro", subscription_status: "past_due" }).map_enabled).toBe(false);
    // Pro/Team (active or trialing) get the fleet inbox + map + audit export.
    expect(PRO_LIMITS.map_enabled).toBe(true);
    expect(TEAM_LIMITS.map_enabled).toBe(true);
    expect(limitsFor({ plan: "pro", subscription_status: "trialing" }).map_enabled).toBe(true);
    expect(limitsFor({ plan: "team", subscription_status: "active" }).map_enabled).toBe(true);
  });

  test("pro plan past_due → FREE_LIMITS (non-payment reverts)", () => {
    const org: OrgPlanRef = { plan: "pro", subscription_status: "past_due" };
    expect(limitsFor(org)).toEqual(FREE_LIMITS);
  });

  test("team plan canceled → FREE_LIMITS", () => {
    const org: OrgPlanRef = { plan: "team", subscription_status: "canceled" };
    expect(limitsFor(org)).toEqual(FREE_LIMITS);
  });

  test("pro plan incomplete → FREE_LIMITS", () => {
    const org: OrgPlanRef = { plan: "pro", subscription_status: "incomplete" };
    expect(limitsFor(org)).toEqual(FREE_LIMITS);
  });

  test("free plan active → FREE_LIMITS (active doesn't upgrade free)", () => {
    const org: OrgPlanRef = { plan: "free", subscription_status: "active" };
    expect(limitsFor(org)).toEqual(FREE_LIMITS);
  });

  test("FREE_LIMITS has correct shape", () => {
    expect(FREE_LIMITS.max_members).toBe(1);
    expect(FREE_LIMITS.max_projects).toBe(1);
    expect(FREE_LIMITS.retention_days).toBe(7);
    expect(FREE_LIMITS.peer_share_enabled).toBe(false);
    expect(FREE_LIMITS.ai_features).toBe(false);
    expect(FREE_LIMITS.digest_enabled).toBe(true);
  });

  test("PRO_LIMITS has correct shape", () => {
    expect(PRO_LIMITS.max_members).toBe(Number.POSITIVE_INFINITY);
    expect(PRO_LIMITS.max_projects).toBe(Number.POSITIVE_INFINITY);
    expect(PRO_LIMITS.retention_days).toBe(90);
    expect(PRO_LIMITS.peer_share_enabled).toBe(true);
    expect(PRO_LIMITS.ai_features).toBe(true);
    expect(PRO_LIMITS.digest_enabled).toBe(true);
  });

  test("TEAM_LIMITS extends PRO with longer retention", () => {
    expect(TEAM_LIMITS.retention_days).toBe(365);
    expect(TEAM_LIMITS.ai_features).toBe(true);
    expect(TEAM_LIMITS.peer_share_enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// retentionCutoff
// ---------------------------------------------------------------------------

describe("retentionCutoff", () => {
  const now = new Date("2026-04-29T12:00:00Z");

  test("free tier → cutoff 7 days ago", () => {
    const cutoff = retentionCutoff(FREE_LIMITS, now);
    const expectedMs = now.getTime() - 7 * 24 * 3600_000;
    expect(Math.abs(cutoff.getTime() - expectedMs)).toBeLessThan(1000);
  });

  test("pro tier → cutoff 90 days ago", () => {
    const cutoff = retentionCutoff(PRO_LIMITS, now);
    const expectedMs = now.getTime() - 90 * 24 * 3600_000;
    expect(Math.abs(cutoff.getTime() - expectedMs)).toBeLessThan(1000);
  });

  test("team tier → cutoff 365 days ago", () => {
    const cutoff = retentionCutoff(TEAM_LIMITS, now);
    const expectedMs = now.getTime() - 365 * 24 * 3600_000;
    expect(Math.abs(cutoff.getTime() - expectedMs)).toBeLessThan(1000);
  });

  test("infinite retention_days → epoch (no cutoff)", () => {
    const infiniteLimits = { ...FREE_LIMITS, retention_days: Number.POSITIVE_INFINITY };
    const cutoff = retentionCutoff(infiniteLimits, now);
    expect(cutoff.getTime()).toBe(new Date(0).getTime());
  });
});

// ---------------------------------------------------------------------------
// requirePlan
// ---------------------------------------------------------------------------

describe("requirePlan", () => {
  test("free org fails 'pro' check", () => {
    const org: OrgPlanRef = { plan: "free", subscription_status: null };
    expect(() => requirePlan(org, "pro")).toThrow(PlanGateError);
  });

  test("pro org passes 'pro' check", () => {
    const org: OrgPlanRef = { plan: "pro", subscription_status: "active" };
    expect(() => requirePlan(org, "pro")).not.toThrow();
  });

  test("team org passes 'pro' check", () => {
    const org: OrgPlanRef = { plan: "team", subscription_status: "active" };
    expect(() => requirePlan(org, "pro")).not.toThrow();
  });

  test("pro org fails 'team' check", () => {
    const org: OrgPlanRef = { plan: "pro", subscription_status: "active" };
    expect(() => requirePlan(org, "team")).toThrow(PlanGateError);
  });

  test("team org passes 'team' check", () => {
    const org: OrgPlanRef = { plan: "team", subscription_status: "active" };
    expect(() => requirePlan(org, "team")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PlanGateError
// ---------------------------------------------------------------------------

describe("PlanGateError", () => {
  test("defaults to 402", () => {
    const err = new PlanGateError("test");
    expect(err.status).toBe(402);
    expect(err.name).toBe("PlanGateError");
    expect(err.message).toBe("test");
  });

  test("accepts 403", () => {
    const err = new PlanGateError("admin only", 403);
    expect(err.status).toBe(403);
  });

  test("is instanceof Error", () => {
    const err = new PlanGateError("test");
    expect(err instanceof Error).toBe(true);
    expect(err instanceof PlanGateError).toBe(true);
  });
});
