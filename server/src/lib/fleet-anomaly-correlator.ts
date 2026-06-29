/**
 * fleet-anomaly-correlator.ts — root-cause CORRELATOR for fleet quality gates.
 *
 * When a fleet quality gate transitions from pass→warn or warn→fail the raw gate
 * result tells you THAT the fleet is rejecting too much work, but not WHY.  This
 * module answers the "why": it scans the last 50 rejected proposals and groups
 * them by three dimensions of metadata that commonly predict rejection:
 *
 *   1. FILE PATTERNS   — which file paths (as regex groups) appear most often in
 *                        the `touched_paths` / `repo_name` metadata of rejected
 *                        proposals.  E.g. "proposals touching auth.ts" may have a
 *                        60 % rejection rate while the fleet average is 40 %.
 *   2. KEYWORD GROUPS  — recurring tokens in the short commit-message or goal
 *                        text stored in the proposal metadata (`title` field).
 *   3. TOOL SEQUENCES  — if the proposal metadata carries a `tool_calls` list
 *                        (e.g. "edit,bash,edit"), repeated sequences that correlate
 *                        with rejection are surfaced.
 *
 * The correlator surfaces the top 3 patterns with a rejection rate >40 %.  It is
 * a pure-read module: it writes nothing.  The DB-touching wrapper
 * `diagnoseGateAnomaly` is the entry point called by routes; the pure core
 * `correlateRejections` can be exercised in tests with synthetic rows.
 *
 * A second entry point `recordDiagnosis` writes one `fleet_anomaly_root_cause`
 * row from a completed diagnosis.  `suppressPattern` flips a row to 'suppressed'
 * and appends the chosen glob to its `suppress_patterns` array.
 * `listDiagnoses` reads open diagnoses for the health-route response.
 *
 * PRIVACY FLOOR: reads and emits METADATA ONLY — file paths, commit title
 * keywords, tool-call type names, counts.  No code, prompts, diffs, or
 * user-authored content ever crosses this boundary.
 */

import { sql } from "@/lib/db";
import type { GateStatus } from "@/lib/fleet-quality-gates";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single correlated pattern and its statistics. */
export interface RootCausePattern {
  /** Human-readable label, e.g. "file:auth\\.ts", "keyword:auth", "tool:edit+bash". */
  label: string;
  /** Dimension that surfaced this pattern. */
  dimension: "file" | "keyword" | "tool_sequence";
  /** Rejection rate for proposals matching this pattern (0.0–1.0). */
  rejectionRate: number;
  /** Number of rejected proposals that matched. */
  rejectedCount: number;
  /** Total proposals (rejected + applied) matching this pattern. */
  totalCount: number;
  /** Proposal ids (activity_event) that matched and were rejected. */
  affectedProposalIds: string[];
}

/** The full diagnosis output for one gate-firing event. */
export interface RootCauseDiagnosis {
  /** Stable DB id once persisted (null before `recordDiagnosis`). */
  id: string | null;
  /** The quality gate that fired. */
  gateId: string;
  /** When the diagnosis was computed. */
  firedAt: string;
  /** Top patterns (max 3) with rejection rate > MIN_REJECTION_RATE. */
  patterns: RootCausePattern[];
  /** All affected proposal ids across matched patterns (de-duped). */
  affectedProposalIds: string[];
  /** 'open' | 'suppressed' | 'resolved' — set after DB write. */
  status: "open" | "suppressed" | "resolved";
  /** Globs the operator chose to suppress (populated after suppressPattern). */
  suppressPatterns: string[];
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface RejectedProposalRow {
  id: string;
  repo_name: string | null;
  /** Short title or commit message text from metadata — may be null. */
  title: string | null;
  /** JSON array of touched file paths from metadata — may be null. */
  touched_paths: string | null;
  /** Comma-joined tool call type names — may be null. */
  tool_calls: string | null;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Only surface patterns with a rejection rate above this floor. */
const MIN_REJECTION_RATE = 0.4;

/** Maximum number of top patterns to surface per diagnosis. */
const MAX_PATTERNS = 3;

/** How many rejected proposals to scan per gate firing. */
const SCAN_LIMIT = 50;

/** Minimum proposals matching a pattern before it's considered significant. */
const MIN_PATTERN_SAMPLE = 2;

// ---------------------------------------------------------------------------
// Pure correlation core — no DB, exercised by tests.
// ---------------------------------------------------------------------------

/**
 * Given a list of rejected proposal rows (fetched by the DB wrapper), derive
 * the top root-cause patterns.
 *
 * The function is intentionally side-effect-free so the test suite can inject
 * synthetic rows.  It returns up to MAX_PATTERNS patterns with rejection rate >
 * MIN_REJECTION_RATE, sorted by rejection rate descending.
 *
 * The `appliedRows` companion list is the matching APPLIED proposals used to
 * compute rates — we need both sides of the resolved set to get a true rate.
 */
export function correlateRejections(
  rejectedRows: RejectedProposalRow[],
  appliedRows: RejectedProposalRow[],
): RootCausePattern[] {
  // Build a unified lookup: for each row we track its outcome.
  type OutcomeRow = RejectedProposalRow & { outcome: "rejected" | "applied" };
  const allRows: OutcomeRow[] = [
    ...rejectedRows.map((r) => ({ ...r, outcome: "rejected" as const })),
    ...appliedRows.map((r) => ({ ...r, outcome: "applied" as const })),
  ];

  // ── 1. File patterns ────────────────────────────────────────────────────────
  // Map each row to the set of simplified path tokens it touches.
  const fileGroups = new Map<string, OutcomeRow[]>();

  for (const row of allRows) {
    const paths = parsePaths(row.touched_paths ?? row.repo_name);
    for (const token of paths) {
      if (!fileGroups.has(token)) fileGroups.set(token, []);
      fileGroups.get(token)!.push(row);
    }
  }

  // ── 2. Keyword groups ───────────────────────────────────────────────────────
  const keywordGroups = new Map<string, OutcomeRow[]>();

  for (const row of allRows) {
    const keywords = extractKeywords(row.title);
    for (const kw of keywords) {
      if (!keywordGroups.has(kw)) keywordGroups.set(kw, []);
      keywordGroups.get(kw)!.push(row);
    }
  }

  // ── 3. Tool-call sequences ──────────────────────────────────────────────────
  const toolGroups = new Map<string, OutcomeRow[]>();

  for (const row of allRows) {
    const seq = normalizeToolSequence(row.tool_calls);
    if (seq) {
      if (!toolGroups.has(seq)) toolGroups.set(seq, []);
      toolGroups.get(seq)!.push(row);
    }
  }

  // ── Rank all candidate patterns across dimensions ──────────────────────────
  const candidates: RootCausePattern[] = [];

  function evalGroup(
    label: string,
    dimension: RootCausePattern["dimension"],
    rows: OutcomeRow[],
  ): void {
    const rejected = rows.filter((r) => r.outcome === "rejected");
    const total = rows.length;
    if (total < MIN_PATTERN_SAMPLE) return;
    const rate = rejected.length / total;
    if (rate <= MIN_REJECTION_RATE) return;
    // Deduplicate proposal ids.
    const affectedIds = [...new Set(rejected.map((r) => r.id))];
    candidates.push({
      label,
      dimension,
      rejectionRate: Math.round(rate * 100) / 100,
      rejectedCount: rejected.length,
      totalCount: total,
      affectedProposalIds: affectedIds,
    });
  }

  for (const [token, rows] of fileGroups) {
    evalGroup(`file:${token}`, "file", rows);
  }
  for (const [kw, rows] of keywordGroups) {
    evalGroup(`keyword:${kw}`, "keyword", rows);
  }
  for (const [seq, rows] of toolGroups) {
    evalGroup(`tool:${seq}`, "tool_sequence", rows);
  }

  // Sort: highest rejection rate first; break ties by rejected count.
  candidates.sort((a, b) => {
    if (b.rejectionRate !== a.rejectionRate) return b.rejectionRate - a.rejectionRate;
    return b.rejectedCount - a.rejectedCount;
  });

  return candidates.slice(0, MAX_PATTERNS);
}

// ---------------------------------------------------------------------------
// Path tokeniser — extracts significant path segments.
// ---------------------------------------------------------------------------

/**
 * Turn a JSON-encoded path array or a bare repo_name string into a set of
 * "significant tokens" for grouping.  We want tokens like "auth.ts", "auth/",
 * or "org/repo" — not noise like ".ts" or "src".
 */
function parsePaths(raw: string | null | undefined): string[] {
  if (!raw) return [];

  // Try JSON-array first (touched_paths from metadata).
  let paths: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      paths = parsed.map(String);
    } else {
      paths = [String(parsed)];
    }
  } catch {
    // Not JSON — treat as a plain string (e.g. repo_name "owner/repo").
    paths = [raw];
  }

  const tokens = new Set<string>();
  for (const p of paths) {
    // Basename of the file (e.g. "auth.ts" from "src/lib/auth.ts").
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    for (const part of parts) {
      // Skip very generic directory names.
      if (["src", "lib", "app", "tests", "test", "dist", "build"].includes(part)) continue;
      // Skip pure extension tokens.
      if (/^\.[a-z]+$/.test(part)) continue;
      if (part.length >= 3) tokens.add(part);
    }
    // Also add the last two-segment join if meaningful (e.g. "auth/handler.ts").
    if (parts.length >= 2) {
      const tail2 = parts.slice(-2).join("/");
      if (tail2.length >= 5) tokens.add(tail2);
    }
  }
  return [...tokens].slice(0, 6); // cap to avoid combinatorial explosion
}

// ---------------------------------------------------------------------------
// Keyword extractor — pulls significant words from commit/goal title.
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "to", "for", "with",
  "fix", "add", "update", "refactor", "chore", "feat", "docs",
  "bump", "merge", "revert", "initial", "minor", "major",
]);

function extractKeywords(title: string | null | undefined): string[] {
  if (!title) return [];
  return title
    .toLowerCase()
    .split(/[\s\-_/:,;.!?()[\]{}'"]+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
    .slice(0, 5); // cap per-proposal contribution
}

// ---------------------------------------------------------------------------
// Tool-sequence normaliser.
// ---------------------------------------------------------------------------

/**
 * Normalise a comma-joined tool-call sequence into a canonical short label
 * (e.g. "edit+bash+edit" → "edit>bash>edit", capped at 4 ops).
 */
function normalizeToolSequence(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ops = raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 4);
  if (ops.length < 2) return null;
  return ops.join(">");
}

// ---------------------------------------------------------------------------
// DB-touching entry points.
// ---------------------------------------------------------------------------

/**
 * Fetch the last SCAN_LIMIT rejected proposals for an org and compute the
 * root-cause diagnosis.  Also fetches the matching applied proposals so we can
 * compute rates against the full resolved set.
 *
 * Returns a diagnosis with `id: null` (not yet persisted) — call
 * `recordDiagnosis` to write it to `fleet_anomaly_root_cause`.
 */
export async function diagnoseGateAnomaly(
  orgId: string,
  gateId: string,
): Promise<RootCauseDiagnosis> {
  const db = sql();

  const [rejectedRows, appliedRows] = await Promise.all([
    db<RejectedProposalRow[]>`
      SELECT
        ae.id::text                                       AS id,
        ae.repo_name                                      AS repo_name,
        ae.title                                          AS title,
        ae.metadata->>'touched_paths'                     AS touched_paths,
        ae.metadata->>'tool_calls'                        AS tool_calls
      FROM activity_event ae
      JOIN membership m ON m.user_id::text = ae.user_id
        AND m.org_id = ${orgId}::uuid
      WHERE ae.source = 'ashlr-fleet'
        AND ae.fleet_event = 'proposal'
        AND ae.fleet_outcome = 'rejected'
      ORDER BY ae.ts DESC
      LIMIT ${SCAN_LIMIT}
    `,
    db<RejectedProposalRow[]>`
      SELECT
        ae.id::text                                       AS id,
        ae.repo_name                                      AS repo_name,
        ae.title                                          AS title,
        ae.metadata->>'touched_paths'                     AS touched_paths,
        ae.metadata->>'tool_calls'                        AS tool_calls
      FROM activity_event ae
      JOIN membership m ON m.user_id::text = ae.user_id
        AND m.org_id = ${orgId}::uuid
      WHERE ae.source = 'ashlr-fleet'
        AND ae.fleet_event = 'proposal'
        AND ae.fleet_outcome = 'applied'
      ORDER BY ae.ts DESC
      LIMIT ${SCAN_LIMIT}
    `,
  ]);

  const patterns = correlateRejections(rejectedRows, appliedRows);

  // Collect all affected proposal ids (de-duped across patterns).
  const allAffected = [
    ...new Set(patterns.flatMap((p) => p.affectedProposalIds)),
  ];

  return {
    id: null,
    gateId,
    firedAt: new Date().toISOString(),
    patterns,
    affectedProposalIds: allAffected,
    status: "open",
    suppressPatterns: [],
  };
}

/**
 * Persist a completed diagnosis to `fleet_anomaly_root_cause` and return the
 * diagnosis with its new DB id.
 */
export async function recordDiagnosis(
  orgId: string,
  diagnosis: RootCauseDiagnosis,
): Promise<RootCauseDiagnosis> {
  const db = sql();

  const patternLabels = diagnosis.patterns.map((p) => p.label);
  const rates = diagnosis.patterns.map((p) => p.rejectionRate);
  const affectedIds = diagnosis.affectedProposalIds;

  const rows = await db<Array<{ id: string }>>`
    INSERT INTO fleet_anomaly_root_cause
      (gate_id, org_id, fired_at, root_cause_patterns, rejection_rates,
       affected_proposals, status, suppress_patterns)
    VALUES (
      ${diagnosis.gateId},
      ${orgId}::uuid,
      ${diagnosis.firedAt}::timestamptz,
      ${patternLabels}::text[],
      ${rates}::numeric[],
      ${affectedIds}::text[]::uuid[],
      'open',
      '{}'::text[]
    )
    RETURNING id::text
  `;

  return { ...diagnosis, id: rows[0]?.id ?? null };
}

/**
 * Suppress a diagnosis: set status='suppressed', append the chosen glob to
 * `suppress_patterns`.  Returns null if the row isn't found / wrong org.
 */
export async function suppressPattern(
  orgId: string,
  diagnosisId: string,
  glob: string,
): Promise<{ id: string; suppressPatterns: string[] } | null> {
  const db = sql();

  const rows = await db<Array<{ id: string; suppress_patterns: string[] }>>`
    UPDATE fleet_anomaly_root_cause
    SET
      status           = 'suppressed',
      suppress_patterns = suppress_patterns || ${[glob]}::text[]
    WHERE id    = ${diagnosisId}::uuid
      AND org_id = ${orgId}::uuid
    RETURNING id::text, suppress_patterns
  `;

  if (!rows.length) return null;
  return { id: rows[0].id, suppressPatterns: rows[0].suppress_patterns };
}

/**
 * List open diagnoses for an org, newest first.  Used by the health route and
 * the anomalies page.
 */
export async function listDiagnoses(
  orgId: string,
  limit = 20,
): Promise<RootCauseDiagnosis[]> {
  const db = sql();

  const rows = await db<
    Array<{
      id: string;
      gate_id: string;
      fired_at: string;
      root_cause_patterns: string[];
      rejection_rates: string[];
      affected_proposals: string[];
      status: string;
      suppress_patterns: string[];
    }>
  >`
    SELECT
      id::text,
      gate_id,
      fired_at,
      root_cause_patterns,
      rejection_rates,
      affected_proposals::text[]  AS affected_proposals,
      status,
      suppress_patterns
    FROM fleet_anomaly_root_cause
    WHERE org_id = ${orgId}::uuid
      AND status = 'open'
    ORDER BY fired_at DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    id: r.id,
    gateId: r.gate_id,
    firedAt: r.fired_at,
    patterns: r.root_cause_patterns.map((label, i) => ({
      label,
      dimension: labelToDimension(label),
      rejectionRate: Number(r.rejection_rates[i] ?? 0),
      rejectedCount: 0, // not stored — summary only
      totalCount: 0,
      affectedProposalIds: [],
    })),
    affectedProposalIds: r.affected_proposals,
    status: r.status as RootCauseDiagnosis["status"],
    suppressPatterns: r.suppress_patterns,
  }));
}

function labelToDimension(label: string): RootCausePattern["dimension"] {
  if (label.startsWith("file:")) return "file";
  if (label.startsWith("keyword:")) return "keyword";
  return "tool_sequence";
}
