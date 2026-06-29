/**
 * billing-export.test.ts — tests for lib/billing-export.ts.
 *
 * Three test suites (all pure, no DB required):
 *
 *   1. computeHours — 8h cap logic
 *      Verifies the hours-cap applies correctly, edge cases (single event,
 *      clock skew, invalid timestamps), and the capped flag is set only
 *      when the raw wall-clock span exceeds HOURS_CAP.
 *
 *   2. Plan-gate rejection simulation — free tier → 402
 *      Mirrors the route auth chain: free-tier org is rejected before
 *      aggregation runs. Pro/Team orgs pass through.
 *
 *   3. CSV format validation — headers, row count, no NaN/null in money columns
 *      Verifies billingCsvHeader() / billingCsvRow() produce RFC 4180-
 *      compatible CSV with the right column count and no bad numeric values.
 */

import { describe, test, expect } from "bun:test";
import {
  computeHours,
  millicentsToUsd,
  billingCsvHeader,
  billingCsvRow,
  BILLING_CSV_COLUMNS,
  HOURS_CAP,
  type BillingExportRecord,
} from "../src/lib/billing-export";
import {
  requirePlan,
  PlanGateError,
  type OrgPlanRef,
} from "../src/lib/plan-gate";

// ---------------------------------------------------------------------------
// 1. computeHours — 8h cap logic
// ---------------------------------------------------------------------------

describe("computeHours", () => {
  test("HOURS_CAP is exactly 8", () => {
    expect(HOURS_CAP).toBe(8);
  });

  test("returns 0h not capped for a single event (same first + last ts)", () => {
    const ts = "2026-06-01T09:00:00.000Z";
    const { hours, capped } = computeHours(ts, ts);
    expect(hours).toBe(0);
    expect(capped).toBe(false);
  });

  test("returns correct hours for a 2-hour session (no cap)", () => {
    const first = "2026-06-01T09:00:00.000Z";
    const last  = "2026-06-01T11:00:00.000Z";
    const { hours, capped } = computeHours(first, last);
    expect(hours).toBe(2);
    expect(capped).toBe(false);
  });

  test("returns exactly HOURS_CAP and capped=true when span is > 8h", () => {
    const first = "2026-06-01T00:00:00.000Z";
    const last  = "2026-06-01T23:59:00.000Z"; // ~24h
    const { hours, capped } = computeHours(first, last);
    expect(hours).toBe(HOURS_CAP);
    expect(capped).toBe(true);
  });

  test("returns exactly HOURS_CAP and capped=true for exactly 8h + 1ms span", () => {
    const t0 = new Date("2026-06-01T08:00:00.000Z").getTime();
    const t1 = t0 + HOURS_CAP * 3_600_000 + 1; // 8h + 1ms
    const { hours, capped } = computeHours(
      new Date(t0).toISOString(),
      new Date(t1).toISOString(),
    );
    expect(hours).toBe(HOURS_CAP);
    expect(capped).toBe(true);
  });

  test("returns HOURS_CAP with capped=false for exactly 8h span (no overage)", () => {
    const first = "2026-06-01T08:00:00.000Z";
    const last  = "2026-06-01T16:00:00.000Z"; // exactly 8h
    const { hours, capped } = computeHours(first, last);
    expect(hours).toBe(8);
    expect(capped).toBe(false);
  });

  test("returns 0h not capped for null firstTs", () => {
    const { hours, capped } = computeHours(null, "2026-06-01T12:00:00.000Z");
    expect(hours).toBe(0);
    expect(capped).toBe(false);
  });

  test("returns 0h not capped for null lastTs", () => {
    const { hours, capped } = computeHours("2026-06-01T09:00:00.000Z", null);
    expect(hours).toBe(0);
    expect(capped).toBe(false);
  });

  test("returns 0h not capped for both null", () => {
    const { hours, capped } = computeHours(null, null);
    expect(hours).toBe(0);
    expect(capped).toBe(false);
  });

  test("returns 0h not capped for invalid timestamp strings", () => {
    const { hours, capped } = computeHours("not-a-date", "also-bad");
    expect(hours).toBe(0);
    expect(capped).toBe(false);
  });

  test("returns 0h not capped when lastTs < firstTs (clock skew)", () => {
    const { hours, capped } = computeHours(
      "2026-06-01T12:00:00.000Z",
      "2026-06-01T08:00:00.000Z",
    );
    expect(hours).toBe(0);
    expect(capped).toBe(false);
  });

  test("30-minute session returns 0.5h not capped", () => {
    const first = "2026-06-01T10:00:00.000Z";
    const last  = "2026-06-01T10:30:00.000Z";
    const { hours, capped } = computeHours(first, last);
    expect(hours).toBe(0.5);
    expect(capped).toBe(false);
  });

  test("hours value is never NaN regardless of input", () => {
    const cases: Array<[string | null | undefined, string | null | undefined]> = [
      [null, null],
      [undefined, undefined],
      ["", ""],
      ["bad", "bad"],
      ["2026-06-01T09:00:00Z", null],
      [null, "2026-06-01T09:00:00Z"],
    ];
    for (const [a, b] of cases) {
      const { hours } = computeHours(a as string, b as string);
      expect(Number.isNaN(hours)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Plan-gate rejection — free tier → 402, Pro/Team pass through
// ---------------------------------------------------------------------------

/**
 * Simulate the plan-gate check performed by the export route.
 * Returns the HTTP status that the route would respond with.
 */
function simulateExportGate(org: OrgPlanRef | null): 401 | 403 | 402 | 200 {
  if (!org) return 403; // no org → 403
  try {
    requirePlan(org, "pro");
    return 200;
  } catch (err) {
    if (err instanceof PlanGateError) return err.status;
    throw err;
  }
}

describe("billing export plan-gate", () => {
  test("free tier org → 402 Payment Required", () => {
    const org: OrgPlanRef = { plan: "free", subscription_status: null };
    expect(simulateExportGate(org)).toBe(402);
  });

  test("free tier with active subscription → 402 (active doesn't upgrade free)", () => {
    const org: OrgPlanRef = { plan: "free", subscription_status: "active" };
    expect(simulateExportGate(org)).toBe(402);
  });

  test("pro plan active → 200", () => {
    const org: OrgPlanRef = { plan: "pro", subscription_status: "active" };
    expect(simulateExportGate(org)).toBe(200);
  });

  test("pro plan trialing → 200 (trial gets full access)", () => {
    const org: OrgPlanRef = { plan: "pro", subscription_status: "trialing" };
    expect(simulateExportGate(org)).toBe(200);
  });

  test("team plan active → 200", () => {
    const org: OrgPlanRef = { plan: "team", subscription_status: "active" };
    expect(simulateExportGate(org)).toBe(200);
  });

  test("pro plan past_due → 200 (requirePlan checks tier only, not status)", () => {
    // requirePlan() gates on the plan field only; limitsFor() handles status
    // downgrades. The route uses requirePlan — a past_due pro org can still
    // call the endpoint (they have the plan), letting them export before
    // their subscription lapses completely.
    const org: OrgPlanRef = { plan: "pro", subscription_status: "past_due" };
    expect(simulateExportGate(org)).toBe(200);
  });

  test("pro plan canceled → 200 (requirePlan checks tier only, not status)", () => {
    const org: OrgPlanRef = { plan: "pro", subscription_status: "canceled" };
    expect(simulateExportGate(org)).toBe(200);
  });

  test("null org (no org) → 403", () => {
    expect(simulateExportGate(null)).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 3. CSV format validation
// ---------------------------------------------------------------------------

function makeSampleRecord(overrides: Partial<BillingExportRecord> = {}): BillingExportRecord {
  return {
    date: "2026-06-01",
    repo: "acme/api",
    model: "claude-sonnet-4-5",
    hours_worked: 1.5,
    hours_capped: false,
    tokens_input: 12_000,
    tokens_output: 3_400,
    cost_usd: 0.042180,
    event_count: 47,
    ...overrides,
  };
}

describe("CSV format", () => {
  test("billingCsvHeader returns all BILLING_CSV_COLUMNS in order", () => {
    const header = billingCsvHeader();
    const cols = header.split(",");
    expect(cols).toEqual([...BILLING_CSV_COLUMNS]);
  });

  test("BILLING_CSV_COLUMNS has exactly 8 columns", () => {
    expect(BILLING_CSV_COLUMNS.length).toBe(8);
  });

  test("billingCsvRow produces one value per column for a normal record", () => {
    const row = billingCsvRow(makeSampleRecord());
    const fields = row.split(",");
    expect(fields.length).toBe(BILLING_CSV_COLUMNS.length);
  });

  test("cost_usd column never produces NaN or null as a string", () => {
    const cases = [0, 0.042180, 1.234567, 0.000001];
    for (const cost of cases) {
      const row = billingCsvRow(makeSampleRecord({ cost_usd: cost }));
      expect(row).not.toContain("NaN");
      expect(row).not.toContain("null");
      expect(row).not.toContain("undefined");
    }
  });

  test("tokens_input and tokens_output are plain integers (no NaN/null)", () => {
    const row = billingCsvRow(makeSampleRecord({ tokens_input: 5000, tokens_output: 1200 }));
    expect(row).not.toContain("NaN");
    expect(row).not.toContain("null");
    expect(row).toContain("5000");
    expect(row).toContain("1200");
  });

  test("hours_worked renders correctly (non-integer)", () => {
    const row = billingCsvRow(makeSampleRecord({ hours_worked: 3.75 }));
    expect(row).toContain("3.75");
  });

  test("RFC 4180 quoting: repo containing comma is quoted", () => {
    const row = billingCsvRow(makeSampleRecord({ repo: "acme/api,suffix" }));
    expect(row).toContain('"acme/api,suffix"');
  });

  test("RFC 4180 quoting: double-quotes in values are doubled", () => {
    const row = billingCsvRow(makeSampleRecord({ model: 'say "hello"' }));
    expect(row).toContain('"say ""hello"""');
  });

  test("multiple rows produce correct line count when joined", () => {
    const records = [
      makeSampleRecord({ date: "2026-06-01" }),
      makeSampleRecord({ date: "2026-06-02" }),
      makeSampleRecord({ date: "2026-06-03" }),
    ];
    const csv = billingCsvHeader() + "\n" + records.map((r) => billingCsvRow(r)).join("\n");
    const lines = csv.split("\n").filter((l) => l.trim().length > 0);
    // 1 header + 3 data rows
    expect(lines.length).toBe(4);
  });

  test("empty record set produces only header line", () => {
    const csv = billingCsvHeader() + "\n";
    const lines = csv.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe(BILLING_CSV_COLUMNS.join(","));
  });
});

// ---------------------------------------------------------------------------
// 4. millicentsToUsd helper
// ---------------------------------------------------------------------------

describe("millicentsToUsd", () => {
  test("converts 100_000 millicents to 1 USD", () => {
    expect(millicentsToUsd(100_000)).toBe(1);
  });

  test("handles bigint input", () => {
    expect(millicentsToUsd(BigInt(50_000))).toBe(0.5);
  });

  test("handles string input", () => {
    expect(millicentsToUsd("200000")).toBe(2);
  });

  test("returns 0 for null", () => {
    expect(millicentsToUsd(null)).toBe(0);
  });

  test("returns 0 for undefined", () => {
    expect(millicentsToUsd(undefined)).toBe(0);
  });

  test("returns 0 for NaN", () => {
    expect(millicentsToUsd(NaN)).toBe(0);
  });

  test("returns 0 for non-numeric string", () => {
    expect(millicentsToUsd("bad")).toBe(0);
  });

  test("result is never NaN for any numeric input", () => {
    const inputs = [0, 1, -1, 999999, 0.5, Infinity, -Infinity, NaN];
    for (const v of inputs) {
      const result = millicentsToUsd(v);
      expect(Number.isNaN(result)).toBe(false);
    }
  });
});
