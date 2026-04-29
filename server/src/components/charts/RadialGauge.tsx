/**
 * RadialGauge.tsx — single-metric ring (e.g. cache efficiency 78%, agent
 * uptime 99.4%). Pure SVG, no client JS. The value displays in the center
 * with an optional sublabel.
 */

import type { ReactElement } from "react";
import { palette } from "@/lib/theme";

interface Props {
  /** 0 - 1 (clamped). */
  value: number;
  label: string;
  /** Optional formatted center text override. Default: round to %. */
  centerText?: string;
  color?: string;
  size?: number;
}

export function RadialGauge({
  value, label, centerText, color = palette.green, size = 140,
}: Props): ReactElement {
  const v = Math.max(0, Math.min(1, value));
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * v;
  const center = centerText ?? `${Math.round(v * 100)}%`;

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={palette.border}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{
            filter: `drop-shadow(0 0 6px ${color})`,
            transition: "stroke-dasharray 0.8s ease",
          }}
        />
      </svg>
      <div
        style={{
          position:       "absolute",
          inset:          0,
          display:        "flex",
          alignItems:     "center",
          justifyContent: "center",
          flexDirection:  "column",
          pointerEvents:  "none",
        }}
      >
        <div
          style={{
            fontSize: 22, fontWeight: 600, color: palette.text,
            fontVariantNumeric: "tabular-nums", letterSpacing: "-0.5px",
          }}
        >
          {center}
        </div>
        <div
          style={{
            fontSize: 10, color: palette.textDim,
            textTransform: "uppercase", letterSpacing: "0.8px", marginTop: 2,
            textAlign: "center", maxWidth: size - 20,
          }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}
