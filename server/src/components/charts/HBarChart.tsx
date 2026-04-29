/**
 * HBarChart.tsx — horizontal bar chart for top-N (repos, tools, models).
 *
 * Right-aligned numeric labels keep the visual rhythm tight. Bars use
 * a soft gradient so they look like a designed chart, not a spreadsheet.
 */

"use client";

import type { ReactElement } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  Tooltip as RTooltip, Cell,
} from "recharts";
import { palette, chartColor } from "@/lib/theme";
import { CyberTooltip } from "./Tooltip";

export interface HBarPoint {
  label: string;
  value: number;
  /** Optional fixed color override. */
  color?: string;
}

interface Props {
  data: HBarPoint[];
  /** Tooltip value formatter. */
  vFmt?: (v: number | string | undefined) => string;
  /** Pixel height per row. Total chart height = data.length × rowHeight. */
  rowHeight?: number;
  /** Use a single color for every bar instead of the chart palette. */
  uniformColor?: string;
}

export function HBarChart({
  data, vFmt = (v) => String(v ?? 0), rowHeight = 26, uniformColor,
}: Props): ReactElement {
  const height = Math.max(120, data.length * rowHeight + 24);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          stroke={palette.textMute}
          tick={{ fill: palette.textDim, fontSize: 11, fontFamily: "var(--font-mono)" }}
          width={120}
          tickLine={false}
          axisLine={false}
        />
        <RTooltip
          cursor={{ fill: "rgba(255,255,255,0.03)" }}
          content={<CyberTooltip fmt={(v) => vFmt(v)} />}
        />
        <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive animationDuration={500}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.color ?? uniformColor ?? chartColor(i)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
