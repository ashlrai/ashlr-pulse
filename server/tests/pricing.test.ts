import { describe, expect, test } from "bun:test";
import { costUsdCents, fmtUsd } from "../src/lib/pricing";

describe("costUsdCents", () => {
  test("opus 4.7 — current rates: 1M in / 1M out = $5 + $25 = $30", () => {
    const cents = costUsdCents({
      model: "claude-opus-4-7",
      tokens_input: 1_000_000,
      tokens_output: 1_000_000,
    });
    expect(cents).toBe(3000);
  });

  test("opus 4.7 — cache 5m + 1h split priced separately", () => {
    // 1M cache_5m_write at $6.25 + 1M cache_1h_write at $10 = $16.25
    const cents = costUsdCents({
      model: "claude-opus-4-7",
      tokens_input: 0,
      tokens_output: 0,
      tokens_cache_5m_write: 1_000_000,
      tokens_cache_1h_write: 1_000_000,
    });
    expect(cents).toBe(1625);
  });

  test("opus 4.7 — legacy flat tokens_cache_write priced at 1h rate", () => {
    // 1M legacy cache_write @ $10/M (the 1h rate, since cmux defaults to 1h) = $10
    const cents = costUsdCents({
      model: "claude-opus-4-7",
      tokens_input: 0,
      tokens_output: 0,
      tokens_cache_write: 1_000_000,
    });
    expect(cents).toBe(1000);
  });

  test("opus 4.7 — split fields take precedence over legacy flat", () => {
    // When both are set, only the split fields are used (legacy ignored).
    const cents = costUsdCents({
      model: "claude-opus-4-7",
      tokens_input: 0,
      tokens_output: 0,
      tokens_cache_5m_write: 1_000_000, // $6.25
      tokens_cache_1h_write: 0,
      tokens_cache_write: 999_999_999,  // ignored
    });
    expect(cents).toBe(625);
  });

  test("opus 4.1 (legacy) still bills at old $15/$75 rates", () => {
    // Old Opus 4 / 4.1 IDs are NOT deprecated — keep at the legacy prices.
    const cents = costUsdCents({
      model: "claude-opus-4-1",
      tokens_input: 1_000_000,
      tokens_output: 1_000_000,
    });
    expect(cents).toBe(9000);
  });

  test("sonnet 4.6 — input/output/cache read/cache 5m+1h", () => {
    // 100k in @ $3/M = $0.30
    // 100k out @ $15/M = $1.50
    // 100k cache_read @ $0.30/M = $0.03
    // 100k cache_5m_write @ $3.75/M = $0.375
    // 100k cache_1h_write @ $6/M = $0.60
    // total = $2.805 → 280 cents (rounded)
    const cents = costUsdCents({
      model: "claude-sonnet-4-6",
      tokens_input: 100_000,
      tokens_output: 100_000,
      tokens_cache_read: 100_000,
      tokens_cache_5m_write: 100_000,
      tokens_cache_1h_write: 100_000,
    });
    expect(cents).toBeGreaterThanOrEqual(280);
    expect(cents).toBeLessThanOrEqual(281);
  });

  test("haiku 4.5 — current rates", () => {
    const cents = costUsdCents({
      model: "claude-haiku-4-5",
      tokens_input: 1_000_000,
      tokens_output: 1_000_000,
    });
    // 1M @ $1 + 1M @ $5 = $6
    expect(cents).toBe(600);
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
    [3000, "$30.00"],
  ])("%s → %s", (cents, expected) => {
    expect(fmtUsd(cents as number | null | undefined)).toBe(expected);
  });
});
