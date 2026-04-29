/**
 * Heatmap.tsx — hour-of-day × day-of-week grid showing activity intensity.
 *
 * Pure SVG, no chart library. 7 rows (Sun-Sat) × 24 cols (00:00-23:00).
 * Each cell's opacity scales with the value relative to the max, with a
 * green tint. Reveals working patterns at a glance.
 */

import type { ReactElement } from "react";
import { palette } from "@/lib/theme";

export interface HeatmapCell {
  /** 0 (Sun) - 6 (Sat). */
  dow: number;
  /** 0 - 23 hour. */
  hour: number;
  value: number;
}

interface Props {
  cells: HeatmapCell[];
  /** Override the default cyber-green tint. */
  color?: string;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Heatmap({ cells, color = palette.green }: Props): ReactElement {
  // Build a sparse [dow][hour] map for O(1) lookup.
  const grid: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let max = 0;
  for (const c of cells) {
    if (c.dow < 0 || c.dow > 6 || c.hour < 0 || c.hour > 23) continue;
    grid[c.dow][c.hour] = c.value;
    if (c.value > max) max = c.value;
  }
  if (max === 0) max = 1;

  const cellW = 18, cellH = 18, gap = 2;
  const labelW = 32;
  const w = labelW + 24 * (cellW + gap);
  const h = 18 + 7 * (cellH + gap);

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      height={h}
      preserveAspectRatio="xMinYMin meet"
      style={{ display: "block", overflow: "visible" }}
    >
      {/* Hour ticks across the top — every 6 hours. */}
      {[0, 6, 12, 18].map((hr) => (
        <text
          key={hr}
          x={labelW + hr * (cellW + gap)}
          y={11}
          fontSize="9"
          fill={palette.textDim}
          fontFamily="var(--font-mono), monospace"
        >
          {hr.toString().padStart(2, "0")}:00
        </text>
      ))}
      {/* Day labels on the left. */}
      {DAYS.map((d, i) => (
        <text
          key={d}
          x={0}
          y={18 + i * (cellH + gap) + 13}
          fontSize="9"
          fill={palette.textDim}
          fontFamily="var(--font-mono), monospace"
        >
          {d}
        </text>
      ))}
      {/* Cells. */}
      {grid.map((row, dow) =>
        row.map((v, hr) => {
          const opacity = v === 0 ? 0.04 : 0.18 + 0.82 * (v / max);
          return (
            <rect
              key={`${dow}-${hr}`}
              x={labelW + hr * (cellW + gap)}
              y={18 + dow * (cellH + gap)}
              width={cellW}
              height={cellH}
              rx={2}
              fill={color}
              fillOpacity={opacity}
            />
          );
        }),
      )}
    </svg>
  );
}
