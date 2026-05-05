/**
 * Format + style helpers shared by the dashboard sub-components in
 * this directory. Extracted from app/page.tsx to keep the page-level
 * server component focused on data loading + composition.
 *
 * No behavior change vs the previous in-file copies; this file is
 * import-only and has no side effects.
 */

import type * as React from "react";
import { palette } from "@/lib/theme";

export function abbrev(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function fmtAgoShort(d: Date): string {
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function kindColor(kind: string): string {
  if (kind === "saas")       return palette.green;
  if (kind === "client")     return palette.magenta;
  if (kind === "internal")   return palette.cyan;
  if (kind === "experiment") return palette.amber;
  return palette.textDim;
}

export function kindChip(kind: string): React.CSSProperties {
  const c = kindColor(kind);
  return {
    color: c,
    background: `${c}10`,
    border: `1px solid ${c}30`,
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 10,
    letterSpacing: "0.5px",
    textTransform: "uppercase",
  };
}

export const th: React.CSSProperties = {
  padding: "8px 6px",
  color: palette.textDim,
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: "0.5px",
  textTransform: "uppercase",
};

export const td: React.CSSProperties = { padding: "8px 6px", color: palette.text };
