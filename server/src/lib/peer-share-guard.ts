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

// ---------------------------------------------------------------------------
// Metadata privacy floor (used by the audit feed and realtime broadcast path)
// ---------------------------------------------------------------------------

/**
 * Keys that must NEVER appear in any free-form metadata bag surfaced through
 * the audit feed, realtime broadcast, or any peer-share payload. The check is
 * always performed case-insensitively (compare via .toLowerCase()).
 *
 * Matches the privacy floor defined in COMPETITIVE.md:49-50 and
 * ARCHITECTURE.md:91: no code, prompts, completions, diffs, or file bodies
 * may be carried in structured metadata.
 */
export const FORBIDDEN_META_KEYS = new Set<string>([
  // LLM content
  "prompt",
  "prompts",
  "completion",
  "completions",
  "message",
  "messages",
  // Code / patch content
  "code",
  "source_code",
  "diff",
  "patch",
  "body",
  "content",
  "file",
  "files",
  "file_content",
  "file_contents",
  // Process output
  "stdout",
  "stderr",
  // Raw telemetry
  "raw_otel_span",
  "span",
  "trace",
]);

/** Maximum allowed character-length of a metadata string value. */
const MAX_META_STRING_LEN = 2048;

/**
 * Thrown by assertMetadataOnly() when a metadata bag contains a forbidden key
 * or an over-long string value. The event/payload carrying this bag must be
 * dropped rather than forwarded to clients.
 */
export class MetadataFloorError extends Error {
  constructor(
    message: string,
    public readonly context?: string,
  ) {
    super(message);
    this.name = "MetadataFloorError";
  }
}

/**
 * Assert that a metadata bag contains only safe, bounded values — no forbidden
 * content keys and no string values exceeding MAX_META_STRING_LEN characters.
 *
 * This is the THROWING counterpart to sanitizeDetail() (fleet-audit.ts). Use
 * on ingest/broadcast paths where a violation must abort the operation rather
 * than silently drop a field.
 *
 * Returns the input unchanged on success (allows call-site chaining).
 * Is a no-op (does not throw) for null / primitive / non-object inputs.
 *
 * @param meta    - The metadata bag to validate (any unknown value).
 * @param context - Optional label for the call site (improves error messages).
 * @returns The input value unchanged.
 * @throws {MetadataFloorError} if a forbidden key or over-long value is found.
 */
export function assertMetadataOnly(meta: unknown, context?: string): unknown {
  if (meta == null || (typeof meta !== "object" && !Array.isArray(meta))) {
    return meta;
  }

  if (Array.isArray(meta)) {
    for (const item of meta) {
      // Check string items directly for length — they are not objects so the
      // recursive call below would no-op on them.
      if (typeof item === "string" && item.length > MAX_META_STRING_LEN) {
        throw new MetadataFloorError(
          `Array element exceeds max length (${item.length} > ${MAX_META_STRING_LEN})${context ? ` in ${context}` : ""}`,
          context,
        );
      }
      if (item !== null && typeof item === "object") {
        assertMetadataOnly(item, context);
      }
    }
    return meta;
  }

  const bag = meta as Record<string, unknown>;
  for (const [k, v] of Object.entries(bag)) {
    if (FORBIDDEN_META_KEYS.has(k.toLowerCase())) {
      throw new MetadataFloorError(
        `Forbidden metadata key "${k}"${context ? ` in ${context}` : ""}`,
        context,
      );
    }
    if (typeof v === "string" && v.length > MAX_META_STRING_LEN) {
      throw new MetadataFloorError(
        `Metadata key "${k}" exceeds max length (${v.length} > ${MAX_META_STRING_LEN})${context ? ` in ${context}` : ""}`,
        context,
      );
    }
    // Recurse into nested objects and arrays.
    if (v !== null && typeof v === "object") {
      assertMetadataOnly(v, context);
    }
  }

  return meta;
}

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
