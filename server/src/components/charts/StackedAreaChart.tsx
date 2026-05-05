/**
 * StackedAreaChart.tsx — tokens / cost / events over time, stacked by source.
 *
 * Single most important chart on /app. Answers "what does the last 14
 * days look like, broken out by AI tool?" at a glance.
 */

"use client";

import type { ReactElement } from "react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip as RTooltip, Legend,
} from "recharts";
import { palette, sourceColor } from "@/lib/theme";
import { CyberTooltip } from "./Tooltip";
import { formatNumber, type FormatKey } from "@/lib/chart-formats";

export interface StackedAreaPoint {
  /** X-axis label, e.g. "Apr 22". */
  bucket: string;
  /** Each source key (claude_code, cursor, …) is a numeric value. */
  [series: string]: string | number;
}

interface Props {
  data: StackedAreaPoint[];
  /** Ordered list of series keys to stack (by source name). */
  series: string[];
  /** Format key for Y-axis ticks. Default: "abbrev". */
  yFormat?: FormatKey;
  /** Format key for tooltip values. Default: "abbrev". */
  valueFormat?: FormatKey;
  /** Pixel height of the chart area. */
  height?: number;
}

export function StackedAreaChart({
  data, series, yFormat = "abbrev", valueFormat = "abbrev", height = 260,
}: Props): ReactElement {
  const yFmt = (v: number): string => formatNumber(yFormat, v);
  const vFmt = (v: number | string | undefined): string => formatNumber(valueFormat, v);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          {series.map((s) => {
            const c = sourceColor[s] ?? palette.green;
            return (
              <linearGradient key={s} id={`area-${s}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor={c} stopOpacity={0.42} />
                <stop offset="100%" stopColor={c} stopOpacity={0.04} />
              </linearGradient>
            );
          })}
        </defs>
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
        <Legend
          iconType="circle"
          wrapperStyle={{ fontSize: 11, color: palette.textDim, paddingTop: 8 }}
        />
        {series.map((s) => {
          const c = sourceColor[s] ?? palette.green;
          return (
            <Area
              key={s}
              type="monotone"
              dataKey={s}
              name={s}
              stackId="1"
              stroke={c}
              strokeWidth={1.5}
              fill={`url(#area-${s})`}
              isAnimationActive
              animationDuration={500}
            />
          );
        })}
      </AreaChart>
    </ResponsiveContainer>
  );
}


