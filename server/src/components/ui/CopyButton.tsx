"use client";

/**
 * CopyButton.tsx — copy a string to the clipboard, with brief "copied!" feedback.
 *
 * Client component (uses navigator.clipboard + local state). Falls back
 * to document.execCommand("copy") via a hidden textarea when the modern
 * API isn't available (HTTP origin, older Safari, etc.) so the button
 * still works in dev over plain http://localhost.
 */

import { useState } from "react";
import { palette, radius, space } from "@/lib/theme";

interface Props {
  /** The text to copy. */
  value: string;
  /** Optional label override; defaults to "copy". */
  label?: string;
  /** Optional inline style overrides. */
  style?: React.CSSProperties;
}

export function CopyButton({ value, label = "copy", style }: Props) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");

  const onClick = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setState("ok");
      setTimeout(() => setState("idle"), 1400);
    } catch {
      setState("fail");
      setTimeout(() => setState("idle"), 1400);
    }
  };

  const color = state === "ok" ? palette.green : state === "fail" ? palette.red : palette.cyan;

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: `4px ${space.x2}px`,
        fontSize: 11,
        fontFamily: "inherit",
        background: "transparent",
        color,
        border: `1px solid ${color}`,
        borderRadius: radius.sm,
        cursor: "pointer",
        transition: "color 0.12s ease, border-color 0.12s ease",
        ...style,
      }}
    >
      {state === "ok" ? "copied!" : state === "fail" ? "copy failed" : label}
    </button>
  );
}
