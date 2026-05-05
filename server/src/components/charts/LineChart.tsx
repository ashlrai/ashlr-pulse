/**
 * LineChart.tsx — single or multi-series line. Used for cost-over-time,
 * cache efficiency trend, etc.
 */

"use client";

import type { ReactElement } from "react";
import {
  ResponsiveContainer, LineChart as RLineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip as RTooltip, Legend,
} from "recharts";
import { palette, chartColor } from "@/lib/theme";
import { CyberTooltip } from "./Tooltip";
import { formatNumber, type FormatKey } from "@/lib/chart-formats";

export interface LinePoint {
  bucket: string;
  [series: string]: string | number;
}

interface Props {
  data: LinePoint[];
  series: { key: string; label?: string; color?: string }[];
  /** Format for Y-axis tick labels. Default: "abbrev". */
  yFormat?: FormatKey;
  /** Format for tooltip values. Default: "abbrev". */
  valueFormat?: FormatKey;
  height?: number;
}

export function LineChart({
  data, series, yFormat = "abbrev", valueFormat = "abbrev", height = 220,
}: Props): ReactElement {
  const yFmt = (v: number): string => formatNumber(yFormat, v);
  const vFmt = (v: number | string | undefined): string => formatNumber(valueFormat, v);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RLineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 4" stroke={palette.border} vertical={false} />
        <XAxis
          dataKey="bucket"
          stroke={palette.textMute}
          tick={{ fill: palette.textDim, fontSize: 10, fontFamily: "var(--font-mono)" }}
          tickLine={false}
          axisLine={{ stroke: palette.border }}
        />
        <YAxis
          stroke={palette.textMute}
          tick={{ fill: palette.textDim, fontSize: 10, fontFamily: "var(--font-mono)" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={yFmt}
          width={42}
        />
        <RTooltip
          cursor={{ stroke: palette.borderHi, strokeWidth: 1 }}
          content={<CyberTooltip fmt={(v) => vFmt(v)} />}
        />
        {series.length > 1 && (
          <Legend
            iconType="circle"
            wrapperStyle={{ fontSize: 11, color: palette.textDim, paddingTop: 8 }}
          />
        )}
        {series.map((s, i) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label ?? s.key}
            stroke={s.color ?? chartColor(i)}
            strokeWidth={1.8}
            dot={false}
            activeDot={{ r: 4, fill: s.color ?? chartColor(i), stroke: palette.bg, strokeWidth: 2 }}
            isAnimationActive
            animationDuration={500}
          />
        ))}
      </RLineChart>
    </ResponsiveContainer>
  );
}


