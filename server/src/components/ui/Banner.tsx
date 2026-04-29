/**
 * Banner.tsx — inline notice for warnings, errors, or info on the dashboard.
 *
 * Variants:
 *   info    — neutral, monospace, gray-tinted
 *   success — green-tinted
 *   warning — amber-tinted
 *   danger  — red-tinted
 */

import type { ReactElement, ReactNode } from "react";
import { palette, radius, space } from "@/lib/theme";

type Variant = "info" | "success" | "warning" | "danger";

const TINT: Record<Variant, { bg: string; border: string; color: string }> = {
  info:    { bg: "rgba(124,208,255,0.06)",  border: "rgba(124,208,255,0.30)", color: palette.cyan },
  success: { bg: "rgba(124,255,160,0.06)",  border: "rgba(124,255,160,0.30)", color: palette.green },
  warning: { bg: "rgba(255,224,122,0.06)",  border: "rgba(255,224,122,0.30)", color: palette.amber },
  danger:  { bg: "rgba(255,107,107,0.06)",  border: "rgba(255,107,107,0.30)", color: palette.red },
};

interface Props {
  variant?: Variant;
  children: ReactNode;
  /** Optional one-line title above body. */
  title?: string;
}

export function Banner({ variant = "info", children, title }: Props): ReactElement {
  const t = TINT[variant];
  return (
    <div
      style={{
        background:   t.bg,
        border:       `1px solid ${t.border}`,
        borderRadius: radius.md,
        padding:      `${space.x2}px ${space.x4}px`,
        color:        palette.text,
        fontSize:     12,
        lineHeight:   1.6,
      }}
    >
      {title && (
        <div
          style={{
            color:         t.color,
            fontSize:      11,
            textTransform: "uppercase",
            letterSpacing: "0.8px",
            fontWeight:    500,
            marginBottom:  4,
          }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  );
}
