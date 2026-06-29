/**
 * fleet-audit.ts — privacy-floor sanitiser for fleet command/event detail bags.
 *
 * The fleet control plane stores small JSONB "detail" bags on commands
 * (payload), command outcomes (result), and audit/proposal rows. Those bags
 * are *metadata only* — a daemon or a buggy caller must never be able to smuggle
 * code, diffs, prompts, completions, or file contents into a row that later
 * surfaces in an export (fleet-audit-export.ts) or a proposal drill-down
 * (fleet-proposal-detail.ts).
 *
 * `sanitizeDetail()` is the last line of defence on the *read* path: even if a
 * forbidden key slipped past assertMetadataOnly() on the write path (older
 * rows, a future schema drift), we strip it before the value reaches a client.
 *
 * Discipline — this module REUSES the single canonical forbidden-key set and
 * string-length cap defined in peer-share-guard.ts. There is exactly one
 * privacy floor in this codebase; do not fork a second copy here.
 */

import { FORBIDDEN_META_KEYS } from "./peer-share-guard";

/**
 * Maximum character-length of any sanitised string value. Mirrors
 * MAX_META_STRING_LEN in peer-share-guard — a string longer than this is
 * almost certainly a file body / log dump, not a metadata label. We truncate
 * (rather than drop) so a long-but-legitimate label still carries signal.
 */
export const MAX_DETAIL_STRING_LEN = 2048;

/** Re-export so consumers/tests have one import site for the floor. */
export { FORBIDDEN_META_KEYS } from "./peer-share-guard";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Recursively sanitise one scalar/array/object value:
 *   • strings longer than MAX_DETAIL_STRING_LEN are truncated.
 *   • nested objects are recursively sanitised (forbidden keys stripped).
 *   • arrays are sanitised element-wise.
 *   • everything else (number / boolean / null) passes through unchanged.
 */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_DETAIL_STRING_LEN
      ? value.slice(0, MAX_DETAIL_STRING_LEN)
      : value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (isPlainObject(value)) {
    return sanitizeObject(value);
  }
  return value;
}

function sanitizeObject(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Strip any forbidden content key — case-insensitive, since callers may
    // capitalise (e.g. "Diff", "FileContent"). The canonical set is lowercase.
    if (FORBIDDEN_META_KEYS.has(key.toLowerCase())) continue;
    out[key] = sanitizeValue(value);
  }
  return out;
}

/**
 * Sanitise a detail bag for safe egress.
 *
 * Non-object input (null / undefined / string / number / array) returns an
 * empty object — a detail bag is *always* a JSON object by contract, so
 * anything else is malformed and yields no metadata rather than leaking a
 * raw scalar/array that might itself be content.
 *
 * @example
 *   sanitizeDetail({ engine: "claude", diff: "@@..." }) // → { engine: "claude" }
 *   sanitizeDetail(null)                                 // → {}
 *   sanitizeDetail("some text")                          // → {}
 */
export function sanitizeDetail(input: unknown): Record<string, unknown> {
  if (!isPlainObject(input)) return {};
  return sanitizeObject(input);
}
