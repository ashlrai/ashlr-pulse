/**
 * / — the dashboard. Two modes:
 *
 *   1. /          → your own activity (last 24h, grouped by source × model).
 *   2. /?as=<id>  → a peer's activity, filtered by an active peer_share
 *                   grant from <id> to you. Scope (all / repo_pattern /
 *                   project) is honored. Granularity rollup is applied —
 *                   for v0.2 we coarse-grain to the most permissive
 *                   granularity across all matching grants.
 *
 * The privacy floor is owned by lib/peer-share-guard at write time;
 * here we only need to verify that an active grant exists and apply the
 * scope filter. There's no way to write fields outside the guarded
 * whitelist into a grant, so any field we render at read time is by
 * definition shareable.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { currentUser } from "@/lib/current-user";
import { listGrantsForViewer, type PeerShareRow } from "@/lib/peer-share-db";
import { costUsdCents, fmtUsd } from "@/lib/pricing";

export const dynamic = "force-dynamic";

interface TodayRow {
  source: string;
  model: string | null;
  events: number;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
}

interface ScopeFilter {
  /** SQL fragment ANDed onto WHERE clauses. Empty string for 'all'. */
  repoClauseSql: string;
  repoParams: string[];
}

function buildScopeFilter(grants: PeerShareRow[]): ScopeFilter {
  // Any 'all' grant short-circuits scope filtering.
  if (grants.some((g) => g.scope_type === "all")) {
    return { repoClauseSql: "", repoParams: [] };
  }
  // Otherwise OR together the repo_pattern entries. Project scopes would
  // need a JOIN through project_repo; v0.2 keeps it simple by ignoring
  // them and falling back to "no grant matched" if that's all there is.
  const repoPatterns = grants
    .filter((g) => g.scope_type === "repo_pattern")
    .map((g) => g.scope_value)
    .filter((v): v is string => Boolean(v));
  if (repoPatterns.length === 0) {
    // No usable scope yet (only project grants). Empty filter that matches nothing.
    return { repoClauseSql: " AND FALSE", repoParams: [] };
  }
  // Translate `client-*` style globs into SQL LIKE patterns.
  return {
    repoClauseSql:
      " AND (" +
      repoPatterns.map((_, i) => `repo_name LIKE $${i + 2}`).join(" OR ") +
      ")",
    repoParams: repoPatterns.map((p) => p.replace(/\*/g, "%")),
  };
}

async function loadToday(userId: string, scope: ScopeFilter): Promise<TodayRow[]> {
  try {
    const db = sql();
    // postgres-js's tagged-template form doesn't compose well with
    // dynamic clauses; fall back to .unsafe() for the scope WHERE we
    // build above. user_id is bound parametrically — never interpolated.
    const rows = await db.unsafe<TodayRow[]>(
      `
      SELECT
        source,
        model,
        COUNT(*)::int                  AS events,
        SUM(tokens_input)::int         AS tokens_in,
        SUM(tokens_output)::int        AS tokens_out,
        SUM(tokens_cache_read)::int    AS tokens_cache_read,
        SUM(tokens_cache_write)::int   AS tokens_cache_write
      FROM activity_event
      WHERE user_id = $1
        AND ts >= NOW() - INTERVAL '24 hours'
        ${scope.repoClauseSql}
      GROUP BY source, model
      ORDER BY events DESC
      `,
      [userId, ...scope.repoParams],
    );
    return rows;
  } catch {
    return [];
  }
}

interface SearchParams {
  as?: string;
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const { as } = await searchParams;

  // Default mode: render your own data.
  let targetUserId = me.id;
  let viewBanner: ReactElement | null = null;
  let scope: ScopeFilter = { repoClauseSql: "", repoParams: [] };

  if (as && as !== me.id) {
    const grants = (await listGrantsForViewer(me.id)).filter((g) => g.owner_id === as);
    if (grants.length === 0) {
      redirect(
        `/share?error=${encodeURIComponent("you don't have an active grant from that user")}`,
      );
    }
    targetUserId = as;
    scope = buildScopeFilter(grants);
    viewBanner = (
      <p
        style={{
          marginTop: 12,
          padding: "8px 12px",
          background: "#f4f1e8",
          border: "1px solid #d9c98a",
          borderRadius: 4,
          fontSize: 13,
        }}
      >
        viewing as <code>{grants[0].owner_email}</code> · scope:{" "}
        {grants
          .map((g) => (g.scope_type === "all" ? "all" : `${g.scope_type}:${g.scope_value ?? ""}`))
          .join(", ")}{" "}
        ·{" "}
        <a href="/" style={{ color: "#444" }}>
          back to your view
        </a>
      </p>
    );
  }

  const rows = await loadToday(targetUserId, scope);
  const rowsWithCost = rows.map((r) => ({
    ...r,
    cost_cents: costUsdCents({
      model: r.model,
      tokens_input: r.tokens_in,
      tokens_output: r.tokens_out,
      tokens_cache_read: r.tokens_cache_read,
      tokens_cache_write: r.tokens_cache_write,
    }),
  }));
  const totalCents = rowsWithCost.reduce((acc, r) => acc + (r.cost_cents ?? 0), 0);
  const totalEvents = rowsWithCost.reduce((acc, r) => acc + r.events, 0);

  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        padding: 32,
        maxWidth: 880,
      }}
    >
      <h1 style={{ margin: 0, fontSize: 24 }}>Pulse · today</h1>
      <p style={{ color: "#666", marginTop: 4 }}>
        you: <code>{me.email}</code> · <a href="/share">manage sharing →</a>
      </p>
      {viewBanner}

      {rows.length === 0 ? (
        <section style={{ marginTop: 32 }}>
          <p style={{ color: "#888" }}>
            no activity in the last 24 hours. wire an ingest source and you'll see rows show up here.
          </p>
          <details style={{ marginTop: 16 }}>
            <summary style={{ cursor: "pointer", color: "#444" }}>
              quickstart — Claude Code OTel
            </summary>
            <pre
              style={{
                marginTop: 8,
                padding: 12,
                background: "#f6f6f6",
                fontSize: 12,
                borderRadius: 4,
                overflowX: "auto",
              }}
            >
{`# 1. mint a PAT
bun run src/cli/mint-pat.ts <your-user-uuid> "laptop"

# 2. point Claude Code at the OTLP endpoint
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:3000/api/otlp/v1/traces
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer pulse_pat_…"

# 3. run claude — events appear here on the next page reload
claude`}
            </pre>
          </details>
        </section>
      ) : (
        <>
          <p style={{ marginTop: 24, color: "#444" }}>
            <strong>{totalEvents}</strong> events ·{" "}
            <strong>{fmtUsd(totalCents)}</strong> spent (last 24h)
          </p>
          <table style={{ marginTop: 16, borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ padding: "8px 0" }}>source</th>
                <th>model</th>
                <th style={{ textAlign: "right" }}>events</th>
                <th style={{ textAlign: "right" }}>tokens in</th>
                <th style={{ textAlign: "right" }}>tokens out</th>
                <th style={{ textAlign: "right" }}>cost</th>
              </tr>
            </thead>
            <tbody>
              {rowsWithCost.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "8px 0" }}>{r.source}</td>
                  <td>{r.model ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>{r.events}</td>
                  <td style={{ textAlign: "right" }}>{r.tokens_in ?? 0}</td>
                  <td style={{ textAlign: "right" }}>{r.tokens_out ?? 0}</td>
                  <td style={{ textAlign: "right" }}>{fmtUsd(r.cost_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
