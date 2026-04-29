/**
 * Skeleton.tsx — pulsing placeholder shape. Used for loading states on
 * server components rendered inside <Suspense>.
 */

import type { ReactElement } from "react";
import { palette, radius } from "@/lib/theme";

interface Props {
  width?:  number | string;
  height?: number | string;
  rounded?: number;
}

export function Skeleton({ width = "100%", height = 16, rounded = radius.sm }: Props): ReactElement {
  return (
    <div
      style={{
        width,
        height,
        background: `linear-gradient(90deg, ${palette.bgRaised} 0%, ${palette.borderHi} 50%, ${palette.bgRaised} 100%)`,
        backgroundSize: "200% 100%",
        animation:      "pulse-skeleton 1.6s ease-in-out infinite",
        borderRadius:   rounded,
      }}
    />
  );
}
