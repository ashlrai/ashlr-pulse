/**
 * Fleet tab — surfaces ashlr-hub autonomous fleet activity inside Pulse.
 *
 * Receives pre-loaded data from the shell (page.tsx) — no DB calls here.
 * All charts reuse existing chart primitives (HBarChart, DonutChart,
 * LineChart) following the today/trends TabProps pattern.
 */

import type { ReactElement } from "react";

import { fmtUsd } from "@/lib/pricing";
import { palette, space } from "@/lib/theme";

import { Card, CardHeader } from "@/components/ui/Card";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { HBarChart } from "@/components/charts/HBarChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { LineChart } from "@/components/charts/LineChart";

import type { TabProps } from "./types";

// ─── Main tab component ──────────────────────────────────────────────

export function FleetTab({ data, windowOpt }: TabProps): ReactElement {
  const { fleet } = data;

  if (!fleet) {
    return (
      <div style={{ marginTop: space.x6 }}>
        <Card style={{ borderStyle: "dashed" }}>
          <div style={{ fontSize: 13, color: palette.textDim, lineHeight: 1.7 }}>
            <span style={{ color: palette.green, marginRight: 6, letterSpacing: "0.4px", textTransform: "uppercase", fontSize: 11 }}>
              fleet
            </span>
            No ashlr-fleet events in the last {windowOpt.days} days.{" "}
            <span style={{ color: palette.textMute }}>
              Start the fleet with <code style={{ color: palette.cyan }}>/loop</code> in ashlr-hub to see autonomous activity here.
            </span>
          </div>
        </Card>
      </div>
    );
  }

  const mergeRate = fleet.proposals > 0
    ? Math.round((fleet.merges / fleet.proposals) * 100)
    : 0;

  return (
    <>
      {/* Status strip */}
      <div className="dash-stat-strip" style={{ marginTop: space.x4 }}>
        <FleetStatCard
          accent={palette.green}
          label="ticks"
          value={fleet.ticks.toLocaleString()}
          hint={fleet.lastTickTs ? `last ${fmtAgo(new Date(fleet.lastTickTs))}` : "no ticks yet"}
        />
        <FleetStatCard
          accent={palette.cyan}
          label="proposals"
          value={fleet.proposals.toLocaleString()}
          hint={`${windowOpt.days}d window`}
        />
        <FleetStatCard
          accent={palette.magenta}
          label="merges"
          value={fleet.merges.toLocaleString()}
          hint={fleet.proposals > 0 ? `${mergeRate}% merge rate` : undefined}
        />
        <FleetStatCard
          accent={palette.amber}
          label="declines"
          value={fleet.declines.toLocaleString()}
          hint={fleet.proposals > 0 ? `${100 - mergeRate}% decline rate` : undefined}
        />
      </div>

      <div className="dash-grid" style={{ marginTop: space.x5 }}>

        {/* Per-repo proposal throughput */}
        {fleet.repoProposals.length > 0 && (
          <ChartFrame
            title={`proposals by repo · last ${windowOpt.days}d`}
            hint="fleet proposals generated per repository"
            accent={palette.cyan}
          >
            <HBarChart
              data={fleet.repoProposals}
              valueFormat="locale"
              uniformColor={palette.cyan}
            />
          </ChartFrame>
        )}

        {/* Per-repo merge throughput */}
        {fleet.repoMerges.length > 0 && (
          <ChartFrame
            title={`merges by repo · last ${windowOpt.days}d`}
            hint="fleet proposals that were auto-merged per repository"
            accent={palette.magenta}
          >
            <HBarChart
              data={fleet.repoMerges}
              valueFormat="locale"
              uniformColor={palette.magenta}
            />
          </ChartFrame>
        )}

        {/* Engine mix donut */}
        {fleet.engineMix.length > 0 && (
          <ChartFrame
            title="engine mix"
            hint="fleet events by backend engine (codex | claude | builtin | hermes)"
            accent={palette.purple}
          >
            <DonutChart
              data={fleet.engineMix}
              valueFormat="locale"
              centerLabel="events"
            />
          </ChartFrame>
        )}

        {/* Token + cost trend */}
        <ChartFrame
          title={`fleet token & cost trend · last ${windowOpt.days}d`}
          hint="daily tokens processed and cost incurred by the fleet"
          accent={palette.green}
        >
          {fleet.daily.some((d) => d.tokens > 0 || d.costCents > 0) ? (
            <LineChart
              data={fleet.daily}
              series={[
                { key: "tokens",    label: "tokens",    color: palette.green  },
                { key: "costCents", label: "cost ($)",  color: palette.magenta },
              ]}
              yFormat="abbrev"
              valueFormat="abbrev"
            />
          ) : (
            <EmptyChart label="No token data in this window yet." />
          )}
        </ChartFrame>

      </div>

      {/* Auto-merge feed */}
      {fleet.recentMerges.length > 0 && (
        <div style={{ marginTop: space.x5 }}>
          <Card accent={palette.magenta}>
            <CardHeader
              title="auto-merge feed"
              hint={`last ${fleet.recentMerges.length} fleet merges`}
            />
            <MergeFeed rows={fleet.recentMerges} />
          </Card>
        </div>
      )}
    </>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────

function FleetStatCard({
  accent,
  label,
  value,
  hint,
}: {
  accent: string;
  label: string;
  value: string;
  hint?: string;
}): ReactElement {
  return (
    <div style={{
      background: palette.bgSurface,
      border: `1px solid ${accent}30`,
      borderRadius: 8,
      padding: `${space.x3} ${space.x4}`,
      flex: "1 1 120px",
    }}>
      <div style={{ fontSize: 10, color: palette.textMute, letterSpacing: "0.5px", textTransform: "uppercase", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, color: accent, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: 10, color: palette.textMute, marginTop: 4 }}>{hint}</div>
      )}
    </div>
  );
}

// ─── Merge feed ───────────────────────────────────────────────────────

function MergeFeed({
  rows,
}: {
  rows: { ts: string; repo: string | null; engine: string | null; costCents: number | null }[];
}): ReactElement {
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 12 }}>
      {rows.map((r, i) => (
        <li
          key={i}
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: space.x3,
            padding: "8px 0",
            borderBottom: `1px dashed ${palette.border}`,
          }}
        >
          <span style={{ color: palette.magenta, fontSize: 10, minWidth: 32 }}>merge</span>
          <span style={{ color: palette.textDim, fontSize: 11, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {r.repo ?? "(unknown repo)"}
          </span>
          {r.engine && (
            <span style={{ color: palette.purple, fontSize: 10, minWidth: 60, textAlign: "right" }}>
              {r.engine}
            </span>
          )}
          {r.costCents != null && (
            <span style={{ color: palette.textMute, fontSize: 10, minWidth: 48, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              {fmtUsd(r.costCents)}
            </span>
          )}
          <span style={{ color: palette.textMute, fontSize: 10, minWidth: 56, textAlign: "right" }}>
            {fmtAgo(new Date(r.ts))}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────

function EmptyChart({ label }: { label: string }): ReactElement {
  return (
    <div style={{
      height: 180,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: palette.textMute,
      fontSize: 12,
      border: `1px dashed ${palette.border}`,
      borderRadius: 6,
    }}>
      {label}
    </div>
  );
}

// ─── Utility ──────────────────────────────────────────────────────────

function fmtAgo(d: Date): string {
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
