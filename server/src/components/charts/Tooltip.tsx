/**
 * Tooltip.tsx — shared dark monospace tooltip for Recharts charts.
 *
 * Recharts passes a `payload` array of { name, value, color } when the
 * default tooltip is replaced. We render it ourselves to keep the
 * monospace + cyber palette consistent across every chart.
 */

"use client";

import type { ReactElement } from "react";
import { palette } from "@/lib/theme";

interface PayloadItem {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string;
}

interface Props {
  active?: boolean;
  payload?: PayloadItem[];
  label?: string | number;
  /** Optional formatter for values (e.g. "$1.23" or "12,456"). */
  fmt?: (v: number | string | undefined, key?: string) => string;
}

export function CyberTooltip({ active, payload, label, fmt }: Props): ReactElement | null {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background:    "rgba(8,8,10,0.95)",
        border:        `1px solid ${palette.borderHi}`,
        borderRadius:  6,
        padding:       "8px 10px",
        fontSize:      11,
        fontFamily:    "var(--font-mono), monospace",
        color:         palette.text,
        boxShadow:     "0 12px 32px rgba(0,0,0,0.5)",
        minWidth:      140,
      }}
    >
      {label != null && (
        <div style={{ color: palette.textDim, marginBottom: 6, letterSpacing: "0.3px" }}>
          {label}
        </div>
      )}
      {payload.map((p, i) => (
        <div
          key={`${p.dataKey ?? p.name}-${i}`}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            justifyContent: "space-between",
            lineHeight: 1.6,
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 8, height: 8, borderRadius: 2,
                background: p.color ?? palette.green,
                boxShadow:  `0 0 6px ${p.color ?? palette.green}`,
              }}
            />
            <span style={{ color: palette.textDim }}>{p.name}</span>
          </span>
          <span style={{ color: palette.text, fontVariantNumeric: "tabular-nums" }}>
            {fmt ? fmt(p.value, p.dataKey) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}
