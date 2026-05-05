/**
 * pricing.ts — model → token price table, evaluated at query time.
 *
 * Per ARCHITECTURE.md:201 we store tokens, not dollars: pricing changes
 * over time, and we want yesterday's spend to revalue against today's
 * understanding of the bill (and vice versa for retroactive backfills).
 *
 * Prices are USD per 1M tokens. Update entries with a new `effective`
 * date when a vendor changes their rate sheet — the lookup picks the
 * most recent entry whose effective date is <= the event timestamp.
 *
 * Anthropic's prompt-cache pricing breaks out by ephemeral lifetime:
 *   - 5-minute write: 1.25× base input
 *   - 1-hour write:    2.00× base input
 *   - read:            0.10× base input
 * Claude Code emits both `cache_creation.ephemeral_5m_input_tokens` and
 * `ephemeral_1h_input_tokens` separately on each assistant message — we
 * parse both in agent/src/claude.rs and price them with the correct
 * multiplier here. Pre-2026-04 rows have only the flat `cache_write`
 * total; we treat that as 1h (the more conservative assumption for
 * cmux-style long-running sessions where 1h cache dominates).
 *
 * Unknown models fall through to ZERO so partial coverage doesn't
 * silently invent dollars; the dashboard renders "—" in that case.
 *
 * Reasoning tokens (Anthropic extended-thinking) are priced at
 * output_per_m_usd by default. Override per-model with
 * reasoning_per_m_usd if a vendor charges differently.
 *
 * PRICE_VERSION bumps when the rate table changes meaningfully (new
 * model added, rate changed). Stored in activity_event.pricing_version
 * at ingest so we can re-price old rows when this number advances.
 */

export const PRICE_VERSION = 2 as const;
export function priceVersion(): number { return PRICE_VERSION; }

export interface Price {
  effective: string;        // YYYY-MM-DD; >= this date this row applies
  input_per_m_usd: number;
  output_per_m_usd: number;
  /** Anthropic extended-thinking reasoning tokens. Defaults to output rate. */
  reasoning_per_m_usd?: number;
  /** 5-minute ephemeral cache write. If absent, falls back to legacy cache_write. */
  cache_5m_write_per_m_usd?: number;
  /** 1-hour ephemeral cache write. If absent, falls back to 2× input or legacy cache_write. */
  cache_1h_write_per_m_usd?: number;
  /** Cache read (uniform for both 5m + 1h reads). */
  cache_read_per_m_usd?: number;
  /**
   * Legacy field: pre-split cache_write rate. Kept for backwards-compat
   * with rows that haven't migrated to the 5m/1h split. New entries
   * should use cache_5m_write + cache_1h_write instead.
   */
  cache_write_per_m_usd?: number;
}

const PRICES: Record<string, Price[]> = {
  // ── Anthropic Opus 4.x — pricing reset to $5/$25 with the 4.5 release ──
  "claude-opus-4-7": [
    {
      effective: "2026-01-01",
      input_per_m_usd: 5, output_per_m_usd: 25,
      cache_5m_write_per_m_usd: 6.25, cache_1h_write_per_m_usd: 10,
      cache_read_per_m_usd: 0.50,
      cache_write_per_m_usd: 10, // legacy fallback — assume 1h for cmux
    },
  ],
  "claude-opus-4-6": [
    {
      effective: "2026-01-01",
      input_per_m_usd: 5, output_per_m_usd: 25,
      cache_5m_write_per_m_usd: 6.25, cache_1h_write_per_m_usd: 10,
      cache_read_per_m_usd: 0.50,
      cache_write_per_m_usd: 10,
    },
  ],
  "claude-opus-4-5": [
    {
      effective: "2026-01-01",
      input_per_m_usd: 5, output_per_m_usd: 25,
      cache_5m_write_per_m_usd: 6.25, cache_1h_write_per_m_usd: 10,
      cache_read_per_m_usd: 0.50,
      cache_write_per_m_usd: 10,
    },
  ],
  // Legacy Opus 4 / 4.1 still on the price sheet at the OLD $15/$75 rates.
  "claude-opus-4-1": [
    {
      effective: "2025-01-01",
      input_per_m_usd: 15, output_per_m_usd: 75,
      cache_5m_write_per_m_usd: 18.75, cache_1h_write_per_m_usd: 30,
      cache_read_per_m_usd: 1.50,
      cache_write_per_m_usd: 30,
    },
  ],
  "claude-opus-4": [
    {
      effective: "2024-05-01",
      input_per_m_usd: 15, output_per_m_usd: 75,
      cache_5m_write_per_m_usd: 18.75, cache_1h_write_per_m_usd: 30,
      cache_read_per_m_usd: 1.50,
      cache_write_per_m_usd: 30,
    },
  ],

  // ── Anthropic Sonnet 4.x — uniform $3/$15 across 4.5 and 4.6 ──
  "claude-sonnet-4-6": [
    {
      effective: "2026-01-01",
      input_per_m_usd: 3, output_per_m_usd: 15,
      cache_5m_write_per_m_usd: 3.75, cache_1h_write_per_m_usd: 6,
      cache_read_per_m_usd: 0.30,
      cache_write_per_m_usd: 6,
    },
  ],
  "claude-sonnet-4-5": [
    {
      effective: "2025-09-01",
      input_per_m_usd: 3, output_per_m_usd: 15,
      cache_5m_write_per_m_usd: 3.75, cache_1h_write_per_m_usd: 6,
      cache_read_per_m_usd: 0.30,
      cache_write_per_m_usd: 6,
    },
  ],

  // ── Anthropic Haiku 4.5 ──
  "claude-haiku-4-5": [
    {
      effective: "2025-10-01",
      input_per_m_usd: 1, output_per_m_usd: 5,
      cache_5m_write_per_m_usd: 1.25, cache_1h_write_per_m_usd: 2,
      cache_read_per_m_usd: 0.10,
      cache_write_per_m_usd: 2,
    },
  ],

  // ── OpenAI ── (cache rates ignored — OpenAI bundles cached input
  //                into a single discounted rate)
  "gpt-4o":      [{ effective: "2025-01-01", input_per_m_usd: 2.5, output_per_m_usd: 10 }],
  "gpt-4o-mini": [{ effective: "2025-01-01", input_per_m_usd: 0.15, output_per_m_usd: 0.6 }],
};

function lookup(model: string, when: Date): Price | null {
  const ladder = PRICES[model];
  if (!ladder) return null;
  // Pick the most recent effective date that's not in the future.
  const wts = when.toISOString().slice(0, 10);
  let best: Price | null = null;
  for (const p of ladder) {
    if (p.effective <= wts && (!best || p.effective > best.effective)) {
      best = p;
    }
  }
  return best;
}

export interface UsageInput {
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  /** Anthropic extended-thinking reasoning tokens. Priced at output rate by default. */
  tokens_reasoning?: number | null;
  /** 5-minute ephemeral cache write tokens. Optional; only newer rows have it. */
  tokens_cache_5m_write?: number | null;
  /** 1-hour ephemeral cache write tokens. Optional; only newer rows have it. */
  tokens_cache_1h_write?: number | null;
  /** Read-back from cache (uniform price across 5m/1h). */
  tokens_cache_read?: number | null;
  /**
   * Legacy: flat cache write count. Used as a fallback when the row
   * predates the 5m/1h split. Priced at the conservative cache_1h rate.
   */
  tokens_cache_write?: number | null;
  /** Default: now. Pass the event ts for accurate retroactive pricing. */
  ts?: Date;
}

/**
 * Compute cost in millicents (1/1000 of a cent). Use this for ingest
 * caching and any aggregation that sums many small values — rounding
 * to integer cents per-event loses precision when sub-cent values
 * accumulate (very common: 100 input tokens at $5/M = 0.05¢ each
 * rounds to zero).
 *
 * Returns null when the model is unknown so callers can render "—"
 * instead of a fake $0.
 */
export function costMillicents(u: UsageInput): number | null {
  if (!u.model) return null;
  const p = lookup(u.model, u.ts ?? new Date());
  if (!p) return null;

  // Resolve cache write rates — prefer the split fields when present.
  const has5m = u.tokens_cache_5m_write != null && u.tokens_cache_5m_write > 0;
  const has1h = u.tokens_cache_1h_write != null && u.tokens_cache_1h_write > 0;
  const cache5mTokens = has5m ? (u.tokens_cache_5m_write ?? 0) : 0;
  const cache1hTokens = has1h ? (u.tokens_cache_1h_write ?? 0) : 0;
  const cache5mRate = p.cache_5m_write_per_m_usd ?? p.cache_write_per_m_usd ?? 0;
  const cache1hRate = p.cache_1h_write_per_m_usd ?? p.cache_write_per_m_usd ?? 0;

  // Legacy fallback: if neither split field is set but the flat one is,
  // bill it at the 1h rate. Real-world cmux sessions use 1h cache by
  // default, so this matches actual usage on un-migrated rows.
  const legacyCacheTokens = !has5m && !has1h ? (u.tokens_cache_write ?? 0) : 0;
  const legacyRate = p.cache_1h_write_per_m_usd ?? p.cache_write_per_m_usd ?? 0;

  // Reasoning tokens — Anthropic extended-thinking. Priced at output
  // rate unless the model overrides via reasoning_per_m_usd.
  const reasoningRate = p.reasoning_per_m_usd ?? p.output_per_m_usd;

  // dollars-per-token = rate / 1_000_000
  // millicents-per-token = (rate / 1_000_000) * 100 * 1000 = rate / 10
  // So cents-per-token × 1000 = millicents-per-token = (tokens × rate) / 10
  const millicents =
    ((u.tokens_input      ?? 0) * p.input_per_m_usd +
     (u.tokens_output     ?? 0) * p.output_per_m_usd +
     (u.tokens_reasoning  ?? 0) * reasoningRate +
     (u.tokens_cache_read ?? 0) * (p.cache_read_per_m_usd ?? 0) +
     cache5mTokens * cache5mRate +
     cache1hTokens * cache1hRate +
     legacyCacheTokens * legacyRate) /
    10;

  return Math.round(millicents);
}

/**
 * Cost in integer cents — for display and APIs that talked in cents
 * before millicents existed. Sub-cent values still round to an
 * integer, so for cumulative aggregates prefer summing millicents
 * via costMillicents() and rounding at display time.
 */
export function costUsdCents(u: UsageInput): number | null {
  const m = costMillicents(u);
  if (m == null) return null;
  return Math.round(m / 1000);
}

/** Round a millicent value to integer cents at display time. */
export function millicentsToCents(m: number | null | undefined): number | null {
  if (m == null) return null;
  return Math.round(m / 1000);
}

export interface CostBreakdownMillicents {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_5m_write: number;
  cache_1h_write: number;
  /** Legacy pre-split cache_write tokens billed at the 1h rate. */
  cache_write_legacy: number;
  /** Sum of every component above. */
  total: number;
}

/**
 * Per-component cost in millicents — same accounting as
 * costMillicents but with each component exposed so the dashboard
 * can render an auditable "where the money went" panel. Anthropic
 * charges cache write tokens at 1.25-2× input rate, which often
 * dominates total spend for cmux + long-context workloads in ways
 * the rate-sheet headlines ($5/$25 input/output) don't make obvious.
 */
export function costBreakdownMillicents(u: UsageInput): CostBreakdownMillicents | null {
  if (!u.model) return null;
  const p = lookup(u.model, u.ts ?? new Date());
  if (!p) return null;

  const has5m = u.tokens_cache_5m_write != null && u.tokens_cache_5m_write > 0;
  const has1h = u.tokens_cache_1h_write != null && u.tokens_cache_1h_write > 0;
  const cache5mTokens = has5m ? (u.tokens_cache_5m_write ?? 0) : 0;
  const cache1hTokens = has1h ? (u.tokens_cache_1h_write ?? 0) : 0;
  const cache5mRate = p.cache_5m_write_per_m_usd ?? p.cache_write_per_m_usd ?? 0;
  const cache1hRate = p.cache_1h_write_per_m_usd ?? p.cache_write_per_m_usd ?? 0;

  const legacyCacheTokens = !has5m && !has1h ? (u.tokens_cache_write ?? 0) : 0;
  const legacyRate = p.cache_1h_write_per_m_usd ?? p.cache_write_per_m_usd ?? 0;

  const reasoningRate = p.reasoning_per_m_usd ?? p.output_per_m_usd;

  // millicents per token = rate / 10  (see costMillicents()).
  const input              = Math.round(((u.tokens_input      ?? 0) * p.input_per_m_usd)             / 10);
  const output             = Math.round(((u.tokens_output     ?? 0) * p.output_per_m_usd)            / 10);
  const reasoning          = Math.round(((u.tokens_reasoning  ?? 0) * reasoningRate)                 / 10);
  const cache_read         = Math.round(((u.tokens_cache_read ?? 0) * (p.cache_read_per_m_usd ?? 0)) / 10);
  const cache_5m_write     = Math.round((cache5mTokens             * cache5mRate)                    / 10);
  const cache_1h_write     = Math.round((cache1hTokens             * cache1hRate)                    / 10);
  const cache_write_legacy = Math.round((legacyCacheTokens         * legacyRate)                     / 10);

  return {
    input, output, reasoning,
    cache_read, cache_5m_write, cache_1h_write, cache_write_legacy,
    total: input + output + reasoning + cache_read + cache_5m_write + cache_1h_write + cache_write_legacy,
  };
}

export function emptyBreakdown(): CostBreakdownMillicents {
  return {
    input: 0, output: 0, reasoning: 0,
    cache_read: 0, cache_5m_write: 0, cache_1h_write: 0, cache_write_legacy: 0,
    total: 0,
  };
}

export function addBreakdown(a: CostBreakdownMillicents, b: CostBreakdownMillicents): void {
  a.input              += b.input;
  a.output             += b.output;
  a.reasoning          += b.reasoning;
  a.cache_read         += b.cache_read;
  a.cache_5m_write     += b.cache_5m_write;
  a.cache_1h_write     += b.cache_1h_write;
  a.cache_write_legacy += b.cache_write_legacy;
  a.total              += b.total;
}

/** Format an integer cent count as "$1.23" (or "—" when null). */
export function fmtUsd(cents: number | null | undefined): string {
  if (cents == null) return "—";
  if (cents === 0) return "$0.00";
  if (Math.abs(cents) < 10) return `$${(cents / 100).toFixed(4)}`;
  return `$${(cents / 100).toFixed(2)}`;
}
