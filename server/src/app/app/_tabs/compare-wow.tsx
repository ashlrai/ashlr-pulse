/**
 * compare-wow.tsx — Week-over-Week peer-share trend tab.
 *
 * URL state: ?tab=compare&period=wow  (bookmarkable)
 *
 * Surfaces:
 *   • Two stat cards side-by-side: "This week" vs "Last week" with %delta
 *   • LineChart overlay: this-week tokens (blue) vs last-week tokens (gray dashed)
 *   • Per-user cost/token breakdown table with delta% (color-coded)
 *
 * Peer-share scoped — viewers only see repos they are granted access to.
 * Field visibility is enforced by readWeeklyRows which filters to the
 * viewer's granted fields[] array before returning rows.
 *
 * This is a server component — data is fetched at render time, no client
 * state except the URL params handled by the parent shell.
 */

import type { ReactElement } from "react";
import {
  buildWowDeltas,
  isoWeekStart,
  rowsToTotals,
  type WowDelta,
  type WeeklyTotals,
} from "@/lib/peer-share-weekly-agg";
import { palette, space, cardStyle } from "@/lib/theme";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { LineChart, type LinePoint } from "@/components/charts/LineChart";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CompareWowProps {
  /** Weekly rows for this week already resolved by the parent page. */
  thisWeek: WeeklyTotals;
  /** Weekly rows for last week already resolved by the parent page. */
  lastWeek: WeeklyTotals;
  /**
   * Per-user breakdown rows — one entry per viewer-facing owner whose data
   * is visible under this grant. In the common single-owner case this is a
   * single entry.
   */
  perUser: Array<{
    ownerId: string;
    ownerEmail: string;
    thisWeek: WeeklyTotals;
    lastWeek: WeeklyTotals;
  }>;
  /** Daily token points for the trend chart (last 14 days). */
  dailyPoints: Array<{ day: string; thisWeekTokens: number; lastWeekTokens: number }>;
}

// ---------------------------------------------------------------------------
// Delta colour helpers
// ---------------------------------------------------------------------------

/**
 * Color-code delta percentage:
 *   red    > +20%   (high growth — cost alert)
 *   yellow  5–20%   (moderate growth)
 *   green  < 5%     (stable / declining)
 */
function deltaColor(pct: number): string {
  const abs = Math.abs(pct);
  if (abs > 20) return palette.red;
  if (abs > 5)  return palette.amber;
  return palette.green;
}

function fmtDelta(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function fmtMillicents(mc: number): string {
  // Display as cents with 2dp
  const cents = mc / 1000;
  if (cents >= 100) return `$${(cents / 100).toFixed(2)}`;
  return `${cents.toFixed(2)}¢`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function WeekStatCard({
  label,
  costMillicents,
  tokens,
  eventCount,
  accent,
}: {
  label: string;
  costMillicents: number;
  tokens: number;
  eventCount: number;
  accent: string;
}): ReactElement {
  return (
    <div
      style={{
        ...cardStyle(),
        padding: "18px 20px",
        flex: 1,
        minWidth: 180,
        borderTop: `2px solid ${accent}`,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: palette.textMute,
          textTransform: "uppercase",
          letterSpacing: "0.7px",
          fontFamily: "var(--font-mono), monospace",
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <StatRow label="cost"   value={fmtMillicents(costMillicents)} accent={accent} />
        <StatRow label="tokens" value={fmtTokens(tokens)}             accent={accent} />
        <StatRow label="events" value={String(eventCount)}            accent={accent} />
      </div>
    </div>
  );
}

function StatRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}): ReactElement {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
      <span
        style={{
          fontSize: 11,
          color: palette.textDim,
          fontFamily: "var(--font-mono), monospace",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: accent,
          fontFamily: "var(--font-mono), monospace",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function DeltaBadge({ pct }: { pct: number }): ReactElement {
  const color = deltaColor(pct);
  const arrow = pct > 0.05 ? "↑" : pct < -0.05 ? "↓" : "→";
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: 11,
        fontFamily: "var(--font-mono), monospace",
        color,
        background: `${color}18`,
        borderRadius: 4,
        padding: "1px 6px",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {arrow} {fmtDelta(pct)}
    </span>
  );
}

function PerUserTable({
  rows,
}: {
  rows: Array<{
    ownerId: string;
    ownerEmail: string;
    thisWeek: WeeklyTotals;
    lastWeek: WeeklyTotals;
  }>;
}): ReactElement {
  if (rows.length === 0) {
    return (
      <div
        style={{
          textAlign: "center",
          color: palette.textMute,
          fontSize: 12,
          padding: "24px 0",
          fontFamily: "var(--font-mono), monospace",
        }}
      >
        no peer-share data for this period
      </div>
    );
  }

  const thStyle: React.CSSProperties = {
    fontSize: 10,
    color: palette.textMute,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    fontFamily: "var(--font-mono), monospace",
    padding: "6px 8px",
    textAlign: "left" as const,
    borderBottom: `1px solid ${palette.border}`,
  };
  const tdStyle: React.CSSProperties = {
    fontSize: 12,
    color: palette.text,
    fontFamily: "var(--font-mono), monospace",
    padding: "8px 8px",
    borderBottom: `1px solid ${palette.border}`,
    verticalAlign: "middle" as const,
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={thStyle}>user</th>
            <th style={{ ...thStyle, textAlign: "right" as const }}>cost (this wk)</th>
            <th style={{ ...thStyle, textAlign: "right" as const }}>cost (last wk)</th>
            <th style={{ ...thStyle, textAlign: "right" as const }}>cost delta</th>
            <th style={{ ...thStyle, textAlign: "right" as const }}>tokens (this wk)</th>
            <th style={{ ...thStyle, textAlign: "right" as const }}>tokens (last wk)</th>
            <th style={{ ...thStyle, textAlign: "right" as const }}>token delta</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const deltas = buildWowDeltas(row.thisWeek, row.lastWeek);
            const costDelta  = deltas.find((d) => d.field === "cost_millicents");
            const tokenDelta = deltas.find((d) => d.field === "tokens_input");
            const totalTokensThis = row.thisWeek.tokensInput + row.thisWeek.tokensOutput;
            const totalTokensLast = row.lastWeek.tokensInput + row.lastWeek.tokensOutput;
            const tokenTotalDeltaPct = totalTokensLast === 0
              ? 0
              : Math.round(((totalTokensThis - totalTokensLast) / totalTokensLast) * 10_000) / 100;

            return (
              <tr key={row.ownerId}>
                <td style={tdStyle}>{row.ownerEmail}</td>
                <td style={{ ...tdStyle, textAlign: "right" as const }}>
                  {fmtMillicents(row.thisWeek.costMillicents)}
                </td>
                <td style={{ ...tdStyle, textAlign: "right" as const, color: palette.textDim }}>
                  {fmtMillicents(row.lastWeek.costMillicents)}
                </td>
                <td style={{ ...tdStyle, textAlign: "right" as const }}>
                  {costDelta ? <DeltaBadge pct={costDelta.deltaPct} /> : "—"}
                </td>
                <td style={{ ...tdStyle, textAlign: "right" as const }}>
                  {fmtTokens(totalTokensThis)}
                </td>
                <td style={{ ...tdStyle, textAlign: "right" as const, color: palette.textDim }}>
                  {fmtTokens(totalTokensLast)}
                </td>
                <td style={{ ...tdStyle, textAlign: "right" as const }}>
                  <DeltaBadge pct={tokenTotalDeltaPct} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function CompareWowTab({
  thisWeek,
  lastWeek,
  perUser,
  dailyPoints,
}: CompareWowProps): ReactElement {
  const deltas = buildWowDeltas(thisWeek, lastWeek);
  const costDelta   = deltas.find((d) => d.field === "cost_millicents");
  const tokenDelta  = deltas.find((d) => d.field === "tokens_input");

  // Build LineChart data — overlay this-week tokens (blue) vs last-week (gray)
  const chartData: LinePoint[] = dailyPoints.map((pt) => ({
    bucket:         pt.day,
    thisWeekTokens: pt.thisWeekTokens,
    lastWeekTokens: pt.lastWeekTokens,
  }));

  const thisWeekIso = thisWeek.weekStartIso;
  const lastWeekIso = lastWeek.weekStartIso;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>

      {/* Header */}
      <div>
        <h2
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: palette.text,
            fontFamily: "var(--font-mono), monospace",
            margin: 0,
            marginBottom: 4,
          }}
        >
          week-over-week comparison
        </h2>
        <p style={{ fontSize: 12, color: palette.textDim, margin: 0 }}>
          {lastWeekIso} → {thisWeekIso} · peer-share scoped · bookmarkable at <code>?tab=compare&amp;period=wow</code>
        </p>
      </div>

      {/* Stat cards row */}
      <div style={{ display: "flex", gap: space.x3, flexWrap: "wrap" }}>
        <WeekStatCard
          label={`this week (${thisWeekIso})`}
          costMillicents={thisWeek.costMillicents}
          tokens={thisWeek.tokensInput + thisWeek.tokensOutput}
          eventCount={thisWeek.eventCount}
          accent={palette.cyan}
        />
        <WeekStatCard
          label={`last week (${lastWeekIso})`}
          costMillicents={lastWeek.costMillicents}
          tokens={lastWeek.tokensInput + lastWeek.tokensOutput}
          eventCount={lastWeek.eventCount}
          accent={palette.textDim}
        />

        {/* Delta summary card */}
        <div
          style={{
            ...cardStyle(),
            padding: "18px 20px",
            flex: 1,
            minWidth: 160,
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: palette.textMute,
              textTransform: "uppercase",
              letterSpacing: "0.7px",
              fontFamily: "var(--font-mono), monospace",
              marginBottom: 10,
            }}
          >
            wow delta
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: palette.textMute, marginBottom: 3, fontFamily: "var(--font-mono), monospace" }}>
                cost
              </div>
              {costDelta ? <DeltaBadge pct={costDelta.deltaPct} /> : <span style={{ color: palette.textMute }}>—</span>}
            </div>
            <div>
              <div style={{ fontSize: 10, color: palette.textMute, marginBottom: 3, fontFamily: "var(--font-mono), monospace" }}>
                tokens (input)
              </div>
              {tokenDelta ? <DeltaBadge pct={tokenDelta.deltaPct} /> : <span style={{ color: palette.textMute }}>—</span>}
            </div>
            <div>
              <div style={{ fontSize: 10, color: palette.textMute, marginBottom: 3, fontFamily: "var(--font-mono), monospace" }}>
                events
              </div>
              {(() => {
                const evDelta = deltas.find((d) => d.field === "event_count");
                return evDelta ? <DeltaBadge pct={evDelta.deltaPct} /> : <span style={{ color: palette.textMute }}>—</span>;
              })()}
            </div>
          </div>
        </div>
      </div>

      {/* Token trend chart: this-week (blue) vs last-week (gray dashed) */}
      {chartData.length > 0 && (
        <ChartFrame
          title="token trend · this week vs last week"
          hint="input tokens by day"
          accent={palette.cyan}
        >
          <LineChart
            data={chartData}
            series={[
              { key: "thisWeekTokens", label: "this week", color: palette.cyan },
              { key: "lastWeekTokens", label: "last week", color: palette.textDim },
            ]}
            yFormat="abbrev"
            valueFormat="abbrev"
            height={200}
          />
        </ChartFrame>
      )}

      {/* Per-user breakdown table */}
      <div style={cardStyle()}>
        <div
          style={{
            padding: "14px 16px 10px",
            borderBottom: `1px solid ${palette.border}`,
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: palette.text,
              fontFamily: "var(--font-mono), monospace",
            }}
          >
            per-user breakdown
          </span>
          <span
            style={{
              fontSize: 11,
              color: palette.textMute,
              marginLeft: 8,
              fontFamily: "var(--font-mono), monospace",
            }}
          >
            cost · tokens · wow delta
          </span>
        </div>
        <div style={{ padding: "0 0 4px" }}>
          <PerUserTable rows={perUser} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Utility: build CompareWowProps from raw weekly rows for a page loader
// ---------------------------------------------------------------------------

/**
 * Helper to turn flat PeerShareWeeklyRow[] into the structured props shape
 * expected by CompareWowTab. Call this from a page/layout server component.
 *
 * `asOf` defaults to now — used to derive thisWeek / lastWeek ISO strings.
 */
export { buildWowDeltas, isoWeekStart, rowsToTotals } from "@/lib/peer-share-weekly-agg";
