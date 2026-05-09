/**
 * ParallelDonuts.tsx — two side-by-side PieCharts sharing a single legend.
 *
 * Both donuts use the same color assignment so legend items map cleanly
 * to both charts (useful for "this week vs last week" or "cost vs tokens").
 * Slices beyond the top 7 are collapsed into an "other" bucket per chart.
 */

"use client";

import type { ReactElement } from "react";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip as RTooltip,
  Legend,
} from "recharts";
import { palette, chartColor } from "@/lib/theme";
import { CyberTooltip } from "./Tooltip";

interface Slice {
  name:  string;
  value: number;
}

interface DonutDef {
  title: string;
  data:  Slice[];
}

interface Props {
  left:    DonutDef;
  right:   DonutDef;
  height?: number;
}

const MAX_SLICES = 8;

/** Collapse tail slices into "other" so the legend stays readable. */
function cap(slices: Slice[]): Slice[] {
  if (slices.length <= MAX_SLICES) return slices;
  const top   = slices.slice(0, MAX_SLICES - 1);
  const other = slices.slice(MAX_SLICES - 1).reduce((acc, s) => acc + s.value, 0);
  return [...top, { name: "other", value: other }];
}

function SingleDonut({
  title,
  data,
  colorMap,
  height,
}: {
  title:    string;
  data:     Slice[];
  colorMap: Map<string, string>;
  height:   number;
}): ReactElement {
  const total = data.reduce((a, d) => a + d.value, 0);

  return (
    <div style={{ flex: "1 1 0", minWidth: 0, position: "relative" }}>
      <div
        style={{
          textAlign:     "center",
          fontSize:      11,
          color:         palette.textDim,
          textTransform: "uppercase",
          letterSpacing: "0.7px",
          fontFamily:    "var(--font-mono), monospace",
          marginBottom:  4,
        }}
      >
        {title}
      </div>
      <div style={{ position: "relative", height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <RTooltip cursor={false} content={<CyberTooltip />} />
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="58%"
              outerRadius="88%"
              strokeWidth={1}
              stroke={palette.bg}
              isAnimationActive
              animationDuration={500}
            >
              {data.map((d) => (
                <Cell key={d.name} fill={colorMap.get(d.name) ?? palette.textDim} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        {/* Center label */}
        <div
          style={{
            position:       "absolute",
            inset:          0,
            display:        "flex",
            alignItems:     "center",
            justifyContent: "center",
            flexDirection:  "column",
            pointerEvents:  "none",
          }}
        >
          <div
            style={{
              fontSize:           20,
              fontWeight:         600,
              color:              palette.text,
              fontVariantNumeric: "tabular-nums",
              letterSpacing:      "-0.3px",
            }}
          >
            {total >= 1_000_000
              ? `${(total / 1_000_000).toFixed(1)}M`
              : total >= 1_000
                ? `${(total / 1_000).toFixed(1)}k`
                : `${total}`}
          </div>
          <div style={{ fontSize: 9, color: palette.textDim, marginTop: 2, letterSpacing: "0.5px" }}>
            total
          </div>
        </div>
      </div>
    </div>
  );
}

export function ParallelDonuts({ left, right, height = 280 }: Props): ReactElement {
  const cappedLeft  = cap(left.data);
  const cappedRight = cap(right.data);

  // Build a union of all names so both donuts get the same colors.
  const allNames = Array.from(
    new Set([...cappedLeft.map((d) => d.name), ...cappedRight.map((d) => d.name)]),
  );
  const colorMap = new Map<string, string>(
    allNames.map((name, i) => [name, chartColor(i)]),
  );

  const legendItems = allNames.map((name) => ({
    value: name,
    color: colorMap.get(name) ?? palette.textDim,
    type:  "circle" as const,
  }));

  const donutH = height - 40; // reserve space for shared legend

  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", gap: 16 }}>
        <SingleDonut
          title={left.title}
          data={cappedLeft}
          colorMap={colorMap}
          height={donutH}
        />
        <SingleDonut
          title={right.title}
          data={cappedRight}
          colorMap={colorMap}
          height={donutH}
        />
      </div>
      {/* Shared legend rendered manually for single-source-of-truth coloring */}
      <div
        style={{
          display:        "flex",
          flexWrap:       "wrap",
          justifyContent: "center",
          gap:            "4px 12px",
          marginTop:      8,
          fontSize:       11,
          color:          palette.textDim,
          fontFamily:     "var(--font-mono), monospace",
        }}
      >
        {legendItems.map((item) => (
          <span key={item.value} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span
              style={{
                width:        8,
                height:       8,
                borderRadius: "50%",
                background:   item.color,
                display:      "inline-block",
              }}
            />
            {item.value}
          </span>
        ))}
      </div>
    </div>
  );
}
