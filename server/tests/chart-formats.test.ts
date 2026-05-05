/**
 * chart-formats.test.ts — lock down number formatting + protect against
 * the original Server→Client function-prop bug.
 *
 * The /app dashboard crashed in production because chart components
 * received formatter functions from server pages, which is a hard error
 * in Next.js / RSC. The fix replaced function props with FormatKey
 * strings and a single formatNumber() lookup. These tests pin the
 * formatter outputs so a refactor of the lookup table fails CI before
 * users see broken tooltips.
 */

import { describe, expect, test } from "bun:test";
import {
  formatNumber,
  valueFormatForMetric,
  yFormatForMetric,
  type FormatKey,
} from "../src/lib/chart-formats";

describe("formatNumber", () => {
  test.each<[FormatKey, number, string]>([
    // abbrev — k/M/B for the body of the dashboard.
    ["abbrev", 0, "0"],
    ["abbrev", 999, "999"],
    ["abbrev", 1_500, "1.5k"],
    ["abbrev", 1_234_567, "1.2M"],
    ["abbrev", 2_500_000_000, "2.5B"],
    // locale — counts with thousands separators.
    ["locale", 0, "0"],
    ["locale", 12_345, "12,345"],
    // int / decimals — Y-axis ticks.
    ["int", 3.7, "4"],
    ["decimal-1", 3.45, "3.5"],
    ["decimal-2", 3.456, "3.46"],
    // ratio — cache efficiency.
    ["ratio", 3.4, "3.40×"],
    ["ratio", 0, "0.00×"],
    // dollars — cost trajectory.
    ["dollars-int", 5, "$5"],
    ["dollars-int", 5.99, "$6"],
    ["dollars-2dp", 3.4, "$3.40"],
    ["dollars-2dp", 0, "$0.00"],
    // percent — cache_hit_ratio in /ask.
    ["percent", 0.78, "78.0%"],
    ["percent", 1, "100.0%"],
    ["percent", 0, "0.0%"],
  ])("(%s, %s) → %s", (key, n, expected) => {
    expect(formatNumber(key, n)).toBe(expected);
  });

  test("coerces string inputs from recharts payloads", () => {
    expect(formatNumber("abbrev", "1500")).toBe("1.5k");
    expect(formatNumber("dollars-2dp", "3.4")).toBe("$3.40");
  });

  test.each([undefined, null, "", "not-a-number"])(
    "returns empty string for non-numeric: %p",
    (v) => {
      expect(
        formatNumber("abbrev", v as number | string | undefined),
      ).toBe("");
    },
  );

  test("falls back to abbrev when key is undefined", () => {
    expect(formatNumber(undefined, 1_234_567)).toBe("1.2M");
  });

  test("handles negative values", () => {
    expect(formatNumber("abbrev", -1500)).toBe("-1.5k");
    expect(formatNumber("dollars-2dp", -3.4)).toBe("$-3.40");
  });
});

describe("valueFormatForMetric", () => {
  test.each([
    ["cost", "dollars-2dp"],
    ["cache_hit_ratio", "percent"],
    ["tokens", "abbrev"],
    ["events", "locale"],
    ["unknown_metric", "locale"],
  ])("%s → %s", (metric, expected) => {
    expect(valueFormatForMetric(metric)).toBe(expected as FormatKey);
  });
});

describe("yFormatForMetric", () => {
  test.each([
    ["cost", "dollars-int"],
    ["cache_hit_ratio", "percent"],
    ["tokens", "locale"],
    ["events", "locale"],
  ])("%s → %s", (metric, expected) => {
    expect(yFormatForMetric(metric)).toBe(expected as FormatKey);
  });
});
