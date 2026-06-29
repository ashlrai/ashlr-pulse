/**
 * CostAttributionChart.tsx — dual-panel cost attribution visualization.
 *
 * Left panel: donut of cost by source (claude_code, cursor, copilot, …).
 * Right panel: horizontal bar chart of cost by model tier.
 *
 * "use client" — recharts needs the DOM. The data is passed as plain
 * serializable props from the server component.
 */

"use client";

import type { ReactElement } from "react";
import {
  ResponsiveContainer, PieChart, Pie, Cell,
  Tooltip as RTooltip,
  BarChart, Bar, XAxis, YAxis,
} from "recharts";

import { palette, chartColor, sourceColor } from "@/lib/theme";
import { fmtUsd } from "@/lib/pricing";
import { CyberTooltip } from "@/components/charts/Tooltip";
import type {
  SourceAttributionRow,
  ModelAttributionRow,
} from "@/lib/cost-attribution-breakdown";

// ── Public props ──────────────────────────────────────────────────────────────

export interface CostAttributionChartProps {
  bySource: SourceAttributionRow[];
  byModel: ModelAttributionRow[];
  total_cents: number;
  /** When true, label cost as "rate-card" and annotate subscription sources. */
  isSubMode: boolean;
  /** Sources zeroed under subscription billing. */
  subscriptionSources?: string[];
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CostAttributionChart({
  bySource,
  byModel,
  total_cents,
  isSubMode,
  subscriptionSources = [],
}: CostAttributionChartProps): ReactElement {
  const subSet = new Set(subscriptionSources);

  // ── Source donut data — show top 8, collapse rest into "other" ──
  const TOP_SOURCES = 8;
  const topSources = bySource.slice(0, TOP_SOURCES);
  const otherSources = bySource.slice(TOP_SOURCES);
  const otherCents = otherSources.reduce((s, r) => s + (r.cost_cents ?? 0), 0);
  const donutData: { label: string; value: number; color: string }[] = [
    ...topSources.map((r) => ({
      label: r.source,
      value: r.cost_cents ?? 0,
      color: sourceColor[r.source] ?? palette.textDim,
    })),
    ...(otherCents > 0
      ? [{ label: "other", value: otherCents, color: palette.textDim }]
      : []),
  ].filter((d) => d.value > 0);

  // ── Model bar data — top 10, truncate labels to 22 chars ──
  const TOP_MODELS = 10;
  const barData = byModel.slice(0, TOP_MODELS).map((r, i) => ({
    label: r.model.length > 22 ? r.model.slice(0, 21) + "…" : r.model,
    fullLabel: r.model,
    value: r.cost_cents ?? 0,
    color: chartColor(i),
  }));

  const centerValue = fmtUsd(total_cents);
  const centerLabel = isSubMode ? "rate-card" : "attributed";

  const fmtVal = (v: number | string | undefined): string => {
    const n = typeof v === "number" ? v : Number(v ?? 0);
    return fmtUsd(Math.round(n));
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 16,
        alignItems: "start",
      }}
    >
      {/* ── Left: Source donut ── */}
      <div>
        <div
          style={{
            fontSize: 11,
            color: palette.textDim,
            marginBottom: 8,
            textTransform: "uppercase",
            letterSpacing: "0.7px",
          }}
        >
          by source
        </div>
        {donutData.length === 0 ? (
          <EmptyHint />
        ) : (
          <>
            <div style={{ position: "relative", width: "100%", height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <RTooltip
                    cursor={false}
                    content={<CyberTooltip fmt={(v) => fmtVal(v)} />}
                  />
                  <Pie
                    data={donutData}
                    dataKey="value"
                    nameKey="label"
                    innerRadius="60%"
                    outerRadius="90%"
                    strokeWidth={1}
                    stroke={palette.bg}
                    isAnimationActive
                    animationDuration={450}
                  >
                    {donutData.map((d, i) => (
                      <Cell key={i} fill={d.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              {/* Center label */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "column",
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 600,
                    color: palette.text,
                    fontVariantNumeric: "tabular-nums",
                    letterSpacing: "-0.5px",
                  }}
                >
                  {centerValue}
                </div>
                <div
                  style={{
                    fontSize: 9,
                    color: palette.textDim,
                    marginTop: 2,
                    textTransform: "uppercase",
                    letterSpacing: "0.8px",
                  }}
                >
                  {centerLabel}
                </div>
              </div>
            </div>

            {/* Source legend */}
            <SourceLegend rows={topSources} subSet={subSet} />
          </>
        )}
      </div>

      {/* ── Right: Model bar chart ── */}
      <div>
        <div
          style={{
            fontSize: 11,
            color: palette.textDim,
            marginBottom: 8,
            textTransform: "uppercase",
            letterSpacing: "0.7px",
          }}
        >
          by model
        </div>
        {barData.length === 0 ? (
          <EmptyHint />
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(120, barData.length * 28 + 24)}>
            <BarChart
              data={barData}
              layout="vertical"
              margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
            >
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="label"
                stroke={palette.textMute}
                tick={{
                  fill: palette.textDim,
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                }}
                width={132}
                tickLine={false}
                axisLine={false}
              />
              <RTooltip
                cursor={{ fill: "rgba(255,255,255,0.03)" }}
                content={<CyberTooltip fmt={(v) => fmtVal(v)} />}
              />
              <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive animationDuration={450}>
                {barData.map((d, i) => (
                  <Cell key={i} fill={d.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ── Legend ─────────────────────────────────────────────────────────────────────

function SourceLegend({
  rows,
  subSet,
}: {
  rows: SourceAttributionRow[];
  subSet: Set<string>;
}): ReactElement {
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
      {rows.map((r) => {
        const isSub = subSet.has(r.source);
        const color = sourceColor[r.source] ?? palette.textDim;
        const pct = r.cost_share > 0 ? `${(r.cost_share * 100).toFixed(1)}%` : "—";
        return (
          <div
            key={r.source}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
            }}
          >
            <span style={{ color, fontSize: 9 }}>●</span>
            <span style={{ color: palette.text, flex: 1, fontFamily: "var(--font-mono)" }}>
              {r.source}
            </span>
            {isSub && (
              <span
                style={{
                  fontSize: 9,
                  color: palette.amber,
                  background: "rgba(255,224,122,0.1)",
                  borderRadius: 3,
                  padding: "1px 4px",
                  marginRight: 4,
                }}
              >
                sub
              </span>
            )}
            <span
              style={{
                color: palette.textDim,
                fontVariantNumeric: "tabular-nums",
                minWidth: 36,
                textAlign: "right",
              }}
            >
              {pct}
            </span>
            <span
              style={{
                color: palette.text,
                fontVariantNumeric: "tabular-nums",
                minWidth: 52,
                textAlign: "right",
              }}
            >
              {fmtUsd(r.cost_cents)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function EmptyHint(): ReactElement {
  return (
    <div
      style={{
        padding: "32px 16px",
        textAlign: "center",
        color: palette.textMute,
        fontSize: 12,
        border: `1px dashed ${palette.border}`,
        borderRadius: 8,
      }}
    >
      No attributed cost data in this window.
    </div>
  );
}
