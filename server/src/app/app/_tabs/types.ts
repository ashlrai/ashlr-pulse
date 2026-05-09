/**
 * Shared prop types for tab components.
 *
 * The shell (page.tsx) loads all data once and passes the full payload
 * down to each tab. Tabs are server components — they receive data as
 * plain serialisable props, not contexts.
 */

import type { DashboardData } from "@/lib/dashboard-data";
import type { Recommendation } from "@/lib/cost-insights";
import type { ForecastPoint } from "@/lib/forecast";
import type { BillingMode } from "@/lib/plan-gate";
import type { LinePoint } from "@/components/charts/LineChart";

export interface PluginImpact {
  tokensSaved: number;
  breakdown: { genome: number; snipcompact: number; route: number };
  features: string[];
  estUsdSavedCents: number;
  daysCovered: number;
}

export interface TabProps {
  data: DashboardData;
  /** Resolved time-window, e.g. { value: "14", days: 14 } */
  windowOpt: { value: string; days: number };
  /** URL query params preserved across tab switches */
  queryParams: { as?: string; win?: string; src?: string; tab?: string };
  /** Billing mode — controls label copy ("cost" vs "rate-card") */
  billingMode: BillingMode;
  isSubMode: boolean;
  monthlyCapUsd: number | null;
  /** Pre-computed cache hit ratio (0–1) */
  cacheHit: number;
  totalReads: number;
  totalWrites: number;
  /** Cost forecast projection (30 future points, millicents) */
  projection: ForecastPoint[];
  /** Pre-built trajectory+forecast points for the LineChart */
  trajectoryPoints: LinePoint[];
  /** LLM-generated recommendations (Pro/Team only, may be empty) */
  insights: Recommendation[];
  /** Plugin token-savings data (own view only, may be null) */
  pluginImpact: PluginImpact | null;
  /** Anomaly messages (null = no anomaly detected) */
  eventAnomaly: { message: string } | null;
  tokenAnomaly: { message: string } | null;
  costAnomaly:  { message: string } | null;
  /** Peer-share: viewing someone else's activity */
  isOwnView: boolean;
}
