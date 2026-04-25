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
 * Unknown models fall through to ZERO so partial coverage doesn't
 * silently invent dollars; the dashboard renders "—" in that case.
 */

export interface Price {
  effective: string;        // YYYY-MM-DD; >= this date this row applies
  input_per_m_usd: number;
  output_per_m_usd: number;
  cache_read_per_m_usd?: number;
  cache_write_per_m_usd?: number;
}

const PRICES: Record<string, Price[]> = {
  // Anthropic (claude.ai/pricing). Cache read/write are Anthropic-only
  // for the prompt-caching feature.
  "claude-opus-4-7": [
    { effective: "2026-01-01", input_per_m_usd: 15, output_per_m_usd: 75, cache_read_per_m_usd: 1.5, cache_write_per_m_usd: 18.75 },
  ],
  "claude-sonnet-4-6": [
    { effective: "2026-01-01", input_per_m_usd: 3, output_per_m_usd: 15, cache_read_per_m_usd: 0.3, cache_write_per_m_usd: 3.75 },
  ],
  "claude-haiku-4-5": [
    { effective: "2025-10-01", input_per_m_usd: 1, output_per_m_usd: 5, cache_read_per_m_usd: 0.1, cache_write_per_m_usd: 1.25 },
  ],

  // OpenAI (openai.com/api/pricing). Cache columns ignored — OpenAI
  // bundles cached input into a single discounted rate.
  "gpt-4o":   [{ effective: "2025-01-01", input_per_m_usd: 2.5, output_per_m_usd: 10 }],
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
  tokens_cache_read?: number | null;
  tokens_cache_write?: number | null;
  /** Default: now. Pass the event ts for accurate retroactive pricing. */
  ts?: Date;
}

export function costUsdCents(u: UsageInput): number | null {
  if (!u.model) return null;
  const p = lookup(u.model, u.ts ?? new Date());
  if (!p) return null;

  const cents =
    ((u.tokens_input ?? 0) * p.input_per_m_usd +
      (u.tokens_output ?? 0) * p.output_per_m_usd +
      (u.tokens_cache_read ?? 0) * (p.cache_read_per_m_usd ?? 0) +
      (u.tokens_cache_write ?? 0) * (p.cache_write_per_m_usd ?? 0)) /
    1_000_000 *
    100;

  return Math.round(cents);
}

/** Format an integer cent count as "$1.23" (or "—" when null). */
export function fmtUsd(cents: number | null | undefined): string {
  if (cents == null) return "—";
  if (cents === 0) return "$0.00";
  if (Math.abs(cents) < 10) return `$${(cents / 100).toFixed(4)}`;
  return `$${(cents / 100).toFixed(2)}`;
}
