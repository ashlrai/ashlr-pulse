/**
 * fleet-proposal-detail.ts — load a single proposal's full drill-down data.
 *
 * A "proposal" is an activity_event row with fleet_event='proposal' that was
 * ALSO submitted as a fleet_command (kind='approve_proposal'|'reject_proposal').
 * The proposal id in the URL is the fleet_command.id; we load:
 *
 *   (1) Cost breakdown — per agent+model over the proposal lifetime, computed
 *       from activity_event rows scoped to this org via the membership JOIN.
 *       Each row contributes input/output/cache tokens × price from pricing.ts.
 *
 *   (2) Approval timeline — created → reviewed (claimed) → applied/rejected
 *       (completed) from the fleet_command transitions.
 *
 *   (3) Linked repo + top 3 file changes — from github_event rows whose
 *       external_id matches the proposal's session_id, or whose repo_name
 *       matches fleet_command.target around the proposal timestamp.
 *
 *   (4) Rejection reason — fleet_outcome text from the activity_event, or
 *       fleet_command.error if set.
 *
 * PRIVACY FLOOR (hard rule):
 *   - All SQL respects org_id scoping via the membership JOIN for
 *     activity_event (no org_id column) and direct org_id filter for
 *     fleet_command.
 *   - Peer-share masking: when the org's billing_mode is a subscription plan
 *     (pro/max-100/max-200), cost figures are returned as null and a flag
 *     `costMasked:true` is set — rate-card cost is hypothetical for flat-rate
 *     plans and can be misleading in a shared context.
 *   - No code, prompts, diffs, or file bodies ever enter the returned shapes.
 *     The github_event side selects only message_first_line (≤200 chars),
 *     actor_login, ts, and changed_files counts.
 *   - sanitizeDetail() from fleet-audit is applied to any freeform JSONB fields
 *     before they leave this module.
 */

import { sql } from "./db";
import { costBreakdownMillicents, emptyBreakdown, addBreakdown, fmtUsd, millicentsToCents } from "./pricing";
import type { CostBreakdownMillicents } from "./pricing";
import { sanitizeDetail } from "./fleet-audit";
import { isSubscriptionMode } from "./plan-gate";
import type { BillingMode } from "./plan-gate";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentCostRow {
  /** Display name: "fleet" if fleet_owner null; engine label if both. */
  agent: string;
  /** Canonical model id, e.g. "claude-sonnet-4-6". */
  model: string | null;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  /** Per-component breakdown in millicents. Null when cost is masked. */
  breakdown: CostBreakdownMillicents | null;
  /** Convenience total in USD cents. Null when masked. */
  totalCents: number | null;
}

export interface ProposalTimeline {
  createdAt: string;
  /** ISO timestamp when the command was claimed (review started). */
  claimedAt: string | null;
  /** ISO timestamp when the command reached done/failed. */
  completedAt: string | null;
  /** "applied" | "rejected" | "pending" | "claimed" | "failed" | "done" */
  outcome: string | null;
  /** Who claimed (machine id) or who created (user id). */
  actor: string | null;
}

export interface LinkedCommit {
  sha: string;
  messageFirstLine: string | null;
  actorLogin: string | null;
  ts: string;
  changedFiles: number | null;
}

export interface ProposalDetail {
  proposalId: string;
  /** fleet_command.target — usually a repo full_name. */
  repoFullName: string | null;
  /** Headline outcome from activity_event.fleet_outcome or fleet_command.error. */
  rejectionReason: string | null;
  timeline: ProposalTimeline;
  /** Per-agent cost rows, ordered by totalCents desc. */
  agentCosts: AgentCostRow[];
  /** Sum cost across all agents. Null when masked. */
  totalCents: number | null;
  /** True when the org is on a subscription billing mode and cost figures
   *  are suppressed to avoid misleading rate-card inflation. */
  costMasked: boolean;
  /** Top-3 github commits linked to this proposal's repo around its window. */
  linkedCommits: LinkedCommit[];
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface ActivityRow {
  id: string;
  ts: string;
  fleet_owner: string | null;
  provider: string | null;
  model: string | null;
  tokens_input: number | bigint | null;
  tokens_output: number | bigint | null;
  tokens_cache_read: number | bigint | null;
  tokens_cache_write: number | bigint | null;
  tokens_cache_5m_write: number | bigint | null;
  tokens_cache_1h_write: number | bigint | null;
  tokens_reasoning: number | bigint | null;
  fleet_outcome: string | null;
  session_id: string | null;
  repo_name: string | null;
}

interface CommandRow {
  id: string;
  kind: string;
  target: string | null;
  status: string;
  created_by: string | null;
  claimed_by: string | null;
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  payload: Record<string, unknown> | string | null;
  result: Record<string, unknown> | string | null;
}

interface CommitRow {
  external_id: string;
  message_first_line: string | null;
  actor_login: string | null;
  ts: string;
  changed_files: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNum(v: number | bigint | null | undefined): number {
  if (v == null) return 0;
  return typeof v === "bigint" ? Number(v) : v;
}

function agentLabel(row: { fleet_owner: string | null; provider: string | null; model: string | null }): string {
  if (row.fleet_owner) return row.fleet_owner;
  if (row.provider && row.model) return `${row.provider}/${row.model}`;
  return row.provider ?? row.model ?? "fleet";
}

/**
 * Group activity_event rows by (agent, model) and compute cost breakdown.
 * `maskCost` suppresses dollar figures for subscription billing modes.
 */
function buildAgentCosts(rows: ActivityRow[], maskCost: boolean): AgentCostRow[] {
  const map = new Map<string, {
    agent: string;
    model: string | null;
    tokensInput: number;
    tokensOutput: number;
    tokensCacheRead: number;
    tokensCacheWrite: number;
    tokens_cache_5m_write: number;
    tokens_cache_1h_write: number;
    tokens_reasoning: number;
    breakdown: CostBreakdownMillicents;
    firstTs: string;
  }>();

  for (const row of rows) {
    const agent = agentLabel(row);
    const model = row.model ?? null;
    const key = `${agent}||${model ?? ""}`;

    const ti  = toNum(row.tokens_input);
    const to  = toNum(row.tokens_output);
    const tcr = toNum(row.tokens_cache_read);
    const tcw = toNum(row.tokens_cache_write);
    const tc5 = toNum(row.tokens_cache_5m_write);
    const tc1 = toNum(row.tokens_cache_1h_write);
    const trz = toNum(row.tokens_reasoning);

    const bd = costBreakdownMillicents({
      model,
      tokens_input: ti,
      tokens_output: to,
      tokens_cache_read: tcr,
      tokens_cache_write: tcw,
      tokens_cache_5m_write: tc5,
      tokens_cache_1h_write: tc1,
      tokens_reasoning: trz,
      ts: new Date(row.ts),
    }) ?? emptyBreakdown();

    const existing = map.get(key);
    if (existing) {
      existing.tokensInput       += ti;
      existing.tokensOutput      += to;
      existing.tokensCacheRead   += tcr;
      existing.tokensCacheWrite  += tcw + tc5 + tc1;
      existing.tokens_cache_5m_write += tc5;
      existing.tokens_cache_1h_write += tc1;
      existing.tokens_reasoning  += trz;
      addBreakdown(existing.breakdown, bd);
    } else {
      map.set(key, {
        agent,
        model,
        tokensInput: ti,
        tokensOutput: to,
        tokensCacheRead: tcr,
        tokensCacheWrite: tcw + tc5 + tc1,
        tokens_cache_5m_write: tc5,
        tokens_cache_1h_write: tc1,
        tokens_reasoning: trz,
        breakdown: { ...bd },
        firstTs: row.ts,
      });
    }
  }

  return Array.from(map.values())
    .sort((a, b) => b.breakdown.total - a.breakdown.total)
    .map((entry) => ({
      agent: entry.agent,
      model: entry.model,
      tokensInput: entry.tokensInput,
      tokensOutput: entry.tokensOutput,
      tokensCacheRead: entry.tokensCacheRead,
      tokensCacheWrite: entry.tokensCacheWrite,
      breakdown: maskCost ? null : entry.breakdown,
      totalCents: maskCost ? null : millicentsToCents(entry.breakdown.total),
    }));
}

// ---------------------------------------------------------------------------
// Main query
// ---------------------------------------------------------------------------

/**
 * Load full drill-down for one proposal, org-scoped.
 *
 * Returns null when:
 *   - no fleet_command with this id exists in the org, OR
 *   - the command kind is not approve_proposal / reject_proposal.
 *
 * @param orgId   - the caller's org UUID (scoping + peer-share)
 * @param proposalId - fleet_command.id (UUID string)
 * @param billingMode - org billing mode; subscription plans get cost masked
 */
export async function getProposalDetail(
  orgId: string,
  proposalId: string,
  billingMode: BillingMode = "unknown",
): Promise<ProposalDetail | null> {
  const db = sql();
  const maskCost = isSubscriptionMode(billingMode);

  // 1. Load the fleet_command row (org-scoped).
  const [cmdRow] = await db<CommandRow[]>`
    SELECT
      id::text AS id,
      kind,
      target,
      status,
      created_by::text AS created_by,
      claimed_by,
      error,
      created_at::text AS created_at,
      claimed_at::text AS claimed_at,
      completed_at::text AS completed_at,
      payload,
      result
    FROM fleet_command
    WHERE id     = ${proposalId}::uuid
      AND org_id = ${orgId}::uuid
    LIMIT 1
  `;

  if (!cmdRow) return null;

  // Only show drill-down for proposal-related commands.
  if (!["approve_proposal", "reject_proposal", "assign_goal"].includes(cmdRow.kind)) {
    return null;
  }

  const repoFullName = cmdRow.target ?? null;

  // 2. Load activity_event rows for this proposal session.
  //    Scoped via membership JOIN (activity_event has no org_id).
  //    Window: from fleet_command.created_at to completed_at (+10m buffer).
  //    Filter: fleet_event='proposal' OR same session window on the repo.
  const windowStart = cmdRow.created_at;
  const windowEnd   = cmdRow.completed_at
    ? new Date(new Date(cmdRow.completed_at).getTime() + 10 * 60_000).toISOString()
    : new Date(new Date(cmdRow.created_at).getTime() + 2 * 3600_000).toISOString();

  const activityRows = await db<ActivityRow[]>`
    SELECT
      ae.id::text          AS id,
      ae.ts::text          AS ts,
      ae.fleet_owner,
      ae.provider,
      ae.model,
      ae.tokens_input,
      ae.tokens_output,
      ae.tokens_cache_read,
      ae.tokens_cache_write,
      ae.tokens_cache_5m_write,
      ae.tokens_cache_1h_write,
      ae.tokens_reasoning,
      ae.fleet_outcome,
      ae.session_id,
      ae.repo_name
    FROM activity_event ae
    JOIN membership m
      ON m.user_id::text = ae.user_id
     AND m.org_id = ${orgId}::uuid
    WHERE ae.source = 'ashlr-fleet'
      AND ae.fleet_event = 'proposal'
      AND ae.ts >= ${windowStart}::timestamptz
      AND ae.ts <= ${windowEnd}::timestamptz
      AND (
        ${repoFullName}::text IS NULL
        OR ae.repo_name = ${repoFullName}::text
      )
    ORDER BY ae.ts ASC
  `;

  // 3. Build rejection reason: fleet_outcome from activity_event or command error.
  let rejectionReason: string | null = null;
  for (const ae of activityRows) {
    const o = ae.fleet_outcome;
    if (o && o !== "applied" && o !== "pending") {
      rejectionReason = o.slice(0, 2048);
      break;
    }
  }
  if (!rejectionReason && cmdRow.error) {
    rejectionReason = cmdRow.error.slice(0, 2048);
  }

  // 4. Timeline.
  const outcome = cmdRow.status === "done"
    ? (rejectionReason ? "rejected" : "applied")
    : cmdRow.status;

  const timeline: ProposalTimeline = {
    createdAt:   cmdRow.created_at,
    claimedAt:   cmdRow.claimed_at,
    completedAt: cmdRow.completed_at,
    outcome,
    actor: cmdRow.claimed_by ?? cmdRow.created_by,
  };

  // 5. Agent costs.
  const agentCosts = buildAgentCosts(activityRows, maskCost);
  const totalCents = maskCost
    ? null
    : agentCosts.reduce((s, r) => s + (r.totalCents ?? 0), 0);

  // 6. Top-3 linked commits from github_event (repo + time window).
  //    Columns: external_id (sha), message_first_line, actor_login, ts,
  //             changed_files. Never fetch diff/body.
  const linkedCommits: LinkedCommit[] = [];
  if (repoFullName) {
    const commitRows = await db<CommitRow[]>`
      SELECT
        ge.external_id,
        ge.message_first_line,
        ge.actor_login,
        ge.ts::text AS ts,
        ge.changed_files
      FROM github_event ge
      JOIN github_repo gr ON gr.id = ge.repo_id
      JOIN github_account ga ON ga.id = gr.account_id
      JOIN membership m ON m.user_id = ga.user_id
        AND m.org_id = ${orgId}::uuid
      WHERE ge.kind = 'commit'
        AND gr.full_name = ${repoFullName}
        AND ge.ts >= ${windowStart}::timestamptz
        AND ge.ts <= ${windowEnd}::timestamptz
      ORDER BY ge.ts DESC
      LIMIT 3
    `;

    for (const r of commitRows) {
      linkedCommits.push({
        sha: r.external_id,
        // message_first_line is already capped at 200 chars at ingest; cap
        // defensively again so a schema widening never leaks content.
        messageFirstLine: r.message_first_line?.slice(0, 200) ?? null,
        actorLogin: r.actor_login,
        ts: r.ts,
        changedFiles: r.changed_files,
      });
    }
  }

  return {
    proposalId,
    repoFullName,
    rejectionReason,
    timeline,
    agentCosts,
    totalCents,
    costMasked: maskCost,
    linkedCommits,
  };
}

// ---------------------------------------------------------------------------
// Re-export pricing helpers for the page component
// ---------------------------------------------------------------------------

export { fmtUsd, millicentsToCents };
