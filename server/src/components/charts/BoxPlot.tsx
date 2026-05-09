/**
 * BoxPlot.tsx — latency distribution per category using custom SVG shapes.
 *
 * Recharts has no native box-plot primitive, so this uses a custom SVG
 * layer inside a ComposedChart's CartesianGrid for axes, then overlays
 * the boxes via a CustomizedDot trick on a hidden Scatter series that
 * drives the axis domain. Optional log scale for wide latency ranges.
 *
 * Box anatomy: whisker (min→max), box (q1→q3), median line.
 */

"use client";

import type { ReactElement } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Scatter,
  Tooltip as RTooltip,
} from "recharts";
import { palette, chartColor } from "@/lib/theme";

interface BoxRow {
  category: string;
  min:      number;
  q1:       number;
  median:   number;
  q3:       number;
  max:      number;
}

interface Props {
  data:      BoxRow[];
  yLabel?:   string;
  logScale?: boolean;
  height?:   number;
}

interface ScatterPoint {
  index:    number;
  category: string;
  y:        number;
  row:      BoxRow;
}

interface CustomBoxProps {
  cx?:           number;
  cy?:           number;
  payload?:      ScatterPoint;
  xAxisMap?:     Record<string, { bandSize?: number }>;
  yAxisMap?:     Record<string, { scale?: (v: number) => number }>;
  colorIndex:    number;
}

function CustomBox({ cx, cy: _cy, payload, yAxisMap, colorIndex }: CustomBoxProps): ReactElement | null {
  if (cx == null || !payload || !yAxisMap) return null;
  const yScale = Object.values(yAxisMap)[0]?.scale;
  if (!yScale) return null;

  const { min, q1, median, q3, max } = payload.row;
  const boxW     = 28;
  const whiskerW = 14;
  const color    = chartColor(colorIndex);

  const yMin    = yScale(min);
  const yQ1     = yScale(q1);
  const yMedian = yScale(median);
  const yQ3     = yScale(q3);
  const yMax    = yScale(max);

  return (
    <g>
      {/* Whisker line: min → max */}
      <line x1={cx} y1={yMin} x2={cx} y2={yMax} stroke={color} strokeWidth={1.5} strokeOpacity={0.6} />
      {/* Min cap */}
      <line x1={cx - whiskerW / 2} y1={yMin} x2={cx + whiskerW / 2} y2={yMin} stroke={color} strokeWidth={1.5} />
      {/* Max cap */}
      <line x1={cx - whiskerW / 2} y1={yMax} x2={cx + whiskerW / 2} y2={yMax} stroke={color} strokeWidth={1.5} />
      {/* IQR box */}
      <rect
        x={cx - boxW / 2}
        y={yQ3}
        width={boxW}
        height={yQ1 - yQ3}
        fill={color}
        fillOpacity={0.2}
        stroke={color}
        strokeWidth={1.5}
        rx={2}
      />
      {/* Median line */}
      <line
        x1={cx - boxW / 2}
        y1={yMedian}
        x2={cx + boxW / 2}
        y2={yMedian}
        stroke={color}
        strokeWidth={2.5}
      />
    </g>
  );
}

interface TooltipProps {
  active?:  boolean;
  payload?: Array<{ payload?: ScatterPoint }>;
}

function BoxTooltip({ active, payload }: TooltipProps): ReactElement | null {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload?.row;
  if (!row) return null;
  const fmt = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
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
        minWidth:     130,
      }}
    >
      <div style={{ color: palette.textDim, marginBottom: 6 }}>{row.category}</div>
      {(["max", "q3", "median", "q1", "min"] as const).map((k) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, lineHeight: 1.7 }}>
          <span style={{ color: palette.textDim }}>{k}</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(row[k])}</span>
        </div>
      ))}
    </div>
  );
}

export function BoxPlot({ data, yLabel, logScale = false, height = 300 }: Props): ReactElement {
  // Drive axis domain via scatter points at each category's median.
  // The custom shape then draws the full box using the y-scale directly.
  const scatterData: ScatterPoint[] = data.map((row, i) => ({
    index:    i,
    category: row.category,
    y:        row.median,
    row,
  }));

  const allValues = data.flatMap((r) => [r.min, r.max]);
  const yMin = Math.min(...allValues);
  const yMax = Math.max(...allValues);
  const yPad = (yMax - yMin) * 0.1;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart
        data={scatterData}
        margin={{ top: 16, right: 16, left: 0, bottom: 8 }}
      >
        <CartesianGrid strokeDasharray="2 4" stroke={palette.border} vertical={false} />
        <XAxis
          dataKey="category"
          type="category"
          stroke={palette.textMute}
          tick={{ fill: palette.textDim, fontSize: 10, fontFamily: "var(--font-mono)" }}
          tickLine={false}
          axisLine={{ stroke: palette.border }}
        />
        <YAxis
          type="number"
          dataKey="y"
          scale={logScale ? "log" : "linear"}
          domain={[Math.max(0, yMin - yPad), yMax + yPad]}
          stroke={palette.textMute}
          tick={{ fill: palette.textDim, fontSize: 10, fontFamily: "var(--font-mono)" }}
          tickLine={false}
          axisLine={false}
          width={46}
          label={
            yLabel
              ? { value: yLabel, angle: -90, position: "insideLeft", offset: 14, fill: palette.textDim, fontSize: 10 }
              : undefined
          }
        />
        <RTooltip
          cursor={{ strokeDasharray: "3 3", stroke: palette.borderHi }}
          content={<BoxTooltip />}
        />
        {/* One Scatter per category so each gets its own color index. */}
        {data.map((row, i) => (
          <Scatter
            key={row.category}
            name={row.category}
            data={[scatterData[i]]}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Recharts shape prop accepts any renderable
            shape={(props: any) => <CustomBox {...props} colorIndex={i} />}
            isAnimationActive={false}
            legendType="none"
          />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
