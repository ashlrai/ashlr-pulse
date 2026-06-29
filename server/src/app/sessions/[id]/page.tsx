/**
 * /sessions/[id] — session detail page with flamegraph + cost breakdown.
 *
 * Server component: loads raw span data, applies session-cluster, then
 * hands the SessionCluster to client components for flamegraph rendering.
 *
 * Privacy floor: only metadata (tool names, latencies, tokens, cost).
 * No code, prompts, or LLM output text ever appear here.
 */

import type { ReactElement } from "react";
import { redirect, notFound } from "next/navigation";
import { currentUser } from "@/lib/current-user";
import { sql } from "@/lib/db";
import { clusterSpansBySession, type SpanRow } from "@/lib/session-cluster";
import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { SessionFlamegraph } from "@/components/sessions/SessionFlamegraph";
import { SessionCostCard } from "@/components/sessions/SessionCostCard";
import { palette, space, font } from "@/lib/theme";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function SessionDetailPage({ params }: PageProps): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const { id: sessionId } = await params;
  const db = sql();

  const rows = await db.unsafe<Array<{
    session_id: string | null;
    ts: string;
    duration_ms: number | null;
    tool_calls_types: string[] | null;
    tokens_input: number | null;
    tokens_output: number | null;
    tokens_reasoning: number | null;
    cost_millicents: number | null;
    repo_name: string | null;
    source: string;
    model: string | null;
  }>>(
    `
    SELECT
      session_id,
      ts::text              AS ts,
      duration_ms,
      tool_calls_types,
      tokens_input,
      tokens_output,
      tokens_reasoning,
      cost_millicents::float8 AS cost_millicents,
      repo_name,
      source,
      model
    FROM activity_event
    WHERE user_id    = $1
      AND session_id = $2
      AND ts >= NOW() - INTERVAL '90 days'
    ORDER BY ts ASC
    LIMIT 500
    `,
    [me.id, sessionId],
  ).catch(() => []);

  if (rows.length === 0) notFound();

  const spans: SpanRow[] = rows.map((r) => ({
    session_id: r.session_id,
    ts: r.ts,
    duration_ms: r.duration_ms,
    tool_calls_types: r.tool_calls_types,
    tokens_input: r.tokens_input,
    tokens_output: r.tokens_output,
    tokens_reasoning: r.tokens_reasoning,
    cost_millicents: r.cost_millicents,
    repo_name: r.repo_name,
    source: r.source,
    model: r.model,
  }));

  const clusters = clusterSpansBySession(spans);
  const cluster = clusters.find((c) => c.sessionId === sessionId) ?? clusters[0];
  if (!cluster) notFound();

  const durationSec = Math.round(cluster.totalLatency / 1000);
  const costFmt = cluster.totalCost.toFixed(4);
  const startLabel = new Date(cluster.startTs).toLocaleString();

  return (
    <DashboardShell>
      <Header me={me} active="sessions" />
      <div style={{ padding: `${space.x5}px ${space.x6}px` }}>
        {/* Page header */}
        <div style={{ marginBottom: space.x5 }}>
          <a
            href="/sessions"
            style={{
              fontSize: 11,
              color: palette.textDim,
              textDecoration: "none",
              fontFamily: font.mono,
            }}
          >
            ← Sessions
          </a>
          <h1
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: palette.text,
              margin: `${space.x1}px 0 0`,
              fontFamily: font.mono,
              wordBreak: "break-all",
            }}
          >
            Session {sessionId.slice(0, 16)}{sessionId.length > 16 ? "…" : ""}
          </h1>
          <p style={{ fontSize: 12, color: palette.textDim, marginTop: space.x1 }}>
            {startLabel}
            {cluster.repo ? ` · ${cluster.repo}` : ""}
            {cluster.model ? ` · ${cluster.model}` : ""}
            {" · "}{cluster.spanCount} spans
            {" · "}{durationSec}s
            {" · "}${costFmt}
          </p>
        </div>

        {/* Cost breakdown card */}
        <div style={{ marginBottom: space.x4 }}>
          <SessionCostCard cluster={cluster} />
        </div>

        {/* Flamegraph */}
        <Card>
          <CardHeader
            title="Tool-Call Flamegraph"
            hint="latency per tool call, sorted by duration"
          />
          <SessionFlamegraph cluster={cluster} />
        </Card>
      </div>
    </DashboardShell>
  );
}
