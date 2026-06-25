/**
 * peer-share-guard.ts — server-side enforcement of the peer_share field
 * whitelist.
 *
 * The hard privacy floor (COMPETITIVE.md:49-50, ARCHITECTURE.md:91): the
 * shared layer never carries prompt content, completion content, or raw
 * OTel spans, regardless of what the API caller asks for. This guard
 * runs on every peer_share insert path and rejects forbidden field names
 * before they reach the database.
 *
 * It also restricts the whitelist to the set of activity_event columns
 * we have agreed are safe to expose. Any new column added to the schema
 * must be explicitly added to SHAREABLE_FIELDS — the default for unknown
 * columns is "not shareable".
 */

/** Columns that may NEVER appear in a peer_share.fields[] entry. */
export const FORBIDDEN_FIELDS = new Set<string>([
  "prompts",
  "completions",
  "raw_otel_span",
]);

/**
 * activity_event columns the API may include in a share grant. Curated:
 * anything not on this list is rejected even if it's in the schema, so
 * that a future schema change doesn't silently widen what's shareable.
 */
export const SHAREABLE_FIELDS = new Set<string>([
  "ts",
  "source",
  "provider",
  "model",
  "duration_ms",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",          // 0015: extended-thinking tokens
  "tokens_cache_read",
  "tokens_cache_write",
  "tokens_cache_5m_write",
  "tokens_cache_1h_write",
  "tool_calls_count",
  "tool_calls_types",
  "accepted_count",
  "rejected_count",
  "project_hash",
  "repo_name",
  "git_branch",
  "language",
  "cost_usd_cents",
  "cost_millicents",            // 0015: precision cost cache
  // 0015: ashlr-plugin attribution. Numbers + version strings only —
  // no prompts, no code, no completions. Safe to share by design.
  "tokens_saved",
  "tokens_saved_breakdown",
  "plugin_features",
  "plugin_version",
  "plugin_genome_hit_rate",
  // 0025: fleet columns — structured metadata only, no code/prompts.
  "fleet_event",
  "fleet_outcome",
  // 0026: fleet owner identifier — display name / email, not code content.
  "fleet_owner",
]);

export type ValidateFieldsResult =
  | { ok: true; fields: string[] }
  | { ok: false; error: string; status: 400 | 422 };

/**
 * Validate a `fields` array supplied by an API caller for a peer_share row.
 * Returns the cleaned, deduplicated whitelist on success. On failure,
 * returns the precise reason — call sites turn this into a 4xx response.
 */
export function validateFields(input: unknown): ValidateFieldsResult {
  if (!Array.isArray(input)) {
    return { ok: false, status: 400, error: "fields must be an array of strings" };
  }
  if (input.length === 0) {
    return { ok: false, status: 400, error: "fields must not be empty" };
  }

  const seen = new Set<string>();
  for (const f of input) {
    if (typeof f !== "string") {
      return { ok: false, status: 400, error: "fields must be strings" };
    }
    if (FORBIDDEN_FIELDS.has(f)) {
      return {
        ok: false,
        status: 422,
        error: `field "${f}" is not shareable: prompts, completions, and raw spans are never exposed in the shared layer`,
      };
    }
    if (!SHAREABLE_FIELDS.has(f)) {
      return {
        ok: false,
        status: 422,
        error: `field "${f}" is not on the shareable whitelist`,
      };
    }
    seen.add(f);
  }

  return { ok: true, fields: [...seen] };
}
