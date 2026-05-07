import { describe, expect, test } from "bun:test";
import { costUsdCents, costMillicents, millicentsToCents, fmtUsd, PRICE_VERSION } from "../src/lib/pricing";

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

describe("reasoning tokens", () => {
  test("opus 4.7 — reasoning billed at output rate by default", () => {
    // 1M reasoning tokens × $25/M = $25.00 = 2500 cents
    const cents = costUsdCents({
      model: "claude-opus-4-7",
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 1_000_000,
    });
    expect(cents).toBe(2500);
  });

  test("reasoning + output adds correctly", () => {
    // 100k input ($5/M=$0.50) + 100k output ($25/M=$2.50) + 100k reasoning ($25/M=$2.50) = $5.50
    const cents = costUsdCents({
      model: "claude-opus-4-7",
      tokens_input: 100_000,
      tokens_output: 100_000,
      tokens_reasoning: 100_000,
    });
    expect(cents).toBe(550);
  });

  test("null reasoning treated as zero", () => {
    const cents = costUsdCents({
      model: "claude-opus-4-7",
      tokens_input: 1_000_000,
      tokens_output: 1_000_000,
      tokens_reasoning: null,
    });
    expect(cents).toBe(3000);
  });
});

describe("costMillicents", () => {
  test("returns 1000× costUsdCents for round inputs", () => {
    const usage = {
      model: "claude-opus-4-7",
      tokens_input: 1_000_000,
      tokens_output: 1_000_000,
    };
    expect(costMillicents(usage)).toBe(3_000_000);
    expect(costUsdCents(usage)).toBe(3000);
  });

  test("preserves sub-cent precision that costUsdCents rounds away", () => {
    // 100 input tokens at $5/M = 0.0005 dollars = 0.05 cents = 50 millicents
    const m = costMillicents({
      model: "claude-opus-4-7",
      tokens_input: 100,
      tokens_output: 0,
    });
    expect(m).toBe(50);            // exact in millicents
    expect(costUsdCents({ model: "claude-opus-4-7", tokens_input: 100, tokens_output: 0 })).toBe(0); // rounds to 0¢
  });

  test("unknown model → null", () => {
    expect(costMillicents({ model: "fictional", tokens_input: 1, tokens_output: 1 })).toBeNull();
  });
});

describe("millicentsToCents", () => {
  test.each([
    [null, null],
    [undefined, null],
    [0, 0],
    [499, 0],     // sub-cent rounds down
    [500, 1],     // half rounds up
    [3_000_000, 3000],
  ])("%s → %s", (m, expected) => {
    expect(millicentsToCents(m as number | null | undefined)).toBe(expected);
  });
});

describe("PRICE_VERSION", () => {
  test("is a positive integer that can be persisted", () => {
    expect(typeof PRICE_VERSION).toBe("number");
    expect(PRICE_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(PRICE_VERSION)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Newly-added models from Anthropic's published rate card (2026-05-06).
// One canary test per model — proves the rate sheet entries are correct
// and that normalizeModel maps the dated/legacy variants to them.
// ---------------------------------------------------------------------------

describe("rate sheet — full Anthropic table", () => {
  // 1M tokens of pure input keeps the math obvious: cents == base rate × 100.
  const oneMInput = (model: string): number | null =>
    costUsdCents({ model, tokens_input: 1_000_000, tokens_output: 0, ts: new Date("2026-05-06") });

  test.each([
    ["claude-opus-4-7",   500],   // $5 / M input
    ["claude-opus-4-6",   500],
    ["claude-opus-4-5",   500],
    ["claude-opus-4-1",   1500],  // $15 / M (legacy)
    ["claude-opus-4",     1500],
    ["claude-sonnet-4-6", 300],   // $3 / M
    ["claude-sonnet-4-5", 300],
    ["claude-sonnet-4",   300],
    ["claude-sonnet-3-7", 300],
    ["claude-sonnet-3-5", 300],
    ["claude-haiku-4-5",  100],   // $1 / M
    ["claude-haiku-3-5",  80],    // $0.80 / M
    ["claude-haiku-3",    25],    // $0.25 / M
    ["claude-opus-3",     1500],  // $15 / M (deprecated)
  ])("1M input on %s → %s¢", (model, expectedCents) => {
    expect(oneMInput(model)).toBe(expectedCents);
  });

  test.each([
    ["claude-opus-4-7",   2500],
    ["claude-opus-4-1",   7500],
    ["claude-sonnet-4-6", 1500],
    ["claude-haiku-4-5",  500],
    ["claude-haiku-3-5",  400],
    ["claude-haiku-3",    125],
  ])("1M output on %s → %s¢", (model, expectedCents) => {
    expect(
      costUsdCents({ model, tokens_input: 0, tokens_output: 1_000_000, ts: new Date("2026-05-06") }),
    ).toBe(expectedCents);
  });

  test("Haiku 3.5 cache rates match Anthropic table (cache_read $0.08, 5m $1, 1h $1.6)", () => {
    // 1M tokens through each cache slot, in cents.
    const cents = costUsdCents({
      model: "claude-haiku-3-5",
      tokens_input: 0, tokens_output: 0,
      tokens_cache_read: 1_000_000,
      tokens_cache_5m_write: 1_000_000,
      tokens_cache_1h_write: 1_000_000,
      ts: new Date("2026-05-06"),
    });
    // 0.08 + 1 + 1.6 = $2.68 = 268 cents
    expect(cents).toBe(268);
  });
});

// ---------------------------------------------------------------------------
// normalizeModel — maps dated/legacy API IDs to canonical PRICES keys.
// ---------------------------------------------------------------------------

import { normalizeModel } from "../src/lib/pricing";

describe("normalizeModel", () => {
  test("already-canonical names pass through unchanged", () => {
    expect(normalizeModel("claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(normalizeModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizeModel("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  test("strips trailing -YYYYMMDD date suffix", () => {
    expect(normalizeModel("claude-opus-4-20250514")).toBe("claude-opus-4");
    expect(normalizeModel("claude-opus-4-1-20250805")).toBe("claude-opus-4-1");
    expect(normalizeModel("claude-sonnet-4-20250101")).toBe("claude-sonnet-4");
  });

  test("rewrites legacy claude-3-X-FAMILY → claude-FAMILY-3-X", () => {
    expect(normalizeModel("claude-3-5-haiku-20241022")).toBe("claude-haiku-3-5");
    expect(normalizeModel("claude-3-5-sonnet-20241022")).toBe("claude-sonnet-3-5");
    expect(normalizeModel("claude-3-7-sonnet-20250219")).toBe("claude-sonnet-3-7");
    expect(normalizeModel("claude-3-opus-20240229")).toBe("claude-opus-3");
    expect(normalizeModel("claude-3-haiku-20240307")).toBe("claude-haiku-3");
  });

  test("legacy form without date works too", () => {
    expect(normalizeModel("claude-3-5-haiku")).toBe("claude-haiku-3-5");
    expect(normalizeModel("claude-3-opus")).toBe("claude-opus-3");
  });

  test("unknown strings pass through (lookup returns null → renders '—')", () => {
    expect(normalizeModel("claude-unknown-99")).toBe("claude-unknown-99");
    expect(normalizeModel("<synthetic>")).toBe("<synthetic>");
    expect(normalizeModel("gpt-5-future")).toBe("gpt-5-future");
  });
});

describe("end-to-end — dated API ID prices correctly via normalizer", () => {
  test("claude-3-5-haiku-20241022 prices like claude-haiku-3-5", () => {
    const cents = costUsdCents({
      model: "claude-3-5-haiku-20241022",
      tokens_input: 1_000_000, tokens_output: 0,
      ts: new Date("2026-05-06"),
    });
    expect(cents).toBe(80); // $0.80 / M
  });

  test("claude-opus-4-20250514 prices like claude-opus-4 ($15 / M)", () => {
    const cents = costUsdCents({
      model: "claude-opus-4-20250514",
      tokens_input: 1_000_000, tokens_output: 0,
      ts: new Date("2026-05-06"),
    });
    expect(cents).toBe(1500);
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
