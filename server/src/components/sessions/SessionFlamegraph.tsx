/**
 * SessionFlamegraph.tsx — client component: renders an interactive
 * horizontal bar chart (flamegraph) of tool-call latency for one session.
 *
 * Uses Recharts BarChart (horizontal layout). Bars are sorted by latency
 * descending so the slowest calls are at the top. Hover tooltip shows
 * latency, tokens in/out, and cost. Phase groupings are indicated via
 * a color accent on the bar.
 *
 * Privacy floor: only tool names, latencies, tokens, cost — never code.
 */

"use client";

import type { ReactElement } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Cell,
  Tooltip as RTooltip,
  ReferenceLine,
} from "recharts";
import type { SessionCluster, ToolCallEntry } from "@/lib/session-cluster";
import { palette, font } from "@/lib/theme";

interface Props {
  cluster: SessionCluster;
}

// Assign a color per tool type so the chart reads like a legend.
const TOOL_COLORS: Record<string, string> = {
  read:    palette.cyan,
  edit:    palette.green,
  bash:    palette.amber,
  grep:    palette.purple,
  glob:    palette.magenta,
  ls:      palette.textDim,
  unknown: palette.textMute,
};

function toolColor(tool: string): string {
  return TOOL_COLORS[tool] ?? palette.purple;
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

interface TooltipPayload {
  payload?: ToolCallEntry & { index: number };
  active?: boolean;
}

function FlamegraphTooltip({ active, payload }: TooltipPayload): ReactElement | null {
  const data = Array.isArray(payload) ? (payload[0]?.payload as ToolCallEntry | undefined) : undefined;
  if (!active || !data) return null;
  return (
    <div
      style={{
        background: "#0e0e10",
        border: `1px solid ${palette.border}`,
        borderRadius: 6,
        padding: "8px 12px",
        fontSize: 11,
        fontFamily: font.mono,
        color: palette.text,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4, color: toolColor(data.tool) }}>
        {data.tool}
      </div>
      <div style={{ color: palette.textDim }}>latency: {fmtMs(data.latencyMs)}</div>
      <div style={{ color: palette.textDim }}>tokens in: {data.tokensIn.toLocaleString()}</div>
      <div style={{ color: palette.textDim }}>tokens out: {data.tokensOut.toLocaleString()}</div>
      <div style={{ color: palette.amber }}>cost: ${(data.cost / 100).toFixed(6)}</div>
    </div>
  );
}

export function SessionFlamegraph({ cluster }: Props): ReactElement {
  // Sort by latency descending so slowest calls appear at the top.
  const sorted = [...cluster.toolChain].sort((a, b) => b.latencyMs - a.latencyMs);

  if (sorted.length === 0) {
    return (
      <p style={{ fontSize: 12, color: palette.textMute, padding: "16px 0" }}>
        No tool calls recorded for this session.
      </p>
    );
  }

  const chartData = sorted.map((entry, i) => ({
    ...entry,
    // Recharts needs a unique label per bar; combine tool + index.
    name: `${entry.tool} #${i + 1}`,
    // Use latencyMs as the bar value.
    value: entry.latencyMs,
  }));

  const rowHeight = 28;
  const height = Math.max(160, sorted.length * rowHeight + 40);

  // Average latency reference line.
  const avgMs = cluster.totalLatency / (sorted.length || 1);

  return (
    <div>
      {/* Legend */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 12,
          fontSize: 11,
          fontFamily: font.mono,
        }}
      >
        {Object.entries(TOOL_COLORS).map(([tool, color]) => {
          const present = cluster.toolChain.some((c) => c.tool === tool);
          if (!present) return null;
          return (
            <span key={tool} style={{ display: "flex", alignItems: "center", gap: 4, color: palette.textDim }}>
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: color,
                }}
              />
              {tool}
            </span>
          );
        })}
      </div>

      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 4, right: 80, left: 8, bottom: 4 }}
        >
          <XAxis
            type="number"
            tick={{ fill: palette.textMute, fontSize: 10, fontFamily: font.mono }}
            tickFormatter={(v: number) => fmtMs(v)}
            stroke={palette.border}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={90}
            tick={{ fill: palette.textDim, fontSize: 10, fontFamily: font.mono }}
            tickLine={false}
            axisLine={false}
          />
          <RTooltip
            cursor={{ fill: "rgba(255,255,255,0.03)" }}
            content={<FlamegraphTooltip />}
          />
          <ReferenceLine
            x={avgMs}
            stroke={palette.textMute}
            strokeDasharray="3 3"
            label={{
              value: `avg ${fmtMs(avgMs)}`,
              position: "insideTopRight",
              fill: palette.textMute,
              fontSize: 10,
              fontFamily: font.mono,
            }}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive animationDuration={400}>
            {chartData.map((entry, i) => (
              <Cell key={i} fill={toolColor(entry.tool)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* Phase summary */}
      {cluster.phases.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              fontSize: 11,
              color: palette.textMute,
              marginBottom: 8,
              textTransform: "uppercase",
              letterSpacing: "0.8px",
              fontFamily: font.mono,
            }}
          >
            Detected Phases
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {cluster.phases.map((phase, i) => (
              <div
                key={i}
                style={{
                  background: "#121214",
                  border: `1px solid ${palette.border}`,
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 11,
                  fontFamily: font.mono,
                }}
              >
                <span style={{ color: palette.green, fontWeight: 600 }}>{phase.name}</span>
                <span style={{ color: palette.textDim, marginLeft: 8 }}>
                  {fmtMs(phase.totalLatencyMs)}
                </span>
                <span style={{ color: palette.textMute, marginLeft: 8 }}>
                  {phase.calls.map((c) => c.tool).join(" → ")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
