/**
 * / — the dashboard. Two modes:
 *
 *   1. /          → your own activity (last 24h, grouped by source × model).
 *   2. /?as=<id>  → a peer's activity, filtered by an active peer_share
 *                   grant from <id> to you. Scope (all / repo_pattern /
 *                   project) is honored.
 *
 * Task 4 — Granularity rollup:
 *   When ?as= is set, pick the most permissive granularity across all
 *   matching grants (realtime > daily > weekly > monthly).
 *   - realtime  → last 24h, grouped by source × model
 *   - daily     → last 7 days, grouped by date × source × model
 *   - weekly    → last 90 days, grouped by week × source × model
 *   - monthly   → last 1 year, grouped by month × source × model
 *
 * Task 5 — Field whitelist enforcement:
 *   When ?as= is set, the union of fields[] from all matching grants
 *   controls which columns render. Columns not in the union render "—".
 *   The events column is always shown (it's a count, not a field).
 *   Column → field mapping:
 *     source       → "source"
 *     model        → "model"
 *     tokens in    → "tokens_input"
 *     tokens out   → "tokens_output"
 *     cost         → (derived from tokens — shown if either token field shown)
 *
 * The privacy floor is owned by lib/peer-share-guard at write time.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { currentUser } from "@/lib/current-user";
import { listGrantsForViewer, type PeerShareRow } from "@/lib/peer-share-db";
import { costUsdCents, fmtUsd } from "@/lib/pricing";
import { getAgentStatus, bucketFor, fmtAgo, type AgentStatus, type HealthBucket } from "@/lib/heartbeat";
import { loadMissedRepos } from "@/lib/missed-repos";
import { Header } from "@/components/Header";
import { StatCard } from "@/components/StatCard";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Granularity = "realtime" | "daily" | "weekly" | "monthly";

interface TodayRow {
  // Always present (it's a COUNT, not a stored field).
  events: number;
  // Present for realtime; coarser granularities get a bucket label instead.
  source: string | null;
  model: string | null;
  bucket: string | null; // date/week/month label for non-realtime
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
}

interface ScopeFilter {
  repoClauseSql: string;
  repoParams: string[];
}

// ---------------------------------------------------------------------------
// Granularity helpers (Task 4)
// ---------------------------------------------------------------------------

const GRAN_ORDER: Granularity[] = ["monthly", "weekly", "daily", "realtime"];

function mostPermissive(grants: PeerShareRow[]): Granularity {
  let best: Granularity = "monthly";
  for (const g of grants) {
    if (GRAN_ORDER.indexOf(g.granularity) > GRAN_ORDER.indexOf(best)) {
      best = g.granularity;
    }
  }
  return best;
}

function windowForGranularity(gran: Granularity): string {
  switch (gran) {
    case "realtime": return "24 hours";
    case "daily":    return "7 days";
    case "weekly":   return "90 days";
    case "monthly":  return "1 year";
  }
}

function bucketExpr(gran: Granularity): string {
  switch (gran) {
    case "realtime": return "NULL::text";
    case "daily":    return "date_trunc('day', ts)::text";
    case "weekly":   return "date_trunc('week', ts)::text";
    case "monthly":  return "date_trunc('month', ts)::text";
  }
}

function groupByForGranularity(gran: Granularity): string {
  if (gran === "realtime") return "source, model";
  return "bucket, source, model";
}

// ---------------------------------------------------------------------------
// Field whitelist helpers (Task 5)
// ---------------------------------------------------------------------------

// Map display column names to the activity_event field names in grants.
const COLUMN_FIELDS: Record<string, string> = {
  source:     "source",
  model:      "model",
  tokens_in:  "tokens_input",
  tokens_out: "tokens_output",
};

function buildAllowedColumns(grants: PeerShareRow[]): Set<string> | null {
  // null = show everything (own view, no grant filtering).
  const union = new Set<string>();
  for (const g of grants) {
    for (const f of g.fields) union.add(f);
  }
  return union;
}

function colAllowed(col: string, allowed: Set<string> | null): boolean {
  if (allowed === null) return true;
  const field = COLUMN_FIELDS[col];
  if (!field) return true; // unknown → show (safe: only applies to events count)
  return allowed.has(field);
}

// ---------------------------------------------------------------------------
// Scope filter
// ---------------------------------------------------------------------------

function buildScopeFilter(grants: PeerShareRow[]): ScopeFilter {
  if (grants.some((g) => g.scope_type === "all")) {
    return { repoClauseSql: "", repoParams: [] };
  }
  const repoPatterns = grants
    .filter((g) => g.scope_type === "repo_pattern")
    .map((g) => g.scope_value)
    .filter((v): v is string => Boolean(v));
  if (repoPatterns.length === 0) {
    return { repoClauseSql: " AND FALSE", repoParams: [] };
  }
  return {
    repoClauseSql:
      " AND (" +
      repoPatterns.map((_, i) => `repo_name LIKE $${i + 2}`).join(" OR ") +
      ")",
    repoParams: repoPatterns.map((p) => p.replace(/\*/g, "%")),
  };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

// Allow-list of strings we permit to be interpolated into raw SQL via
// db.unsafe below. windowForGranularity only emits these four strings,
// but we revalidate at the call site so a future Granularity union
// addition can't quietly let an unknown literal through. ProjectSection
// uses the tagged-template `${str}::interval` form instead — that's the
// preferred pattern for new code; loadRows still needs db.unsafe because
// it dynamically constructs SELECT-list expressions and GROUP BY columns
// that postgres-js can't parameterize.
const ALLOWED_WINDOWS = new Set<string>(["24 hours", "7 days", "90 days", "1 year"]);

async function loadRows(
  userId: string,
  scope: ScopeFilter,
  gran: Granularity,
): Promise<TodayRow[]> {
  try {
    const db = sql();
    const window = windowForGranularity(gran);
    if (!ALLOWED_WINDOWS.has(window)) {
      throw new Error(`unexpected interval window: ${window}`);
    }
    const bucket = bucketExpr(gran);
    const groupBy = groupByForGranularity(gran);
    const rows = await db.unsafe<TodayRow[]>(
      `
      SELECT
        ${bucket}                          AS bucket,
        source,
        model,
        COUNT(*)::int                      AS events,
        SUM(tokens_input)::int             AS tokens_in,
        SUM(tokens_output)::int            AS tokens_out,
        SUM(tokens_cache_read)::int        AS tokens_cache_read,
        SUM(tokens_cache_write)::int       AS tokens_cache_write
      FROM activity_event
      WHERE user_id = $1
        AND ts >= NOW() - INTERVAL '${window}'
        ${scope.repoClauseSql}
      GROUP BY ${groupBy}
      ORDER BY ${gran === "realtime" ? "events" : "bucket"} DESC
      `,
      [userId, ...scope.repoParams],
    );
    return rows;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

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

  let targetUserId = me.id;
  let viewBanner: ReactElement | null = null;
  let scope: ScopeFilter = { repoClauseSql: "", repoParams: [] };
  let gran: Granularity = "realtime";
  let allowedFields: Set<string> | null = null; // null = own view (unrestricted)

  if (as && as !== me.id) {
    const grants = (await listGrantsForViewer(me.id)).filter((g) => g.owner_id === as);
    if (grants.length === 0) {
      redirect(
        `/share?error=${encodeURIComponent("you don't have an active grant from that user")}`,
      );
    }
    targetUserId = as;
    scope = buildScopeFilter(grants);
    gran = mostPermissive(grants);
    allowedFields = buildAllowedColumns(grants);

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
        · granularity: {gran} ·{" "}
        <a href="/app" style={{ color: "#444" }}>
          back to your view
        </a>
      </p>
    );
  }

  // Load agent liveness + missed repos in parallel with the main query.
  // Both are skipped on ?as= peer views — a peer's agent uptime + their
  // own missed-repos warning aren't yours to look at.
  const isOwnView = targetUserId === me.id;
  const nowUtc = new Date();
  const since24hUtc = new Date(nowUtc.getTime() - 24 * 3600_000).toISOString();
  const [rows, agentStatus, missedRepos] = await Promise.all([
    loadRows(targetUserId, scope, gran),
    isOwnView ? getAgentStatus(me.id, nowUtc) : Promise.resolve(null),
    isOwnView ? loadMissedRepos(me.id, since24hUtc, nowUtc.toISOString()) : Promise.resolve([]),
  ]);
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

  // Determine which columns to show/hide (Task 5).
  const showSource    = colAllowed("source",     allowedFields);
  const showModel     = colAllowed("model",       allowedFields);
  const showTokensIn  = colAllowed("tokens_in",   allowedFields);
  const showTokensOut = colAllowed("tokens_out",  allowedFields);
  // Cost is derived — show only if at least one token column is visible.
  const showCost = showTokensIn || showTokensOut;

  const windowLabel = windowForGranularity(gran);

  return (
    <main style={{ padding: "0 32px 32px", maxWidth: 1100, margin: "0 auto" }}>
      <Header me={me} active="dashboard" />
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-0.5px" }}>today</h1>
        {agentStatus && <AgentStatusBadge status={agentStatus} />}
      </div>
      <p style={{ color: "#666", marginTop: 4, fontSize: 13 }}>
        the last {windowLabel} of activity across your tracked repos and AI tools.
      </p>
      {viewBanner}
      {isOwnView && missedRepos.length > 0 && <MissedReposPanel repos={missedRepos} />}

      {rows.length === 0 ? (
        <section style={{ marginTop: 32 }}>
          <p style={{ color: "#888" }}>
            no activity in the last {windowLabel}. wire an ingest source and you'll see rows show up here.
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
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:3001/api/otlp/v1/traces
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
            {showCost && <><strong>{fmtUsd(totalCents)}</strong> spent · </>}
            last {windowLabel}
          </p>
          <table style={{ marginTop: 16, borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                {gran !== "realtime" && <th style={{ padding: "8px 0" }}>period</th>}
                {showSource    && <th style={{ padding: "8px 0" }}>source</th>}
                {showModel     && <th>model</th>}
                <th style={{ textAlign: "right" }}>events</th>
                {showTokensIn  && <th style={{ textAlign: "right" }}>tokens in</th>}
                {showTokensOut && <th style={{ textAlign: "right" }}>tokens out</th>}
                {showCost      && <th style={{ textAlign: "right" }}>cost</th>}
              </tr>
            </thead>
            <tbody>
              {rowsWithCost.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #eee" }}>
                  {gran !== "realtime" && <td style={{ padding: "8px 0", fontSize: 12, color: "#666" }}>{r.bucket ?? "—"}</td>}
                  {showSource    && <td style={{ padding: "8px 0" }}>{r.source ?? "—"}</td>}
                  {showModel     && <td>{r.model ?? "—"}</td>}
                  <td style={{ textAlign: "right" }}>{r.events}</td>
                  {showTokensIn  && <td style={{ textAlign: "right" }}>{r.tokens_in ?? 0}</td>}
                  {showTokensOut && <td style={{ textAlign: "right" }}>{r.tokens_out ?? 0}</td>}
                  {showCost      && <td style={{ textAlign: "right" }}>{fmtUsd(r.cost_cents)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <ProjectSection userId={me.id} windowLabel={windowLabel} />
      <GitHubSection userId={me.id} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Agent status badge + missed-repos warning
// ---------------------------------------------------------------------------

const BUCKET_STYLE: Record<HealthBucket, { fg: string; bg: string; dot: string; label: string }> = {
  alive:  { fg: "#1a7f3a", bg: "#e7f6ec", dot: "#22c55e", label: "alive" },
  stale:  { fg: "#8a4b00", bg: "#fff4e0", dot: "#f5b06b", label: "stale" },
  silent: { fg: "#a02622", bg: "#fdecea", dot: "#dc2626", label: "SILENT" },
};

function AgentStatusBadge({ status }: { status: AgentStatus }): ReactElement {
  const bucket = bucketFor(status.seconds_ago);
  const style = BUCKET_STYLE[bucket];
  const ago = fmtAgo(status.seconds_ago);
  const agentCount = status.agents.length;
  const tooltip = status.agents.length === 0
    ? "no agent has ever pinged this account — install pulse-agent and run `pulse-agent init`"
    : status.agents.map((a) => `${a.label ?? "agent"}: ${fmtAgo(a.seconds_ago)} ago`).join(" · ");

  return (
    <div
      title={tooltip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px",
        background: style.bg,
        color: style.fg,
        borderRadius: 999,
        fontSize: 12,
        fontFamily: "ui-monospace, Menlo, monospace",
        cursor: "help",
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 4, background: style.dot }} />
      <span><strong>{style.label}</strong> · {ago}{agentCount > 1 ? ` (${agentCount} agents)` : ""}</span>
    </div>
  );
}

function MissedReposPanel({ repos }: { repos: string[] }): ReactElement {
  return (
    <div
      role="alert"
      style={{
        marginTop: 16,
        background: "#fff4e0",
        color: "#8a4b00",
        border: "1px solid #f5c178",
        borderRadius: 6,
        padding: "12px 14px",
        fontSize: 13,
      }}
    >
      <strong>⚠ Agent missed {repos.length} {repos.length === 1 ? "repo" : "repos"}</strong> with GitHub commits in the last 24h but zero AI-tool activity. Usually means pulse-agent isn&apos;t running on these:
      <div style={{ marginTop: 6, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}>
        {repos.slice(0, 8).join(" · ")}{repos.length > 8 ? ` · +${repos.length - 8} more` : ""}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Project rollup panel — group activity by project the user owns.
// Silent when the user has no projects defined.
// ---------------------------------------------------------------------------

interface ProjectRollupRow {
  project_id: string;
  project_name: string;
  project_kind: string;
  repos_count: number;
  events: number;
  tokens: number;
  cost_cents: number;
}

async function ProjectSection({
  userId,
  windowLabel,
}: {
  userId: string;
  windowLabel: string;
}): Promise<ReactElement | null> {
  const db = sql();
  // Defense in depth — even though postgres-js's tagged template
  // parameterizes ${intervalSql} below, we verify the string is one of
  // the values windowForGranularity is documented to emit before going
  // anywhere near the DB. Catches a future Granularity-union expansion.
  if (!ALLOWED_WINDOWS.has(windowLabel)) return null;
  const intervalSql = windowLabel;
  // First check if the user has any projects at all — short-circuit if not.
  const [{ project_count }] = await db<{ project_count: number }[]>`
    SELECT COUNT(*)::int AS project_count
    FROM project p
    JOIN membership m ON m.org_id = p.org_id AND m.user_id = ${userId}
  `;
  if (project_count === 0) return null;

  const rollups = await db<ProjectRollupRow[]>`
    SELECT
      p.id::text                    AS project_id,
      p.name                        AS project_name,
      p.kind                        AS project_kind,
      COUNT(DISTINCT pr.repo_name)::int      AS repos_count,
      COUNT(*)::int                 AS events,
      COALESCE(SUM(COALESCE(ae.tokens_input, 0) + COALESCE(ae.tokens_output, 0))::int, 0) AS tokens,
      0                             AS cost_cents
    FROM project p
    JOIN membership m  ON m.org_id = p.org_id AND m.user_id = ${userId}
    JOIN project_repo pr ON pr.project_id = p.id
    JOIN activity_event ae ON ae.repo_name = pr.repo_name AND ae.user_id = ${userId}
    WHERE ae.ts > NOW() - ${intervalSql}::interval
    GROUP BY p.id, p.name, p.kind
    ORDER BY tokens DESC
  `;

  if (rollups.length === 0) return null;

  // Cost is computed per-row in JS via pricing.ts but we don't have model here.
  // For the dashboard we render tokens-only at the project level — the existing
  // by-source × model table beneath gives the per-model cost breakdown.
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>by project</h2>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={{ padding: "8px 0" }}>project</th>
            <th style={{ padding: "8px 0", color: "#888", fontWeight: 400 }}>kind</th>
            <th style={{ textAlign: "right" }}>repos</th>
            <th style={{ textAlign: "right" }}>events</th>
            <th style={{ textAlign: "right" }}>tokens</th>
          </tr>
        </thead>
        <tbody>
          {rollups.map((r) => (
            <tr key={r.project_id} style={{ borderBottom: "1px solid #eee" }}>
              <td style={{ padding: "8px 0" }}>
                <a href={`/projects#${r.project_id}`} style={{ color: "#111", textDecoration: "none", fontWeight: 500 }}>
                  {r.project_name}
                </a>
              </td>
              <td style={{ color: "#888", fontSize: 12 }}>{r.project_kind}</td>
              <td style={{ textAlign: "right" }}>{r.repos_count}</td>
              <td style={{ textAlign: "right" }}>{r.events}</td>
              <td style={{ textAlign: "right" }}>{r.tokens.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---------------------------------------------------------------------------
// GitHub events panel — pulled from github_event for the current user.
// Renders quietly to nothing when the user hasn't connected GitHub yet.
// ---------------------------------------------------------------------------

interface GitHubSummaryRow {
  kind: string;
  events: number;
}
interface GitHubRecentRow {
  ts: string;
  kind: string;
  actor_login: string;
  full_name: string;
  pr_number: number | null;
  message_first_line: string | null;
}

async function GitHubSection({ userId }: { userId: string }): Promise<ReactElement | null> {
  try {
    const db = sql();
    const [account] = await db<{ id: string; github_login: string; last_synced_at: string | null }[]>`
      SELECT id::text AS id, github_login, last_synced_at::text AS last_synced_at
      FROM github_account WHERE user_id = ${userId} LIMIT 1
    `;
    if (!account) return null;

    const summary = await db<GitHubSummaryRow[]>`
      SELECT kind, COUNT(*)::int AS events
      FROM github_event
      WHERE account_id = ${account.id} AND ts >= NOW() - INTERVAL '7 days'
      GROUP BY kind ORDER BY events DESC
    `;
    const recent = await db<GitHubRecentRow[]>`
      SELECT ge.ts::text AS ts, ge.kind, ge.actor_login,
             gr.full_name, ge.pr_number, ge.message_first_line
      FROM github_event ge
      JOIN github_repo gr ON gr.id = ge.repo_id
      WHERE ge.account_id = ${account.id}
      ORDER BY ge.ts DESC
      LIMIT 12
    `;

    const total = summary.reduce((a, r) => a + r.events, 0);
    return (
      <section style={{ marginTop: 48, paddingTop: 24, borderTop: "1px solid #eee" }}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>
          github · @{account.github_login}
          <span style={{ color: "#666", fontWeight: 400, marginLeft: 8 }}>
            {total} events (last 7d)
            {account.last_synced_at && ` · synced ${new Date(account.last_synced_at).toISOString().slice(0, 16).replace("T", " ")}`}
          </span>
        </h2>
        {total === 0 ? (
          <p style={{ color: "#888" }}>
            no events yet — <a href="/github">enable repos and run a sync</a>.
          </p>
        ) : (
          <>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
              {summary.map((s) => (
                <div key={s.kind} style={{ fontSize: 13, color: "#444" }}>
                  <strong>{s.events}</strong> {s.kind.replace(/_/g, " ")}
                </div>
              ))}
            </div>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                  <th style={{ padding: "8px 0", fontSize: 13 }}>when</th>
                  <th style={{ fontSize: 13 }}>repo</th>
                  <th style={{ fontSize: 13 }}>kind</th>
                  <th style={{ fontSize: 13 }}>who</th>
                  <th style={{ fontSize: 13 }}>what</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #f0f0f0" }}>
                    <td style={{ padding: "6px 0", fontSize: 12, color: "#666" }}>
                      {new Date(r.ts).toISOString().slice(5, 16).replace("T", " ")}
                    </td>
                    <td style={{ fontSize: 12 }}>{r.full_name}</td>
                    <td style={{ fontSize: 12 }}>{r.kind.replace(/_/g, " ")}</td>
                    <td style={{ fontSize: 12 }}>@{r.actor_login}</td>
                    <td style={{ fontSize: 12, color: "#444" }}>
                      {r.pr_number ? `#${r.pr_number} · ` : ""}
                      {r.message_first_line ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    );
  } catch {
    // github_event table may not exist yet (pre-0004 deploy). Silent.
    return null;
  }
}
