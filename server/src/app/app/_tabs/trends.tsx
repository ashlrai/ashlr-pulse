/**
 * Trends tab — stacked area by source, token type breakdown, cost-by-model,
 * cache efficiency, GitHub throughput, cost trajectory + forecast, heatmap.
 *
 * All data arrives pre-loaded from the shell (page.tsx).
 */

import type { ReactElement } from "react";

import { palette, space } from "@/lib/theme";

import { ChartFrame } from "@/components/charts/ChartFrame";
import { StackedAreaChart } from "@/components/charts/StackedAreaChart";
import { LineChart } from "@/components/charts/LineChart";
import { Heatmap } from "@/components/charts/Heatmap";
import { RadialGauge } from "@/components/charts/RadialGauge";

import type { TabProps } from "./types";

export function TrendsTab({
  data,
  windowOpt,
  cacheHit,
  totalReads,
  totalWrites,
  projection,
  trajectoryPoints,
}: TabProps): ReactElement {
  // projTotal for the chart hint
  const projP50 = projection.reduce((a, f) => a + f.p50, 0);
  const projP10 = projection.reduce((a, f) => a + f.p10, 0);
  const projP90 = projection.reduce((a, f) => a + f.p90, 0);

  return (
    <div className="dash-grid" style={{ marginTop: space.x4 }}>

      {/* Stacked area — activity by source */}
      <div className="dash-grid-full">
        <ChartFrame
          title={`activity · last ${windowOpt.days} days`}
          hint="tokens per day, stacked by source"
          accent={palette.green}
        >
          {data.stackedArea.length > 0 && data.sources.length > 0 ? (
            <StackedAreaChart
              data={data.stackedArea}
              series={data.sources}
              valueFormat="abbrev"
            />
          ) : (
            <EmptyChart label="No data in the last 14 days yet." />
          )}
        </ChartFrame>
      </div>

      {/* Token-type breakdown */}
      <ChartFrame
        title={`token mix · last ${windowOpt.days}d`}
        hint="input · output · reasoning · cache (read + 5m + 1h)"
        accent={palette.cyan}
      >
        {data.tokenBreakdown.some((b) =>
          b.input + b.output + b.reasoning + b.cache_read + b.cache_5m_write + b.cache_1h_write + b.cache_write_legacy > 0
        ) ? (
          <StackedAreaChart
            data={data.tokenBreakdown}
            series={["input", "output", "reasoning", "cache_read", "cache_5m_write", "cache_1h_write", "cache_write_legacy"]}
            valueFormat="abbrev"
          />
        ) : (
          <EmptyChart label="No token data yet." />
        )}
      </ChartFrame>

      {/* Cost by model stacked area */}
      <ChartFrame
        title={`cost by model · last ${windowOpt.days}d`}
        hint="daily cost ($) stacked by model"
        accent={palette.amber}
      >
        {data.models.length > 0 ? (
          <StackedAreaChart
            data={data.byModel.map((row) => {
              // Convert cents → dollars for display continuity with the
              // cost-trajectory chart.
              const out: { bucket: string; [k: string]: string | number } = { bucket: row.bucket as string };
              for (const m of data.models) {
                const v = row[m];
                out[m] = typeof v === "number" ? v / 100 : 0;
              }
              return out;
            })}
            series={data.models}
            valueFormat="dollars-2dp"
          />
        ) : (
          <EmptyChart label="No priced data yet." />
        )}
      </ChartFrame>

      {/* Cache efficiency */}
      <ChartFrame
        title={`cache efficiency · last ${windowOpt.days}d`}
        hint="read-to-write ratio"
        accent={palette.amber}
      >
        {totalReads + totalWrites > 0 ? (
          <CacheEfficiencyPanel cacheHit={cacheHit} efficiency={data.cacheEfficiency} />
        ) : (
          <EmptyChart label="No cache data yet." />
        )}
      </ChartFrame>

      {/* Cost trajectory + forecast */}
      <ChartFrame
        title={`cost trajectory · last ${windowOpt.days}d + 30d projection`}
        hint={projP50 > 0
          ? `~$${(projP50 / 100_000).toFixed(0)} projected next 30d · ±$${((projP90 - projP10) / 200_000).toFixed(0)}`
          : "cumulative dollars"}
        accent={palette.magenta}
      >
        {data.costTrajectory.length > 0 ? (
          <LineChart
            data={trajectoryPoints}
            series={[
              { key: "cost",      label: "cumulative $", color: palette.magenta },
              { key: "projected", label: "projected",     color: palette.amber  },
            ]}
            yFormat="dollars-int"
            valueFormat="dollars-2dp"
          />
        ) : (
          <EmptyChart label="No cost data yet." />
        )}
      </ChartFrame>

      {/* Git/GitHub throughput — only render when there's data */}
      {(data.githubTotals.commits + data.githubTotals.prs_opened + data.githubTotals.prs_merged) > 0 && (
        <div className="dash-grid-full">
          <ChartFrame
            title={`git throughput · last ${windowOpt.days}d`}
            hint={`${data.githubTotals.commits} commits (${data.commitTotals.githubCommits} GitHub, fallback when needed) · ${data.githubTotals.prs_opened} prs opened · ${data.githubTotals.prs_merged} merged`}
            accent={palette.purple}
          >
            <LineChart
              data={data.github}
              series={[
                { key: "commits",    label: "commits",    color: palette.green   },
                { key: "prs_opened", label: "prs opened", color: palette.cyan    },
                { key: "prs_merged", label: "prs merged", color: palette.magenta },
              ]}
              yFormat="int"
              valueFormat="locale"
              height={220}
            />
          </ChartFrame>
        </div>
      )}

      {/* Heatmap — hour-of-day × day-of-week */}
      <div className="dash-grid-full">
        <ChartFrame
          title="when you actually work · last 30d"
          hint="hour-of-day × day-of-week — darker = more events"
          accent={palette.green}
          minHeight={180}
        >
          {data.heatmap.length > 0 ? (
            <Heatmap cells={data.heatmap} />
          ) : (
            <EmptyChart label="Not enough data for a heatmap yet." />
          )}
        </ChartFrame>
      </div>

    </div>
  );
}

// ─── Inline sub-components ────────────────────────────────────────────

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

function CacheEfficiencyPanel({
  cacheHit,
  efficiency,
}: {
  cacheHit: number;
  efficiency: { bucket: string; ratio: number }[];
}): ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: space.x4 }}>
      <RadialGauge value={cacheHit} label="cache hit (14d)" color={palette.amber} size={130} />
      <div style={{ flex: 1, minWidth: 0, height: 130 }}>
        <LineChart
          data={efficiency}
          series={[{ key: "ratio", label: "read/write", color: palette.amber }]}
          yFormat="decimal-1"
          valueFormat="ratio"
          height={130}
        />
      </div>
    </div>
  );
}
