/**
 * Today tab — stat cards, AI briefing, plugin impact, anomalies,
 * insights, cost-breakdown, project rollups, recent commits + feed.
 *
 * Receives pre-loaded data from the shell (page.tsx) — no DB calls here.
 */

import type { ReactElement } from "react";
import { Suspense } from "react";

import { fmtUsd } from "@/lib/pricing";
import { getOrComputeBriefing, type BriefingInputs } from "@/lib/briefing";
import { palette, space } from "@/lib/theme";

import { StatCard } from "@/components/StatCard";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { Skeleton } from "@/components/ui/Skeleton";

import { ProjectRollupTable } from "../_components/ProjectRollupTable";
import { RepoAgentRollupTable } from "../_components/RepoAgentRollupTable";
import { ActivityFeed } from "../_components/ActivityFeed";
import {
  abbrev,
  fmtAgoShort,
  th,
  td,
} from "../_components/dashboard-format";

import type { TabProps } from "./types";

// ─── Re-exported helper types (used by shell) ────────────────────────

export type { PluginImpact } from "./types";

// ─── Main tab component ──────────────────────────────────────────────

export async function TodayTab({
  data,
  windowOpt,
  billingMode,
  isSubMode,
  monthlyCapUsd,
  cacheHit,
  insights,
  pluginImpact,
  eventAnomaly,
  tokenAnomaly,
  costAnomaly,
  isOwnView,
  // briefing inputs are reconstructed in the shell and passed as-is
  briefingInputs,
  userId,
  aiEnabled,
  eventsDelta,
  tokensDelta,
  costDelta,
  baselineEvents,
  baselineTokens,
  baselineCost,
  teamSyncLabel,
}: TabProps & {
  briefingInputs: BriefingInputs;
  userId: string;
  aiEnabled: boolean;
  eventsDelta: number | null;
  tokensDelta: number | null;
  costDelta: number | null;
  baselineEvents: number;
  baselineTokens: number;
  baselineCost: number;
  /** Team Sync stat: shown when org has >1 member. */
  teamSyncLabel?: string | null;
}): Promise<ReactElement> {
  return (
    <>
      {/* Stat strip */}
      <div className="dash-stat-strip">
        <StatCard
          accent="green"
          label="events · 24h"
          value={data.today.events.toLocaleString()}
          delta={eventsDelta}
          hint={baselineEvents ? `vs ${baselineEvents.toLocaleString()} median` : undefined}
          sparkline={data.sparklines.events}
        />
        <StatCard
          accent="cyan"
          label="tokens · 24h"
          value={abbrev(data.today.tokens)}
          delta={tokensDelta}
          hint={tokenStatHint(data.today, baselineTokens)}
          sparkline={data.sparklines.tokens}
        />
        <StatCard
          accent="magenta"
          label={isSubMode ? "rate-card · 24h" : "cost · 24h"}
          value={fmtUsd(data.today.costCents)}
          delta={costDelta}
          hint={
            isSubMode
              ? `subscription mode — what API users would pay${baselineCost ? ` · vs ${fmtUsd(baselineCost)} median` : ""}`
              : baselineCost
                ? `vs ${fmtUsd(baselineCost)} median`
                : undefined
          }
          sparkline={data.sparklines.cost}
        />
        <StatCard
          accent="amber"
          label={`commits · ${windowOpt.days}d`}
          value={data.commitTotals.commits.toString()}
          hint={commitStatHint(data.commitTotals)}
          sparkline={data.sparklines.commits}
        />
        {teamSyncLabel != null && (
          <a href="/settings/team-sync" style={{ textDecoration: "none" }}>
            <StatCard
              accent="purple"
              label="team sync"
              value={teamSyncLabel}
              hint="click to set preferred pairing hours"
            />
          </a>
        )}
      </div>

      {/* AI briefing */}
      <div style={{ marginTop: space.x5 }}>
        <Suspense fallback={<BriefingSkeleton />}>
          <BriefingPanel userId={userId} inputs={briefingInputs} aiEnabled={aiEnabled} />
        </Suspense>
      </div>

      {/* Subscription-mode explanation banner */}
      {isSubMode && (
        <div style={{ marginTop: space.x4 }}>
          <Banner variant="info">
            <strong>Subscription mode ({billingMode}).</strong>{" "}
            The cost numbers below are <em>API rate-card</em> — what an API
            user would pay at Anthropic&apos;s published rates. Your real
            bill is the flat plan price{monthlyCapUsd ? ` (~$${monthlyCapUsd}/mo cap` : ""}{monthlyCapUsd ? ")" : ""}.
            Change in <a href="/settings" style={{ color: palette.cyan }}>settings</a>.
          </Banner>
        </div>
      )}

      {/* Cost breakdown 24h */}
      {data.costBreakdown24h.total > 0 && (
        <div style={{ marginTop: space.x5 }}>
          <Card>
            <CardHeader
              title={isSubMode ? "rate-card breakdown · 24h" : "cost breakdown · 24h"}
              hint={
                isSubMode
                  ? "what an API user would pay — your subscription bills these as flat plan price"
                  : "auditable decomposition by Anthropic rate component — sums to the cost shown above"
              }
            />
            <CostBreakdownPanel breakdown={data.costBreakdown24h} />
          </Card>
        </div>
      )}

      {/* Cost optimizer insights */}
      {insights.length > 0 && (
        <div style={{ marginTop: space.x5 }}>
          <Card>
            <CardHeader
              title="suggestions"
              hint="automatic cost optimization, generated from your usage"
            />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: space.x3, marginTop: space.x3 }}>
              {insights.map((r, i) => (
                <InsightCard key={i} rec={r} />
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Plugin impact card */}
      {pluginImpact && pluginImpact.tokensSaved > 0 && (
        <div style={{ marginTop: space.x5 }}>
          <PluginImpactCard impact={pluginImpact} />
        </div>
      )}

      {/* Anomaly badges */}
      {(eventAnomaly || tokenAnomaly || costAnomaly) && (
        <div style={{ marginTop: space.x4, display: "flex", gap: space.x3, flexWrap: "wrap" }}>
          {eventAnomaly && <AnomalyChip color={palette.green}   msg={eventAnomaly.message} />}
          {tokenAnomaly && <AnomalyChip color={palette.cyan}    msg={tokenAnomaly.message} />}
          {costAnomaly  && <AnomalyChip color={palette.magenta} msg={costAnomaly.message} />}
        </div>
      )}

      {/* Repo x agent scoreboard */}
      {data.repoAgentRollup.length > 0 && (
        <div style={{ marginTop: space.x6 }}>
          <Card accent={palette.purple}>
            <CardHeader
              title={`repo x agent scoreboard · last ${data.chartDays}d`}
              hint="hybrid active time, Claude Code/Codex event mix, tokens, commits, and PR throughput"
              right={isOwnView ? <a href="/share" style={{ color: palette.cyan, textDecoration: "none" }}>invite teammate →</a> : undefined}
            />
            <RepoAgentRollupTable rows={data.repoAgentRollup} />
          </Card>
        </div>
      )}

      {data.repoFocus.length > 0 && (
        <div style={{ marginTop: space.x6 }}>
          <Card accent={palette.green}>
            <CardHeader
              title={`repo focus · last ${data.chartDays}d`}
              hint="active time beside merged commit and PR output"
            />
            <RepoFocusRows rows={data.repoFocus} />
          </Card>
        </div>
      )}

      {/* Project rollup */}
      {data.byProject.length > 0 && (
        <div style={{ marginTop: space.x6 }}>
          <Card>
            <CardHeader
              title={`by project · last ${data.chartDays}d`}
              hint={`${data.byProject.length} project${data.byProject.length === 1 ? "" : "s"} with activity`}
              right={<a href="/projects" style={{ color: palette.cyan, textDecoration: "none" }}>manage projects →</a>}
            />
            <ProjectRollupTable rows={data.byProject} />
          </Card>
        </div>
      )}

      {/* Recent commits + activity feed */}
      <div className="dash-grid" style={{ marginTop: space.x6 }}>
        <Card>
          <CardHeader title={`recent commits · last ${windowOpt.days}d`} hint={recentCommitHint(data)} />
          <RecentCommits commits={data.recentCommits} githubState={data.githubState} agentGitCommits={data.commitTotals.agentGitCommits} isOwnView={isOwnView} />
        </Card>
        <Card>
          <CardHeader title="recent activity · last 50 events" />
          <ActivityFeed feed={data.feed} />
        </Card>
      </div>
    </>
  );
}

// ─── Async briefing panel ─────────────────────────────────────────────

async function BriefingPanel({
  userId,
  inputs,
  aiEnabled = true,
}: { userId: string; inputs: BriefingInputs; aiEnabled?: boolean }): Promise<ReactElement> {
  if (!aiEnabled) {
    return (
      <Card style={{ borderStyle: "dashed" }}>
        <div style={{ fontSize: 13, color: palette.textDim, lineHeight: 1.6 }}>
          <span style={{ color: palette.cyan, marginRight: 6 }}>briefing</span>
          AI insights are a Pro feature.{" "}
          <a href="/billing" style={{ color: palette.cyan }}>Upgrade to Pro →</a>
        </div>
      </Card>
    );
  }

  const briefing = await getOrComputeBriefing(userId, inputs, aiEnabled);
  if (!briefing) return <></>;

  return (
    <Card accent={palette.cyan} style={{ background: "linear-gradient(180deg, rgba(124,208,255,0.04), transparent 60%)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.x2, marginBottom: space.x2 }}>
        <span style={{ fontSize: 10, color: palette.cyan, letterSpacing: "0.8px", textTransform: "uppercase", fontWeight: 500 }}>
          briefing · generated by Pulse {briefing.source === "fallback" && "· fallback"}
        </span>
        <span style={{ fontSize: 10, color: palette.textMute }}>
          {fmtAgo(briefing.generated_at)}
        </span>
      </div>
      <div style={{ fontSize: 14, lineHeight: 1.6, color: palette.text }}>
        {briefing.text}
      </div>
    </Card>
  );
}

function BriefingSkeleton(): ReactElement {
  return (
    <Card>
      <Skeleton height={11} width={180} />
      <div style={{ height: 8 }} />
      <Skeleton height={14} />
      <div style={{ height: 6 }} />
      <Skeleton height={14} width="80%" />
    </Card>
  );
}

// ─── Inline sub-components ────────────────────────────────────────────

function AnomalyChip({ color, msg }: { color: string; msg: string }): ReactElement {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "5px 10px",
      background: `${color}10`,
      border: `1px solid ${color}40`,
      borderRadius: 999,
      color, fontSize: 11, letterSpacing: "0.3px",
    }}>
      ⚡ {msg}
    </span>
  );
}

function RecentCommits({
  commits,
  githubState,
  agentGitCommits,
  isOwnView,
}: {
  commits: { subject: string; repo: string; sha: string; ts: string }[];
  githubState: "ready" | "missing_or_stale" | "empty";
  agentGitCommits: number;
  isOwnView: boolean;
}): ReactElement {
  if (commits.length === 0) {
    if (githubState === "missing_or_stale") {
      return (
        <div style={{ color: palette.textMute, fontSize: 12, lineHeight: 1.6 }}>
          No GitHub commits synced yet. Pulse saw {agentGitCommits.toLocaleString()} agent git
          commit{agentGitCommits === 1 ? "" : "s"}, but commit subjects and PR details require GitHub sync.
          {isOwnView && (
            <>
              {" "}<a href="/github" style={{ color: palette.cyan }}>Connect or sync GitHub →</a>
            </>
          )}
        </div>
      );
    }
    return <div style={{ color: palette.textMute, fontSize: 12 }}>No GitHub commit details in this window.</div>;
  }
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 12 }}>
      {commits.map((c) => (
        <li
          key={c.sha}
          style={{
            display: "flex", alignItems: "baseline", gap: space.x2,
            padding: "8px 0",
            borderBottom: `1px dashed ${palette.border}`,
          }}
        >
          <code style={{ color: palette.green, fontSize: 10 }}>{c.sha.slice(0, 7)}</code>
          <span style={{ color: palette.textDim, fontSize: 11, minWidth: 110, flexShrink: 0 }}>
            {c.repo.split("/").pop()}
          </span>
          <span style={{ color: palette.text, flex: 1 }}>{c.subject}</span>
          <span style={{ color: palette.textMute, fontSize: 10 }}>{fmtAgo(new Date(c.ts))}</span>
        </li>
      ))}
    </ul>
  );
}

function RepoFocusRows({
  rows,
}: { rows: { repo: string; activeMinutes: number; commits: number; prs: number }[] }): ReactElement {
  const maxActive = Math.max(...rows.map((r) => r.activeMinutes), 1);
  const maxOutput = Math.max(...rows.map((r) => r.commits + r.prs), 1);
  return (
    <div style={{ display: "grid", gap: 10, marginTop: space.x2 }}>
      {rows.map((r) => {
        const activePct = Math.max(2, (r.activeMinutes / maxActive) * 100);
        const outputPct = Math.max(2, ((r.commits + r.prs) / maxOutput) * 100);
        return (
          <div key={r.repo} style={{ display: "grid", gridTemplateColumns: "minmax(130px, 220px) 1fr auto", gap: 12, alignItems: "center" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: palette.text, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.repo}</div>
              <div style={{ color: palette.textMute, fontSize: 10 }}>{fmtActiveTime(r.activeMinutes)} active</div>
            </div>
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ height: 7, borderRadius: 4, background: palette.bgRaised, overflow: "hidden" }}>
                <div style={{ width: `${activePct}%`, height: "100%", background: palette.green }} />
              </div>
              <div style={{ height: 7, borderRadius: 4, background: palette.bgRaised, overflow: "hidden" }}>
                <div style={{ width: `${outputPct}%`, height: "100%", background: palette.purple }} />
              </div>
            </div>
            <div style={{ color: palette.textDim, fontSize: 11, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              {r.commits} commits<br />{r.prs} PRs
            </div>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 14, color: palette.textMute, fontSize: 10 }}>
        <span><span style={{ color: palette.green }}>■</span> active time</span>
        <span><span style={{ color: palette.purple }}>■</span> commits + PRs</span>
      </div>
    </div>
  );
}

function commitStatHint(totals: { githubCommits: number; agentGitCommits: number }): string {
  if (totals.githubCommits > 0 && totals.agentGitCommits > 0) {
    return `${totals.githubCommits} GitHub · ${totals.agentGitCommits} agent git seen`;
  }
  if (totals.githubCommits > 0) return "from GitHub sync";
  if (totals.agentGitCommits > 0) return "from agent git fallback";
  return "GitHub or agent git";
}

function recentCommitHint(data: { recentCommits: unknown[]; commitTotals: { commits: number; githubCommits: number; agentGitCommits: number } }): string {
  if (data.recentCommits.length > 0) return `${data.recentCommits.length} GitHub commit details`;
  if (data.commitTotals.agentGitCommits > 0) return `${data.commitTotals.agentGitCommits} agent git commits · no GitHub details`;
  return `${data.commitTotals.commits} commits`;
}

function fmtActiveTime(minutes: number): string {
  if (minutes >= 60) return `${(minutes / 60).toLocaleString(undefined, { maximumFractionDigits: 1 })}h`;
  return `${minutes.toLocaleString(undefined, { maximumFractionDigits: 1 })}m`;
}

interface PluginImpactShape {
  tokensSaved: number;
  breakdown: { genome: number; snipcompact: number; route: number };
  features: string[];
  estUsdSavedCents: number;
  daysCovered: number;
}

function PluginImpactCard({ impact }: { impact: PluginImpactShape }): ReactElement {
  const totalBreakdown =
    impact.breakdown.genome + impact.breakdown.snipcompact + impact.breakdown.route;
  const pct = (n: number): number =>
    totalBreakdown === 0 ? 0 : Math.round((n / totalBreakdown) * 100);
  return (
    <Card accent={palette.green}>
      <CardHeader
        title="ashlr-plugin impact"
        hint={`last ${impact.daysCovered}d · ${impact.features.join(" · ") || "unspecified features"}`}
      />
      <div style={{ display: "flex", alignItems: "baseline", gap: space.x4, marginTop: space.x3, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 28, color: palette.green, fontVariantNumeric: "tabular-nums" }}>
            {abbrev(impact.tokensSaved)}
          </div>
          <div style={{ fontSize: 11, color: palette.textMute, letterSpacing: 0.5, textTransform: "uppercase" }}>
            tokens saved
          </div>
        </div>
        <div>
          <div style={{ fontSize: 22, color: palette.cyan, fontVariantNumeric: "tabular-nums" }}>
            ~{fmtUsd(impact.estUsdSavedCents)}
          </div>
          <div style={{ fontSize: 11, color: palette.textMute, letterSpacing: 0.5, textTransform: "uppercase" }}>
            estimated — conservative
          </div>
        </div>
        {totalBreakdown > 0 && (
          <div style={{ flex: 1, minWidth: 240 }}>
            <BreakdownBar parts={[
              { label: "genome",      value: impact.breakdown.genome,      pct: pct(impact.breakdown.genome),      color: palette.green },
              { label: "snipcompact", value: impact.breakdown.snipcompact, pct: pct(impact.breakdown.snipcompact), color: palette.cyan },
              { label: "route",       value: impact.breakdown.route,       pct: pct(impact.breakdown.route),       color: palette.amber },
            ]} />
          </div>
        )}
      </div>
    </Card>
  );
}

function BreakdownBar({
  parts,
}: { parts: { label: string; value: number; pct: number; color: string }[] }): ReactElement {
  return (
    <div>
      <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: palette.bgRaised }}>
        {parts.map((p) => (
          p.pct > 0 && (
            <div key={p.label} style={{ width: `${p.pct}%`, background: p.color, transition: "width 0.5s ease" }} />
          )
        ))}
      </div>
      <div style={{ display: "flex", gap: space.x3, fontSize: 11, marginTop: space.x2, flexWrap: "wrap" }}>
        {parts.map((p) => (
          <span key={p.label} style={{ color: palette.textDim }}>
            <span style={{ color: p.color }}>●</span> {p.label} · {abbrev(p.value)}
          </span>
        ))}
      </div>
    </div>
  );
}

function CostBreakdownPanel({
  breakdown,
}: { breakdown: import("@/lib/pricing").CostBreakdownMillicents }): ReactElement {
  const rows: { label: string; rate: string; ms: number; color: string }[] = [
    { label: "input",            rate: "1.00× model rate",  ms: breakdown.input,              color: palette.cyan    },
    { label: "output",           rate: "1.00× output rate", ms: breakdown.output,             color: palette.magenta },
    { label: "reasoning",        rate: "1.00× output rate", ms: breakdown.reasoning,          color: palette.purple  },
    { label: "cache read",       rate: "0.10× input rate",  ms: breakdown.cache_read,         color: palette.green   },
    { label: "cache write · 5m", rate: "1.25× input rate",  ms: breakdown.cache_5m_write,     color: palette.amber   },
    { label: "cache write · 1h", rate: "2.00× input rate",  ms: breakdown.cache_1h_write,     color: palette.amber   },
    { label: "cache (legacy)",   rate: "1.25-2× input",     ms: breakdown.cache_write_legacy, color: palette.textDim },
  ].filter((r) => r.ms > 0);
  const total = breakdown.total || 1;
  return (
    <div style={{ marginTop: space.x3 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: `1px solid ${palette.border}` }}>
            <th style={th}>component</th>
            <th style={th}>rate</th>
            <th style={{ ...th, textAlign: "right" }}>$</th>
            <th style={{ ...th, textAlign: "right" }}>%</th>
            <th style={{ ...th, width: "30%" }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pct = (r.ms / total) * 100;
            return (
              <tr key={r.label} style={{ borderBottom: `1px dashed ${palette.border}` }}>
                <td style={td}>
                  <span style={{ color: r.color }}>●</span>
                  <span style={{ color: palette.text, marginLeft: 8 }}>{r.label}</span>
                </td>
                <td style={{ ...td, color: palette.textMute, fontSize: 11 }}>{r.rate}</td>
                <td style={{ ...td, textAlign: "right", color: palette.text, fontVariantNumeric: "tabular-nums" }}>
                  {fmtUsd(Math.round(r.ms / 1000))}
                </td>
                <td style={{ ...td, textAlign: "right", color: palette.textDim, fontVariantNumeric: "tabular-nums" }}>
                  {pct.toFixed(1)}%
                </td>
                <td style={td}>
                  <div style={{ height: 6, background: palette.bgRaised, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(100, pct)}%`, background: r.color, transition: "width 0.5s ease" }} />
                  </div>
                </td>
              </tr>
            );
          })}
          <tr style={{ borderTop: `1px solid ${palette.border}` }}>
            <td style={{ ...td, color: palette.text, fontWeight: 500 }}>total</td>
            <td style={td}></td>
            <td style={{ ...td, textAlign: "right", color: palette.magenta, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
              {fmtUsd(Math.round(breakdown.total / 1000))}
            </td>
            <td style={{ ...td, textAlign: "right", color: palette.textDim }}>100%</td>
            <td style={td}></td>
          </tr>
        </tbody>
      </table>
      {breakdown.cache_5m_write + breakdown.cache_1h_write + breakdown.cache_write_legacy > breakdown.input + breakdown.output + breakdown.reasoning && (
        <div style={{ marginTop: space.x3, fontSize: 11, color: palette.textMute, lineHeight: 1.5 }}>
          Cache writes ({fmtUsd(Math.round((breakdown.cache_5m_write + breakdown.cache_1h_write + breakdown.cache_write_legacy) / 1000))}) outweigh input + output + reasoning ({fmtUsd(Math.round((breakdown.input + breakdown.output + breakdown.reasoning) / 1000))}). Anthropic charges 5-minute cache writes at 1.25× and 1-hour writes at 2.00× input rate, so cmux + long-context flows pay more for caching context than for the model invocations themselves.
        </div>
      )}
    </div>
  );
}

import type { Recommendation } from "@/lib/cost-insights";

function InsightCard({ rec }: { rec: Recommendation }): ReactElement {
  const accent =
    rec.kind === "model_swap"            ? palette.cyan :
    rec.kind === "enable_plugin_feature" ? palette.green :
    rec.kind === "cache_strategy"        ? palette.amber :
                                           palette.magenta;
  return (
    <div style={{
      border: `1px solid ${accent}30`,
      borderRadius: 8,
      padding: space.x3,
      background: `${accent}08`,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: space.x2, marginBottom: space.x2 }}>
        <span style={{ fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", color: accent }}>
          {rec.kind.replace(/_/g, " ")}
        </span>
        {rec.est_savings_usd_month > 0 && (
          <span style={{ fontSize: 10, color: palette.textMute, marginLeft: "auto" }}>
            ~${rec.est_savings_usd_month}/mo
          </span>
        )}
      </div>
      <div style={{ fontSize: 13, color: palette.text, fontWeight: 500, marginBottom: space.x2 }}>
        {rec.title}
      </div>
      <div style={{ fontSize: 12, color: palette.textDim, lineHeight: 1.5, marginBottom: space.x2 }}>
        {rec.detail}
      </div>
      <div style={{ fontSize: 11, color: accent }}>
        {rec.cta} →
      </div>
    </div>
  );
}

// ─── Utility ──────────────────────────────────────────────────────────

function tokenStatHint(
  today: { tokens: number; tokensTotal: number },
  baseline: number,
): string | undefined {
  const cacheTokens = Math.max(0, today.tokensTotal - today.tokens);
  const baselinePart = baseline ? `vs ${abbrev(baseline)} median` : null;
  const cachePart    = cacheTokens > 0 ? `+ ${abbrev(cacheTokens)} cache` : null;
  return [cachePart, baselinePart].filter(Boolean).join(" · ") || undefined;
}

function fmtAgo(d: Date): string {
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
