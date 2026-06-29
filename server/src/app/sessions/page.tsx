/**
 * /sessions — paginated list of top-50 Claude Code sessions by cost.
 *
 * Server component: resolves user, queries the top 50 sessions by
 * cost_millicents, and renders a table with filters for repo, model, and date.
 *
 * Privacy floor: only metadata (session id, latency, tokens, cost, tool
 * types, repo, model). No code, prompts, or LLM output text.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/current-user";
import { sql } from "@/lib/db";
import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { palette, space, font } from "@/lib/theme";
import { SessionList } from "@/components/sessions/SessionList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface SessionSummary {
  sessionId: string;
  startTs: string;
  endTs: string;
  repo: string | null;
  model: string | null;
  spanCount: number;
  totalLatencyMs: number;
  totalCostCents: number;
  totalTokens: number;
}

interface PageProps {
  searchParams: Promise<{
    repo?: string;
    model?: string;
    after?: string;
    before?: string;
  }>;
}

export default async function SessionsPage({ searchParams }: PageProps): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const sp = await searchParams;
  const repoFilter  = sp.repo   ?? null;
  const modelFilter = sp.model  ?? null;
  const afterFilter = sp.after  ?? null;
  const beforeFilter = sp.before ?? null;

  const db = sql();

  const rows = await db.unsafe<Array<{
    session_id: string;
    start_ts: string;
    end_ts: string;
    repo_name: string | null;
    model: string | null;
    span_count: number;
    total_latency_ms: number;
    total_cost_millicents: number;
    total_tokens: number;
  }>>(
    `
    SELECT
      session_id,
      MIN(ts)::text                       AS start_ts,
      MAX(ts)::text                       AS end_ts,
      -- most common repo_name (mode)
      MODE() WITHIN GROUP (ORDER BY repo_name) AS repo_name,
      MODE() WITHIN GROUP (ORDER BY model)     AS model,
      COUNT(*)::int                            AS span_count,
      COALESCE(SUM(duration_ms), 0)::bigint    AS total_latency_ms,
      COALESCE(SUM(cost_millicents), 0)::bigint AS total_cost_millicents,
      COALESCE(SUM(
        COALESCE(tokens_input, 0) +
        COALESCE(tokens_output, 0) +
        COALESCE(tokens_reasoning, 0)
      ), 0)::bigint AS total_tokens
    FROM activity_event
    WHERE user_id   = $1
      AND session_id IS NOT NULL
      AND source     IN ('claude_code', 'ashlr_plugin')
      AND ts >= NOW() - INTERVAL '30 days'
      AND ($2::text IS NULL OR repo_name = $2::text)
      AND ($3::text IS NULL OR model     = $3::text)
      AND ($4::timestamptz IS NULL OR ts >= $4::timestamptz)
      AND ($5::timestamptz IS NULL OR ts <= $5::timestamptz)
    GROUP BY session_id
    ORDER BY total_cost_millicents DESC
    LIMIT 50
    `,
    [me.id, repoFilter, modelFilter, afterFilter, beforeFilter],
  ).catch(() => []);

  const sessions: SessionSummary[] = rows.map((r) => ({
    sessionId: r.session_id,
    startTs: r.start_ts,
    endTs: r.end_ts,
    repo: r.repo_name,
    model: r.model,
    spanCount: r.span_count,
    totalLatencyMs: Number(r.total_latency_ms),
    totalCostCents: Number(r.total_cost_millicents) / 1000,
    totalTokens: Number(r.total_tokens),
  }));

  return (
    <DashboardShell>
      <Header me={me} active="sessions" />
      <div style={{ padding: `${space.x5}px ${space.x6}px` }}>
        <div style={{ marginBottom: space.x5 }}>
          <h1
            style={{
              fontSize: 20,
              fontWeight: 600,
              color: palette.text,
              margin: 0,
              fontFamily: font.mono,
            }}
          >
            Session Replay
          </h1>
          <p style={{ fontSize: 12, color: palette.textDim, marginTop: space.x1 }}>
            Top 50 Claude Code sessions by cost — last 30 days.
            Click a session to view its flamegraph.
          </p>
        </div>
        <Card>
          <CardHeader
            title="Sessions"
            hint={`${sessions.length} sessions`}
          />
          <SessionList sessions={sessions} />
        </Card>
      </div>
    </DashboardShell>
  );
}
