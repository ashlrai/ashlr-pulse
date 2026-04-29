/**
 * DonutChart.tsx — model mix, source mix, anything categorical that
 * sums to 100%. Renders the % in the center of the donut.
 */

"use client";

import type { ReactElement } from "react";
import {
  ResponsiveContainer, PieChart, Pie, Cell,
  Tooltip as RTooltip,
} from "recharts";
import { palette, chartColor } from "@/lib/theme";
import { CyberTooltip } from "./Tooltip";

export interface DonutSlice {
  label: string;
  value: number;
  color?: string;
}

interface Props {
  data: DonutSlice[];
  /** Tooltip value formatter. */
  vFmt?: (v: number | string | undefined) => string;
  /** Center text override. Defaults to total + "total". */
  centerLabel?: string;
  centerValue?: string;
  /** Pixel height. */
  height?: number;
}

export function DonutChart({
  data, vFmt = (v) => String(v ?? 0), centerLabel = "total", centerValue, height = 240,
}: Props): ReactElement {
  const total = data.reduce((acc, d) => acc + d.value, 0);
  const center = centerValue ?? abbrev(total);

  return (
    <div style={{ position: "relative", width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <RTooltip
            cursor={false}
            content={<CyberTooltip fmt={(v) => vFmt(v)} />}
          />
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            innerRadius="62%"
            outerRadius="92%"
            strokeWidth={1}
            stroke={palette.bg}
            isAnimationActive
            animationDuration={500}
          >
            {data.map((d, i) => (
              <Cell key={i} fill={d.color ?? chartColor(i)} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div
        style={{
          position:    "absolute",
          inset:       0,
          display:     "flex",
          alignItems:  "center",
          justifyContent: "center",
          flexDirection: "column",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            fontSize: 24, fontWeight: 600, color: palette.text,
            fontVariantNumeric: "tabular-nums", letterSpacing: "-0.5px",
          }}
        >
          {center}
        </div>
        <div
          style={{
            fontSize: 10, color: palette.textDim, marginTop: 2,
            textTransform: "uppercase", letterSpacing: "0.8px",
          }}
        >
          {centerLabel}
        </div>
      </div>
    </div>
  );
}

function abbrev(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
