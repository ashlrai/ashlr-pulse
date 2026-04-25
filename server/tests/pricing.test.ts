import { describe, expect, test } from "bun:test";
import { costUsdCents, fmtUsd } from "../src/lib/pricing";

describe("costUsdCents", () => {
  test("opus 4.7 — 1M in / 1M out = $15 + $75 = $90", () => {
    const cents = costUsdCents({
      model: "claude-opus-4-7",
      tokens_input: 1_000_000,
      tokens_output: 1_000_000,
    });
    expect(cents).toBe(9000);
  });

  test("sonnet 4.6 — covers cache read/write", () => {
    const cents = costUsdCents({
      model: "claude-sonnet-4-6",
      tokens_input: 100_000,
      tokens_output: 100_000,
      tokens_cache_read: 100_000,
      tokens_cache_write: 100_000,
    });
    // $0.30 + $1.50 + $0.03 + $0.375 = $2.205 → 220 (rounded) or 221
    expect(cents).toBeGreaterThanOrEqual(220);
    expect(cents).toBeLessThanOrEqual(221);
  });

  test("unknown model → null", () => {
    expect(costUsdCents({ model: "fictional-model-9", tokens_input: 1, tokens_output: 1 })).toBeNull();
  });

  test("null model → null", () => {
    expect(costUsdCents({ model: null, tokens_input: 1, tokens_output: 1 })).toBeNull();
  });

  test("null tokens treated as zero", () => {
    expect(
      costUsdCents({ model: "gpt-4o", tokens_input: null, tokens_output: null }),
    ).toBe(0);
  });
});

describe("fmtUsd", () => {
  test.each([
    [null, "—"],
    [undefined, "—"],
    [0, "$0.00"],
    [9, "$0.0900"],     // sub-dime → 4 decimals so we don't round to "$0.00"
    [123, "$1.23"],
    [9000, "$90.00"],
  ])("%s → %s", (cents, expected) => {
    expect(fmtUsd(cents as number | null | undefined)).toBe(expected);
  });
});
