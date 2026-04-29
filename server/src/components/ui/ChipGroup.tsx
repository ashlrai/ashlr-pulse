/**
 * ChipGroup.tsx — segmented control rendered as a row of links.
 *
 * Server-friendly (no client state). Each chip is a link to the same
 * page with a different `?key=value` — the dashboard uses this for
 * window selection and view toggles.
 */

import type { ReactElement } from "react";
import { palette, radius, space } from "@/lib/theme";

interface Option {
  /** Human-readable label, e.g. "24h" or "by project". */
  label: string;
  /** Query value, e.g. "24h" or "project". */
  value: string;
}

interface Props {
  /** Currently-selected value. */
  current: string;
  options: Option[];
  /** Build the href for a given value. */
  hrefFor: (v: string) => string;
}

export function ChipGroup({ current, options, hrefFor }: Props): ReactElement {
  return (
    <div
      style={{
        display:    "inline-flex",
        gap:        2,
        padding:    2,
        background: palette.bgSurface,
        border:     `1px solid ${palette.border}`,
        borderRadius: radius.md,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === current;
        return (
          <a
            key={opt.value}
            href={hrefFor(opt.value)}
            style={{
              padding:        `4px ${space.x2}px`,
              fontSize:       11,
              borderRadius:   radius.sm,
              background:     active ? palette.bgRaised : "transparent",
              color:          active ? palette.text : palette.textDim,
              fontWeight:     active ? 500 : 400,
              letterSpacing:  "0.3px",
              textDecoration: "none",
              transition:     "color 0.12s ease, background 0.12s ease",
              border:         active ? `1px solid ${palette.borderHi}` : "1px solid transparent",
            }}
          >
            {opt.label}
          </a>
        );
      })}
    </div>
  );
}
