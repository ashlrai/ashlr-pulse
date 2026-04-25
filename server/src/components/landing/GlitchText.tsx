"use client";

/**
 * GlitchText.tsx — header text with an occasional CSS glitch shimmer.
 *
 * Pure CSS via two pseudo-style overlays (one cyan, one magenta) that
 * jitter on a slow loop. No JS animation, no layout thrash; it's a
 * vibe, not a performance concern.
 */

import { motion } from "framer-motion";
import type { CSSProperties, ReactNode } from "react";

export function GlitchText({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <motion.span
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      style={{
        position: "relative",
        display: "inline-block",
        ...style,
      }}
    >
      {/* Two ghost layers that drift slightly to create RGB-split. */}
      <span aria-hidden style={ghost("rgba(124,255,160,0.45)", "translate(-1px, 0)")}>{children}</span>
      <span aria-hidden style={ghost("rgba(255,96,214,0.45)", "translate(1px, 0)")}>{children}</span>
      <span style={{ position: "relative" }}>{children}</span>
    </motion.span>
  );
}

function ghost(color: string, transform: string): CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    color,
    transform,
    pointerEvents: "none",
    mixBlendMode: "screen",
  };
}
