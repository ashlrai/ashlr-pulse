/**
 * GET /api/sessions/[id] — fetch raw span data for one session, apply
 * session-cluster, and return the SessionCluster JSON.
 *
 * Privacy floor: returns only metadata (tool names, latencies, tokens, cost).
 * No code, prompts, or LLM output text ever appear in this response.
 *
 * The [id] segment is a claude.session.id / ashlr.plugin.session_id value.
 * URL-encode it — these are opaque strings and may contain slashes.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { sql } from "@/lib/db";
import { clusterSpansBySession, type SpanRow } from "@/lib/session-cluster";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: sessionId } = await ctx.params;
  if (!sessionId) return NextResponse.json({ error: "session id required" }, { status: 400 });

  const db = sql();

  // Fetch spans for this session. We look back up to 90 days so a
  // very old session is still findable by its id. user_id ensures
  // session isolation between accounts.
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
      ts::text            AS ts,
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
    WHERE user_id   = $1
      AND session_id = $2
      AND ts >= NOW() - INTERVAL '90 days'
    ORDER BY ts ASC
    LIMIT 500
    `,
    [me.id, sessionId],
  ).catch(() => []);

  if (rows.length === 0) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

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
  // There should be exactly one cluster for this session id.
  const cluster = clusters.find((c) => c.sessionId === sessionId) ?? clusters[0] ?? null;

  return NextResponse.json(cluster);
}
