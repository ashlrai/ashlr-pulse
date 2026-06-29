/**
 * graph-types.ts — shared types for the fleet command graph.
 *
 * A "fleet command" is a control-plane instruction enqueued from the Pulse UI
 * (the Map / Radar / proposal-inbox surfaces) and claimed/executed by an
 * ashlr-hub fleet daemon. Pulse never executes anything itself — it only
 * records the *intent* (a metadata-only row) and the eventual *outcome*. The
 * daemon polls for pending commands, claims one atomically, does the work in
 * the target repo, and reports back a terminal status + result bag.
 *
 * PRIVACY FLOOR: a command's `payload` and `result` are metadata bags only —
 * they pass through the peer-share guard (assertMetadataOnly) on the way in
 * and sanitizeDetail() on the way out. They must never carry code, diffs,
 * prompts, or file contents. See fleet-audit.ts for the enforcement helper.
 *
 * This module is intentionally dependency-free (pure types + a frozen string
 * tuple) so it can be imported by both DB code and React Server Components
 * without pulling in `postgres` or any server-only module.
 */

/**
 * The closed set of command kinds Pulse can enqueue. Adding a kind here is the
 * single source of truth — `assertCommandKind()` in fleet-commands-db narrows
 * arbitrary strings against this tuple, and any new control surface (Map,
 * Radar, inbox) reuses these constants rather than re-typing literals.
 *
 * Kept as a `const` tuple (not an enum) so it doubles as a runtime allow-list
 * and a compile-time union via `FleetCommandKind`.
 */
export const FLEET_COMMAND_KINDS = [
  // ── Proposal inbox: human approves/rejects an autonomous proposal ──────────
  "approve_proposal",
  "reject_proposal",
  // ── Repo enrollment: opt a repo into / out of the autonomous fleet ─────────
  "enroll_repo",
  "pause_repo",
  // ── Goal assignment: hand the fleet a goal to drive in a repo ──────────────
  "assign_goal",
  // ── Plugin / feature toggles pushed to a repo's agent config ───────────────
  "enable_plugin_feature",
  // ── Remediation actions surfaced by anomaly root-cause attribution ─────────
  "model_swap",
  "cache_strategy",
] as const;

/** Compile-time union of every allowed command kind. */
export type FleetCommandKind = (typeof FLEET_COMMAND_KINDS)[number];

/**
 * Lifecycle status of a fleet command.
 *   - pending  — enqueued, not yet claimed by any daemon.
 *   - claimed  — a daemon has atomically claimed it and is working.
 *   - done     — completed successfully; `result` carries the metadata.
 *   - failed   — terminal failure; `error` carries a short reason.
 */
export type FleetCommandStatus = "pending" | "claimed" | "done" | "failed";

/**
 * One fleet command row, normalised for callers (daemon poll, Map UI,
 * proposal inbox). jsonb columns are always surfaced as plain objects (never
 * raw JSON strings) by the DB layer's mapRow().
 */
export interface FleetCommand {
  id: string;
  orgId: string;
  kind: FleetCommandKind;
  /** Target repo full_name (owner/repo) or null for org-wide commands. */
  target: string | null;
  /** Metadata-only instruction bag — never code/diffs/prompts. */
  payload: Record<string, unknown>;
  status: FleetCommandStatus;
  /** local user.id of the person who enqueued it (nullable for system). */
  createdBy: string | null;
  /** Opaque agent identifier of the daemon that claimed it (nullable). */
  claimedBy: string | null;
  /** Metadata-only outcome bag, present once terminal (nullable otherwise). */
  result: Record<string, unknown> | null;
  /** Short failure reason when status === "failed" (nullable). */
  error: string | null;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}
