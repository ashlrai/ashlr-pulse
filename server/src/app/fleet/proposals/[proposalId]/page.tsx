/**
 * /fleet/proposals/[proposalId] — drill-down for a single fleet proposal.
 *
 * Loads a single proposal from fleet_command + activity_event WHERE
 * fleet_event='proposal' AND fleet_command.id=$proposalId. Renders four tabs:
 *
 *   Cost      — per-agent cost breakdown (input/output/cache tokens × price)
 *   Timeline  — approval lifecycle: created → reviewed → applied/rejected
 *   Changes   — linked repo + top-3 commit file changes (from github_commit)
 *   Feedback  — rejection reason (from fleet_outcome / fleet_command.error)
 *
 * Server component: resolves user + org + billing mode, enforces Pro gate,
 * delegates to lib/fleet-proposal-detail.ts for the SQL. Metadata only —
 * no code, prompts, or diffs cross here.
 */

import type { ReactElement } from "react";
import { redirect, notFound } from "next/navigation";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser } from "@/lib/org-db";
import { limitsFor } from "@/lib/plan-gate";
import { getProposalDetail, fmtUsd } from "@/lib/fleet-proposal-detail";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Banner } from "@/components/ui/Banner";
import { palette, space, radius } from "@/lib/theme";
import { millicentsToCents } from "@/lib/pricing";
import type { ProposalDetail, AgentCostRow, LinkedCommit } from "@/lib/fleet-proposal-detail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ proposalId: string }>;
  searchParams: Promise<{ tab?: string }>;
}

export default async function ProposalDetailPage({
  params,
  searchParams,
}: PageProps): Promise<ReactElement> {
  const { proposalId } = await params;
  const { tab } = await searchParams;
  const activeTab = (["cost", "timeline", "changes", "feedback"].includes(tab ?? ""))
    ? (tab as Tab)
    : "cost";

  const me = await currentUser();
  if (!me) redirect("/login");

  const org = await primaryOrgForUser(me.id);
  const mapEnabled = org ? limitsFor(org).map_enabled : false;

  if (!org || !mapEnabled) {
    return (
      <DashboardShell>
        <Header me={me} active="fleet" />
        <div style={{ marginTop: space.x4 }}>
          <Banner variant="info">
            Fleet proposals are a Pro feature.{" "}
            <a href="/billing" style={{ color: palette.magenta }}>Upgrade at /billing</a>{" "}
            to drill into proposal cost + approval history.
          </Banner>
        </div>
      </DashboardShell>
    );
  }

  const detail = await getProposalDetail(
    org.id,
    proposalId,
    org.billing_mode,
  );

  if (!detail) notFound();

  return (
    <DashboardShell>
      <Header me={me} active="fleet" />
      <ProposalPageHead detail={detail} />
      <div style={{ marginTop: space.x4 }}>
        <TabBar activeTab={activeTab} proposalId={proposalId} />
        <div style={{ marginTop: space.x3 }}>
          {activeTab === "cost"     && <CostTab detail={detail} />}
          {activeTab === "timeline" && <TimelineTab detail={detail} />}
          {activeTab === "changes"  && <ChangesTab detail={detail} />}
          {activeTab === "feedback" && <FeedbackTab detail={detail} />}
        </div>
      </div>
    </DashboardShell>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function ProposalPageHead({ detail }: { detail: ProposalDetail }): ReactElement {
  const outcomeColor = outcomeToColor(detail.timeline.outcome);
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: space.x3, marginTop: space.x3 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: space.x2, flexWrap: "wrap" }}>
          <a href="/fleet" style={{ fontSize: 13, color: palette.textDim, textDecoration: "none" }}>
            Fleet
          </a>
          <span style={{ fontSize: 13, color: palette.textMute }}>/</span>
          <span style={{ fontSize: 13, color: palette.textDim }}>Proposals</span>
          <span style={{ fontSize: 13, color: palette.textMute }}>/</span>
          <span style={{ fontSize: 13, color: palette.text, fontFamily: "monospace" }}>
            {detail.proposalId.slice(0, 8)}…
          </span>
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: "6px 0 0", color: palette.text }}>
          Proposal Drill-down
        </h1>
        <p style={{ fontSize: 13, color: palette.textDim, margin: "4px 0 0" }}>
          {detail.repoFullName
            ? <><span style={{ color: palette.cyan }}>{detail.repoFullName}</span> &mdash; </>
            : ""}
          <span style={{ color: outcomeColor, fontWeight: 500 }}>
            {detail.timeline.outcome ?? "pending"}
          </span>
          {detail.costMasked && (
            <span style={{ marginLeft: space.x2, color: palette.textMute }}>
              · cost masked (subscription mode)
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

type Tab = "cost" | "timeline" | "changes" | "feedback";
const TABS: { id: Tab; label: string }[] = [
  { id: "cost",     label: "Cost" },
  { id: "timeline", label: "Timeline" },
  { id: "changes",  label: "Changes" },
  { id: "feedback", label: "Feedback" },
];

function TabBar({ activeTab, proposalId }: { activeTab: Tab; proposalId: string }): ReactElement {
  return (
    <div style={{ display: "flex", gap: space.x1, borderBottom: `1px solid ${palette.border}`, paddingBottom: "1px" }}>
      {TABS.map(({ id, label }) => {
        const isActive = id === activeTab;
        return (
          <a
            key={id}
            href={`/fleet/proposals/${proposalId}?tab=${id}`}
            style={{
              padding: `${space.x1}px ${space.x3}px`,
              fontSize: 13,
              fontWeight: isActive ? 600 : 400,
              color: isActive ? palette.text : palette.textDim,
              borderBottom: isActive ? `2px solid ${palette.cyan}` : "2px solid transparent",
              textDecoration: "none",
              transition: "color 0.15s",
            }}
          >
            {label}
          </a>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cost tab
// ---------------------------------------------------------------------------

function CostTab({ detail }: { detail: ProposalDetail }): ReactElement {
  if (detail.costMasked) {
    return (
      <Card>
        <Banner variant="info">
          Cost figures are suppressed. Your org uses a Claude Code subscription
          (flat-rate billing). Rate-card costs shown in Pulse are hypothetical
          and excluded from totals to avoid misleading inflation.
        </Banner>
      </Card>
    );
  }

  if (detail.agentCosts.length === 0) {
    return (
      <Card>
        <p style={{ color: palette.textDim, fontSize: 13, margin: 0 }}>
          No token usage events found for this proposal window.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <SectionLabel>Cost by Agent &amp; Model</SectionLabel>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            {(["Agent", "Model", "Input tok", "Output tok", "Cache tok", "Total"] as const).map((h) => (
              <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: palette.textDim, fontWeight: 500, borderBottom: `1px solid ${palette.border}` }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {detail.agentCosts.map((row, i) => (
            <AgentCostRowEl key={i} row={row} />
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={5} style={{ padding: "8px 8px 0", color: palette.textDim, fontSize: 12 }}>
              Total
            </td>
            <td style={{ padding: "8px 8px 0", color: palette.green, fontWeight: 700 }}>
              {fmtUsd(detail.totalCents)}
            </td>
          </tr>
        </tfoot>
      </table>
      <p style={{ fontSize: 11, color: palette.textMute, margin: "12px 0 0" }}>
        Prices: input × rate + output × rate + cache_read × rate + cache_write × rate.
        Millicents precision; rounded to cents for display.
      </p>
    </Card>
  );
}

function AgentCostRowEl({ row }: { row: AgentCostRow }): ReactElement {
  const cacheTotal = (row.breakdown?.cache_read ?? 0)
    + (row.breakdown?.cache_5m_write ?? 0)
    + (row.breakdown?.cache_1h_write ?? 0)
    + (row.breakdown?.cache_write_legacy ?? 0);

  return (
    <tr style={{ borderBottom: `1px solid ${palette.border}` }}>
      <td style={{ padding: "8px 8px", color: palette.text }}>{row.agent}</td>
      <td style={{ padding: "8px 8px", color: palette.cyan, fontFamily: "monospace", fontSize: 11 }}>
        {row.model ?? "—"}
      </td>
      <td style={{ padding: "8px 8px", color: palette.textDim }}>{row.tokensInput.toLocaleString()}</td>
      <td style={{ padding: "8px 8px", color: palette.textDim }}>{row.tokensOutput.toLocaleString()}</td>
      <td style={{ padding: "8px 8px", color: palette.textDim }}>
        {(row.tokensCacheRead + row.tokensCacheWrite).toLocaleString()}
        {cacheTotal > 0 && (
          <span style={{ marginLeft: 4, fontSize: 10, color: palette.textMute }}>
            ({fmtUsd(millicentsToCents(cacheTotal))})
          </span>
        )}
      </td>
      <td style={{ padding: "8px 8px", color: palette.green, fontWeight: 600 }}>
        {fmtUsd(row.totalCents)}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Timeline tab
// ---------------------------------------------------------------------------

function TimelineTab({ detail }: { detail: ProposalDetail }): ReactElement {
  const { timeline } = detail;
  const steps: { label: string; ts: string | null; color: string }[] = [
    { label: "Created",          ts: timeline.createdAt,   color: palette.textDim },
    { label: "Review started",   ts: timeline.claimedAt,   color: palette.amber },
    { label: timeline.outcome === "rejected" ? "Rejected" : "Applied",
      ts: timeline.completedAt, color: outcomeToColor(timeline.outcome) },
  ];

  return (
    <Card>
      <SectionLabel>Approval Timeline</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: space.x3 }}>
        {steps.map((step, i) => (
          <TimelineStep
            key={i}
            label={step.label}
            ts={step.ts}
            color={step.color}
            isLast={i === steps.length - 1}
          />
        ))}
      </div>
      {timeline.actor && (
        <p style={{ fontSize: 12, color: palette.textMute, margin: `${space.x3}px 0 0` }}>
          Actor: <span style={{ color: palette.textDim }}>{timeline.actor}</span>
        </p>
      )}
    </Card>
  );
}

function TimelineStep({
  label,
  ts,
  color,
  isLast,
}: {
  label: string;
  ts: string | null;
  color: string;
  isLast: boolean;
}): ReactElement {
  const hasTs = ts != null;
  return (
    <div style={{ display: "flex", gap: space.x3, alignItems: "flex-start" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 20 }}>
        <div style={{
          width: 12, height: 12, borderRadius: "50%",
          background: hasTs ? color : palette.bgRaised,
          border: `2px solid ${hasTs ? color : palette.border}`,
          flexShrink: 0,
        }} />
        {!isLast && (
          <div style={{ width: 2, flex: 1, minHeight: 24, background: palette.border, marginTop: 2 }} />
        )}
      </div>
      <div style={{ paddingBottom: isLast ? 0 : space.x2 }}>
        <div style={{ fontSize: 13, color: hasTs ? palette.text : palette.textMute, fontWeight: 500 }}>
          {label}
        </div>
        <div style={{ fontSize: 12, color: palette.textMute, marginTop: 2 }}>
          {hasTs ? fmtTs(ts!) : "pending"}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Changes tab
// ---------------------------------------------------------------------------

function ChangesTab({ detail }: { detail: ProposalDetail }): ReactElement {
  return (
    <Card>
      <SectionLabel>Linked Repository</SectionLabel>
      {detail.repoFullName ? (
        <p style={{ fontSize: 13, color: palette.cyan, margin: "0 0 16px" }}>
          {detail.repoFullName}
        </p>
      ) : (
        <p style={{ fontSize: 13, color: palette.textDim, margin: "0 0 16px" }}>
          No repo target recorded for this proposal.
        </p>
      )}

      <SectionLabel>Top 3 Commits in Proposal Window</SectionLabel>
      {detail.linkedCommits.length === 0 ? (
        <p style={{ fontSize: 13, color: palette.textDim, margin: 0 }}>
          No commits found in the synced window for this proposal.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: space.x2 }}>
          {detail.linkedCommits.map((c) => (
            <CommitCard key={c.sha} commit={c} />
          ))}
        </div>
      )}
    </Card>
  );
}

function CommitCard({ commit }: { commit: LinkedCommit }): ReactElement {
  return (
    <div style={{
      padding: `${space.x2}px ${space.x3}px`,
      background: palette.bgRaised,
      borderRadius: radius.md,
      border: `1px solid ${palette.border}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: space.x1 }}>
        <span style={{ fontFamily: "monospace", fontSize: 11, color: palette.textMute }}>
          {commit.sha.slice(0, 8)}
        </span>
        <span style={{ fontSize: 11, color: palette.textMute }}>{fmtTs(commit.ts)}</span>
      </div>
      <p style={{ fontSize: 13, color: palette.text, margin: "4px 0 0", wordBreak: "break-word" }}>
        {commit.messageFirstLine ?? "(no message)"}
      </p>
      <div style={{ display: "flex", gap: space.x3, marginTop: 4, fontSize: 11, color: palette.textMute }}>
        {commit.actorLogin && <span>by {commit.actorLogin}</span>}
        {commit.changedFiles != null && (
          <span>{commit.changedFiles} file{commit.changedFiles !== 1 ? "s" : ""} changed</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feedback tab
// ---------------------------------------------------------------------------

function FeedbackTab({ detail }: { detail: ProposalDetail }): ReactElement {
  const outcome = detail.timeline.outcome;
  const isRejected = outcome === "rejected" || outcome === "failed";

  return (
    <Card>
      <SectionLabel>Outcome</SectionLabel>
      <div style={{
        display: "inline-block",
        padding: `${space.x05}px ${space.x2}px`,
        borderRadius: radius.sm,
        background: palette.bgRaised,
        border: `1px solid ${outcomeToColor(outcome)}`,
        color: outcomeToColor(outcome),
        fontSize: 13,
        fontWeight: 600,
        marginBottom: space.x3,
      }}>
        {outcome ?? "pending"}
      </div>

      {isRejected && (
        <>
          <SectionLabel>Rejection Reason</SectionLabel>
          {detail.rejectionReason ? (
            <div style={{
              padding: space.x3,
              background: palette.bgRaised,
              borderRadius: radius.md,
              border: `1px solid ${palette.border}`,
              fontSize: 13,
              color: palette.text,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}>
              {detail.rejectionReason}
            </div>
          ) : (
            <p style={{ fontSize: 13, color: palette.textDim, margin: 0 }}>
              No rejection reason was recorded.
            </p>
          )}
        </>
      )}

      {!isRejected && !detail.rejectionReason && (
        <p style={{ fontSize: 13, color: palette.textDim, margin: 0 }}>
          {outcome === "applied"
            ? "Proposal was applied successfully. No feedback to show."
            : "No feedback recorded yet."}
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared micro-components
// ---------------------------------------------------------------------------

function Card({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <div style={{
      padding: space.x5,
      background: palette.bgSurface,
      borderRadius: radius.lg,
      border: `1px solid ${palette.border}`,
    }}>
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <p style={{ fontSize: 11, fontWeight: 600, color: palette.textMute, textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 12px" }}>
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function outcomeToColor(outcome: string | null | undefined): string {
  switch (outcome) {
    case "applied": case "done":    return palette.green;
    case "rejected": case "failed": return palette.red;
    case "claimed":                 return palette.amber;
    default:                        return palette.textDim;
  }
}

function fmtTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

