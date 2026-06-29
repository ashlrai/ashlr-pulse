/**
 * Management tab — the operator's fleet-oversight summary.
 *
 * Where the Fleet tab visualises *activity* (charts of proposals/merges over
 * time), Management answers the operator's question: "is the autonomous fleet
 * behaving, and what needs my attention?" It surfaces the approval posture
 * (proposal → merge/decline funnel), the merge rate, per-owner throughput, and
 * a direct CTA into the Fleet inbox where pending commands are approved or
 * cancelled.
 *
 * Server component — receives pre-loaded data from the shell (page.tsx), no DB
 * calls here. Reuses existing chart + card primitives following the Fleet tab
 * pattern. Privacy floor: counts and owner labels only — no content.
 */

import type { ReactElement } from "react";

import { palette, space, radius } from "@/lib/theme";
import { Card, CardHeader } from "@/components/ui/Card";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { HBarChart } from "@/components/charts/HBarChart";
import type { TabProps } from "./types";

function pct(n: number, d: number): string {
  if (d <= 0) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

export function ManagementTab({ data, windowOpt }: TabProps): ReactElement {
  const { fleet } = data;

  if (!fleet || fleet.proposals + fleet.merges + fleet.declines === 0) {
    return (
      <div style={{ marginTop: space.x6 }}>
        <Card style={{ borderStyle: "dashed" }}>
          <div style={{ fontSize: 13, color: palette.textDim, lineHeight: 1.7 }}>
            <span style={{ color: palette.green, marginRight: 6, letterSpacing: "0.4px", textTransform: "uppercase", fontSize: 11 }}>
              management
            </span>
            No autonomous fleet decisions in the last {windowOpt.days} days.{" "}
            <span style={{ color: palette.textMute }}>
              Assign work from the{" "}
              <a href="/fleet" style={{ color: palette.magenta }}>Fleet inbox</a>{" "}
              and approvals will show up here.
            </span>
          </div>
        </Card>
      </div>
    );
  }

  const decided = fleet.merges + fleet.declines;
  const mergeRate = pct(fleet.merges, decided);
  const pendingReview = Math.max(0, fleet.proposals - decided);

  // Per-owner throughput, busiest first — caps at the same 10-row budget the
  // other management charts use.
  const ownerRows = [...fleet.byOwner]
    .sort((a, b) => b.proposals - a.proposals)
    .slice(0, 10)
    .map((o) => ({ label: o.owner, value: o.proposals }));

  return (
    <div style={{ marginTop: space.x6, display: "flex", flexDirection: "column", gap: space.x4 }}>
      {/* Approval-posture stat strip */}
      <Card>
        <CardHeader title="Approval posture" hint={`last ${windowOpt.days} days`} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: space.x6, marginTop: space.x2 }}>
          <Stat label="proposals" value={fleet.proposals} color={palette.cyan} />
          <Stat label="merged" value={fleet.merges} color={palette.green} />
          <Stat label="declined" value={fleet.declines} color={palette.red} />
          <Stat label="merge rate" value={mergeRate} color={palette.text} />
          <Stat label="awaiting review" value={pendingReview} color={palette.amber} />
        </div>
        <div style={{ marginTop: space.x3 }}>
          <a
            href="/fleet"
            style={{
              display: "inline-block",
              fontSize: 13,
              color: palette.magenta,
              border: `1px solid ${palette.border}`,
              borderRadius: radius.sm,
              padding: "6px 12px",
              textDecoration: "none",
            }}
          >
            Open Fleet inbox →
          </a>
        </div>
      </Card>

      {/* Per-owner throughput */}
      {ownerRows.length > 0 && (
        <ChartFrame title="Proposals by owner" hint="who's driving the fleet">
          <HBarChart data={ownerRows} />
        </ChartFrame>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color: string;
}): ReactElement {
  return (
    <div>
      <div style={{ fontSize: 24, fontWeight: 600, color }}>{value}</div>
      <div style={{ fontSize: 11, color: palette.textMute, textTransform: "uppercase", letterSpacing: "0.4px", marginTop: 2 }}>
        {label}
      </div>
    </div>
  );
}
