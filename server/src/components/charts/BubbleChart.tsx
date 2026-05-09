/**
 * BubbleChart.tsx — Recharts ScatterChart with Z (size) channel.
 *
 * Bubble area encodes the `size` prop so the user gets three dimensions
 * of information (x, y, magnitude) in one chart. Useful for model ×
 * cost × volume, or repo × tokens × days-active scatter plots.
 */

"use client";

import type { ReactElement } from "react";
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Cell,
} from "recharts";
import { palette, chartColor } from "@/lib/theme";

interface BubblePoint {
  x:      number;
  y:      number;
  size:   number;
  label:  string;
  color?: string;
}

interface Props {
  data:    BubblePoint[];
  xLabel:  string;
  yLabel:  string;
  height?: number;
}

interface TooltipProps {
  active?:  boolean;
  payload?: Array<{ payload?: BubblePoint }>;
}

function BubbleTooltip({ active, payload }: TooltipProps): ReactElement | null {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div
      style={{
        background:   "rgba(8,8,10,0.95)",
        border:       `1px solid ${palette.borderHi}`,
        borderRadius: 6,
        padding:      "8px 10px",
        fontSize:     11,
        fontFamily:   "var(--font-mono), monospace",
        color:        palette.text,
        boxShadow:    "0 12px 32px rgba(0,0,0,0.5)",
        minWidth:     120,
      }}
    >
      <div style={{ color: palette.textDim, marginBottom: 4 }}>{d.label}</div>
      <div style={{ fontVariantNumeric: "tabular-nums" }}>
        x: <span style={{ color: palette.cyan }}>{d.x}</span>
      </div>
      <div style={{ fontVariantNumeric: "tabular-nums" }}>
        y: <span style={{ color: palette.green }}>{d.y}</span>
      </div>
      <div style={{ fontVariantNumeric: "tabular-nums" }}>
        size: <span style={{ color: palette.amber }}>{d.size}</span>
      </div>
    </div>
  );
}

export function BubbleChart({ data, xLabel, yLabel, height = 280 }: Props): ReactElement {
  // ZAxis range maps size value → pixel radius² (Recharts uses area).
  const maxSize = Math.max(...data.map((d) => d.size), 1);
  const zRange: [number, number] = [40, 1200];

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 16, right: 16, left: 0, bottom: 20 }}>
        <CartesianGrid strokeDasharray="2 4" stroke={palette.border} />
        <XAxis
          type="number"
          dataKey="x"
          name={xLabel}
          label={{
            value:    xLabel,
            position: "insideBottom",
            offset:   -8,
            fill:     palette.textDim,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
          }}
          stroke={palette.textMute}
          tick={{ fill: palette.textDim, fontSize: 10, fontFamily: "var(--font-mono)" }}
          tickLine={false}
          axisLine={{ stroke: palette.border }}
        />
        <YAxis
          type="number"
          dataKey="y"
          name={yLabel}
          label={{
            value:  yLabel,
            angle:  -90,
            position: "insideLeft",
            offset: 12,
            fill:   palette.textDim,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
          }}
          stroke={palette.textMute}
          tick={{ fill: palette.textDim, fontSize: 10, fontFamily: "var(--font-mono)" }}
          tickLine={false}
          axisLine={false}
          width={42}
        />
        <ZAxis
          type="number"
          dataKey="size"
          range={zRange}
          // Normalize sizes so outliers don't crowd out everything.
          domain={[0, maxSize]}
        />
        <RTooltip
          cursor={{ strokeDasharray: "3 3", stroke: palette.borderHi }}
          content={<BubbleTooltip />}
        />
        <Scatter data={data} isAnimationActive animationDuration={500}>
          {data.map((d, i) => (
            <Cell
              key={i}
              fill={d.color ?? chartColor(i)}
              fillOpacity={0.75}
              stroke={d.color ?? chartColor(i)}
              strokeWidth={1}
            />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  );
}
