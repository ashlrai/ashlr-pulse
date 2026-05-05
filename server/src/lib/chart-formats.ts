/**
 * chart-formats.ts — client-safe number formatters for charts.
 *
 * Why a string-keyed lookup instead of passing formatter functions to
 * chart components? Functions cannot cross the server-component →
 * client-component prop boundary in Next.js / React Server Components.
 * Server pages pick a FormatKey, the client-side chart maps it to the
 * actual formatter at render time.
 *
 * Pure functions only — no DOM, no React. Safe to import from either
 * server or client modules.
 */

export type FormatKey =
  /** 1.2M / 345k / 12 — default for tokens and event counts. */
  | "abbrev"
  /** Integer with thousands separators — 12,345. */
  | "locale"
  /** Floor to whole number — 12. */
  | "int"
  /** Always one decimal — 3.4. */
  | "decimal-1"
  /** Always two decimals — 3.40. */
  | "decimal-2"
  /** Ratio with × suffix — 3.40×. */
  | "ratio"
  /** Whole dollars — $5. */
  | "dollars-int"
  /** Dollars with 2dp — $3.42. */
  | "dollars-2dp"
  /** Fraction-of-1 as percent with 1dp — 0.78 → 78.0%. */
  | "percent";

const FALLBACK: FormatKey = "abbrev";

/**
 * Format a numeric value using the given key. `v` may be undefined or a
 * string from a recharts payload — we coerce defensively rather than
 * making every chart caller pre-cast.
 */
export function formatNumber(
  key: FormatKey | undefined,
  v: number | string | undefined,
): string {
  const n = toNumber(v);
  if (n == null) return "";
  switch (key ?? FALLBACK) {
    case "abbrev":      return abbrev(n);
    case "locale":      return n.toLocaleString();
    case "int":         return n.toFixed(0);
    case "decimal-1":   return n.toFixed(1);
    case "decimal-2":   return n.toFixed(2);
    case "ratio":       return `${n.toFixed(2)}×`;
    case "dollars-int": return "$" + n.toFixed(0);
    case "dollars-2dp": return "$" + n.toFixed(2);
    case "percent":     return `${(n * 100).toFixed(1)}%`;
  }
}

function toNumber(v: number | string | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  // Number("") and Number(" ") both coerce to 0, which would print as "0"
  // for an empty cell. Treat blank strings as missing.
  if (v.trim() === "") return null;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : null;
}

function abbrev(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)         return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

/**
 * Map an Ask Pulse metric (`events` | `tokens` | `cost` | `cache_hit_ratio`)
 * to the right tooltip format key. /ask/page.tsx picks one of these based
 * on the user's query and passes it as a prop.
 */
export function valueFormatForMetric(metric: string): FormatKey {
  if (metric === "cost") return "dollars-2dp";
  if (metric === "cache_hit_ratio") return "percent";
  if (metric === "tokens") return "abbrev";
  return "locale";
}

/**
 * Map a metric to a Y-axis tick format. Cost charts want whole dollars
 * on the axis (`$5`, not `$5.00`); other metrics use `12,345`.
 */
export function yFormatForMetric(metric: string): FormatKey {
  if (metric === "cost") return "dollars-int";
  if (metric === "cache_hit_ratio") return "percent";
  return "locale";
}
