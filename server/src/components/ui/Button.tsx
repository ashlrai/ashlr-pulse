/**
 * Button.tsx — cyber-aesthetic button.
 *
 * Variants:
 *   primary   — magenta CTA (sign-in style accent). Use for the one main action per surface.
 *   secondary — green / outline. For "do this thing" without the dramatic hierarchy.
 *   ghost     — borderless text button. For navigation, "cancel", inline links.
 *   danger    — red destructive action.
 *
 * No client state — works in forms (Server Actions) without "use client".
 */

import type { ButtonHTMLAttributes, ReactElement } from "react";
import { palette, radius, space } from "@/lib/theme";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size    = "sm" | "md";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?:    Size;
}

export function Button({ variant = "secondary", size = "md", style, ...rest }: Props): ReactElement {
  const padX = size === "sm" ? space.x3 : space.x4;
  const padY = size === "sm" ? 6 : 9;

  const base: React.CSSProperties = {
    display:        "inline-flex",
    alignItems:     "center",
    gap:            8,
    padding:        `${padY}px ${padX}px`,
    fontSize:       size === "sm" ? 12 : 13,
    fontFamily:     "inherit",
    fontWeight:     500,
    letterSpacing:  "0.2px",
    border:         "1px solid transparent",
    borderRadius:   radius.md,
    cursor:         "pointer",
    transition:     "background 0.12s ease, border-color 0.12s ease, color 0.12s ease, box-shadow 0.12s ease",
    textDecoration: "none",
    whiteSpace:     "nowrap",
  };

  const variants: Record<Variant, React.CSSProperties> = {
    primary: {
      background:    palette.magenta,
      color:         "#0a0a0a",
      borderColor:   palette.magenta,
      boxShadow:     "0 0 0 0 rgba(255,96,214,0)",
    },
    secondary: {
      background:    "transparent",
      color:         palette.green,
      borderColor:   "rgba(124,255,160,0.4)",
    },
    ghost: {
      background:    "transparent",
      color:         palette.textDim,
      borderColor:   "transparent",
    },
    danger: {
      background:    "transparent",
      color:         palette.red,
      borderColor:   "rgba(255,107,107,0.4)",
    },
  };

  return (
    <button
      {...rest}
      style={{ ...base, ...variants[variant], ...style }}
    />
  );
}
