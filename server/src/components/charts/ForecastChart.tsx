/**
 * ForecastChart.tsx — historical line + projected line + 90% confidence band.
 *
 * Forecast data is accepted as a prop (Agent C owns lib/forecast.ts).
 * The confidence band is rendered as a Recharts Area between `lower` and
 * `upper` using a custom gradient — ReferenceArea would require fixed pixel
 * coords and doesn't work on dynamic data ranges, so Area is the right
 * primitive here.
 */

"use client";

import type { ReactElement } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
  ReferenceLine,
} from "recharts";
import { palette, chartColor } from "@/lib/theme";
import { CyberTooltip } from "./Tooltip";

interface HistoryPoint {
  ts:    string;
  value: number;
}

interface ForecastPoint {
  ts:    string;
  value: number;
  lower: number;
  upper: number;
}

interface Props {
  history:  HistoryPoint[];
  forecast: ForecastPoint[];
  yLabel:   string;
  height?:  number;
}

interface ChartRow {
  ts:           string;
  actual?:      number;
  projected?:   number;
  lower?:       number;
  upper?:       number;
  isForecast?:  boolean;
}

export function ForecastChart({ history, forecast, yLabel, height = 280 }: Props): ReactElement {
  // Merge history + forecast into a single array. The boundary point is
  // duplicated so the projected line visually connects to the last actual point.
  const lastHistory = history[history.length - 1];
  const rows: ChartRow[] = [
    ...history.map((p) => ({ ts: p.ts, actual: p.value })),
    ...(lastHistory
      ? [
          {
            ts:        lastHistory.ts,
            projected: lastHistory.value,
            lower:     lastHistory.value,
            upper:     lastHistory.value,
            isForecast: true,
          },
        ]
      : []),
    ...forecast.map((p) => ({
      ts:         p.ts,
      projected:  p.value,
      lower:      p.lower,
      upper:      p.upper,
      isForecast: true,
    })),
  ];

  const historyColor  = chartColor(0); // green
  const forecastColor = chartColor(2); // cyan

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="forecast-band" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={forecastColor} stopOpacity={0.22} />
            <stop offset="100%" stopColor={forecastColor} stopOpacity={0.04} />
          </linearGradient>
        </defs>

        <CartesianGrid strokeDasharray="2 4" stroke={palette.border} vertical={false} />
        <XAxis
          dataKey="ts"
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
          width={46}
          label={{
            value:    yLabel,
            angle:    -90,
            position: "insideLeft",
            offset:   14,
            fill:     palette.textDim,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
          }}
        />
        <RTooltip
          cursor={{ stroke: palette.borderHi, strokeWidth: 1 }}
          content={<CyberTooltip />}
        />
        <Legend
          iconType="circle"
          wrapperStyle={{ fontSize: 11, color: palette.textDim, paddingTop: 8 }}
        />

        {/* 90% confidence band — rendered as a range area between lower and upper. */}
        <Area
          type="monotone"
          dataKey="upper"
          stroke="none"
          fill="url(#forecast-band)"
          legendType="none"
          name="upper (90%)"
          connectNulls
          isAnimationActive
          animationDuration={500}
          dot={false}
          activeDot={false}
        />
        <Area
          type="monotone"
          dataKey="lower"
          stroke="none"
          fill={palette.bg}
          legendType="none"
          name="lower (90%)"
          connectNulls
          isAnimationActive={false}
          dot={false}
          activeDot={false}
        />

        {/* Historical actual line */}
        <Line
          type="monotone"
          dataKey="actual"
          name="actual"
          stroke={historyColor}
          strokeWidth={1.8}
          dot={false}
          activeDot={{ r: 4, fill: historyColor, stroke: palette.bg, strokeWidth: 2 }}
          connectNulls
          isAnimationActive
          animationDuration={500}
        />

        {/* Projected line — dashed to distinguish from actuals */}
        <Line
          type="monotone"
          dataKey="projected"
          name="forecast"
          stroke={forecastColor}
          strokeWidth={1.8}
          strokeDasharray="5 3"
          dot={false}
          activeDot={{ r: 4, fill: forecastColor, stroke: palette.bg, strokeWidth: 2 }}
          connectNulls
          isAnimationActive
          animationDuration={500}
        />

        {/* Vertical line marking the forecast boundary */}
        {lastHistory && (
          <ReferenceLine
            x={lastHistory.ts}
            stroke={palette.borderHi}
            strokeDasharray="2 2"
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
