/**
 * dashboard-filter-params.ts — validation helpers for the multi-dimension
 * dashboard filters (repo, model, date-range).
 *
 * Extracted from page.tsx so they can be imported by both the page and
 * the test suite without running into Next.js's restriction on exporting
 * non-Page symbols from a page file.
 */

/** Validates org/repo format. Returns null if invalid. */
export function resolveRepoFilter(raw: string | undefined): string | null {
  if (!raw) return null;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) ? raw : null;
}

/** Validates model id (alphanumeric, hyphens, dots, underscores, colons,
 *  slashes — covers Anthropic, OpenAI, Gemini, etc.). Returns null if invalid. */
export function resolveModelFilter(raw: string | undefined): string | null {
  if (!raw) return null;
  // Allow common model id chars: letters, digits, hyphens, dots, underscores,
  // colons, slashes (for provider-prefixed ids like "us.anthropic.claude-*").
  return /^[A-Za-z0-9_./:@-]{1,120}$/.test(raw) ? raw : null;
}

/** Validates an ISO-8601 date string (YYYY-MM-DD or full ISO datetime).
 *  Returns the string unchanged if valid, null otherwise. */
export function resolveISODate(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  // Reject obviously far-future or far-past values.
  const yr = d.getUTCFullYear();
  if (yr < 2020 || yr > 2099) return null;
  return raw;
}

/** Returns [since, until] validated pair. Ensures since < until.
 *  Either may be null (means "no bound on that side"). */
export function resolveDateRange(
  rawSince: string | undefined,
  rawUntil: string | undefined,
): [string | null, string | null] {
  const since = resolveISODate(rawSince);
  const until = resolveISODate(rawUntil);
  if (since && until && new Date(since) >= new Date(until)) {
    // Invalid range — discard both rather than silently returning empty set.
    return [null, null];
  }
  return [since, until];
}
