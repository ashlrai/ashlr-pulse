/**
 * ChartFrame.tsx — common shell for every chart on the dashboard.
 *
 * Wraps a chart in a Card with a title, optional hint, and a legend
 * area. Standardizes the visual rhythm so every chart on /app feels
 * like part of the same product.
 */

import type { ReactElement, ReactNode } from "react";
import { Card, CardHeader } from "@/components/ui/Card";

interface Props {
  title: string;
  hint?: string;
  /** Right-aligned label or filter (legend, "last 14d", etc.). */
  right?: ReactNode;
  /** Min height for the chart container — keeps cards consistent. */
  minHeight?: number;
  /** Accent color for the top border. */
  accent?: string;
  children: ReactNode;
}

export function ChartFrame({
  title, hint, right, minHeight = 220, accent, children,
}: Props): ReactElement {
  return (
    <Card accent={accent}>
      <CardHeader title={title} hint={hint} right={right} />
      <div style={{ width: "100%", minHeight }}>{children}</div>
    </Card>
  );
}
