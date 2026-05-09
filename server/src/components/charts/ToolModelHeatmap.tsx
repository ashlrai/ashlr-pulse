/**
 * ToolModelHeatmap.tsx — 2D heatmap of tool × model usage intensity.
 *
 * Pure SVG, server-renderable. Reuses the same color-stop pattern as
 * Heatmap.tsx: opacity scales linearly from 0.04 (zero) to 1.0 (max).
 * Cells are labeled with the numeric value when the cell is wide enough.
 */

import type { ReactElement } from "react";
import { palette } from "@/lib/theme";

interface Props {
  rows:        string[];
  cols:        string[];
  /** cells[i][j] = value at row i, col j */
  cells:       number[][];
  valueLabel?: string;
  height?:     number;
}

export function ToolModelHeatmap({ rows, cols, cells, valueLabel, height }: Props): ReactElement {
  // Find global max for normalization.
  let max = 0;
  for (const row of cells) {
    for (const v of row) {
      if (v > max) max = v;
    }
  }
  if (max === 0) max = 1;

  const cellW     = 52;
  const cellH     = 22;
  const gap       = 2;
  const labelW    = 110; // row label column
  const headerH   = 32;  // col headers

  const svgW = labelW + cols.length * (cellW + gap);
  const svgH = headerH + rows.length * (cellH + gap) + (valueLabel ? 18 : 0);
  const color = palette.cyan; // tool×model uses cyan to distinguish from activity heatmap

  function abbrev(v: number): string {
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}k`;
    return `${v}`;
  }

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        width={svgW}
        height={height ?? svgH}
        preserveAspectRatio="xMinYMin meet"
        style={{ display: "block" }}
      >
        {/* Column headers */}
        {cols.map((col, j) => (
          <text
            key={col}
            x={labelW + j * (cellW + gap) + cellW / 2}
            y={headerH - 6}
            fontSize={9}
            fill={palette.textDim}
            fontFamily="var(--font-mono), monospace"
            textAnchor="middle"
          >
            {col.length > 10 ? col.slice(0, 9) + "…" : col}
          </text>
        ))}

        {/* Value label */}
        {valueLabel && (
          <text
            x={svgW / 2}
            y={svgH - 2}
            fontSize={9}
            fill={palette.textMute}
            fontFamily="var(--font-mono), monospace"
            textAnchor="middle"
          >
            {valueLabel}
          </text>
        )}

        {/* Rows */}
        {rows.map((row, i) => (
          <g key={row}>
            {/* Row label */}
            <text
              x={labelW - 6}
              y={headerH + i * (cellH + gap) + cellH / 2 + 4}
              fontSize={9}
              fill={palette.textDim}
              fontFamily="var(--font-mono), monospace"
              textAnchor="end"
            >
              {row.length > 14 ? row.slice(0, 13) + "…" : row}
            </text>

            {/* Cells */}
            {cols.map((col, j) => {
              const v = cells[i]?.[j] ?? 0;
              const opacity = v === 0 ? 0.04 : 0.15 + 0.85 * (v / max);
              const textOpacity = opacity > 0.4 ? 0.9 : 0;
              return (
                <g key={col}>
                  <rect
                    x={labelW + j * (cellW + gap)}
                    y={headerH + i * (cellH + gap)}
                    width={cellW}
                    height={cellH}
                    rx={2}
                    fill={color}
                    fillOpacity={opacity}
                  />
                  {v > 0 && (
                    <text
                      x={labelW + j * (cellW + gap) + cellW / 2}
                      y={headerH + i * (cellH + gap) + cellH / 2 + 4}
                      fontSize={8}
                      fill={palette.text}
                      fillOpacity={textOpacity}
                      fontFamily="var(--font-mono), monospace"
                      textAnchor="middle"
                    >
                      {abbrev(v)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        ))}
      </svg>
    </div>
  );
}
