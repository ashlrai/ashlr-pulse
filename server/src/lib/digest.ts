/**
 * digest.ts — assemble yesterday's activity for one user's morning email.
 *
 * Two sections, both bounded to the user's *local* yesterday (00:00 to
 * 24:00 in their digest_tz):
 *
 *   1. self — your own activity: per-source token+cost summary, per-repo
 *      breakdown, GitHub commit/PR counts, and a "missed" list (repos with
 *      commits but zero token activity — usually means the agent wasn't
 *      running there).
 *
 *   2. peers — for each peer who has an active peer_share grant *to* you,
 *      we render their yesterday filtered by:
 *        - granularity: only grants with realtime|daily fire daily.
 *          weekly fires on Monday, monthly fires on the 1st.
 *        - scope: 'all' | 'repo_pattern' (LIKE) | 'project' (join).
 *        - fields: only token-related columns are rendered if those
 *          fields appear in the grant's whitelist; repo column is omitted
 *          if 'repo_name' isn't shared.
 *
 * The privacy floor is owned by lib/peer-share-guard at insert time, so
 * by the time we render here the fields[] array is already trimmed to
 * the safe set.
 */

import { sql } from "./db";
import { costUsdCents } from "./pricing";
import { aggregateByProject, type ProjectAgg } from "./project-db";
import { retentionCutoff, type PlanLimits } from "./plan-gate";
import { forecast } from "./forecast";

export type DigestFrequency = "daily" | "weekly";

export interface DigestSelfBySource {
  source: string;
  events: number;
  tokens: number;
  cents: number | null;
}

export interface DigestSelfByRepo {
  repo: string;
  events: number;
  tokens: number;
  cents: number | null;
}

export interface DigestSelfGitHub {
  commits: number;
  prs_opened: number;
  prs_merged: number;
}

export interface DigestSelf {
  bySource: DigestSelfBySource[];
  byRepo: DigestSelfByRepo[];
  /** Per-project rollup. Empty when the user has no projects defined yet. */
  byProject: ProjectAgg[];
  github: DigestSelfGitHub;
  /** Repos that had GitHub commits yesterday but zero token activity. */
  missedRepos: string[];
  /**
   * Headline anomaly callouts derived purely from yesterday's
   * composition (no extra SQL): single-repo dominance, single-source
   * dominance, idle-repo signal. Rendered as a banner at the top of
   * the digest so a busy reader sees the signal first.
   */
  anomalies: string[];
}

export interface DigestPeer {
  owner_id: string;
  owner_email: string;
  bySource: DigestSelfBySource[];
  byRepo: DigestSelfByRepo[] | null; // null when grant doesn't share repo_name
  showCost: boolean;                 // true iff token fields are visible
}

/** Week-over-week delta summary included in weekly digests. */
export interface WeeklyWowDelta {
  /** Current week total tokens. */
  tokens_this: number;
  /** Previous week total tokens. */
  tokens_prev: number;
  /** Current week total cost cents. */
  cents_this: number | null;
  /** Previous week total cost cents. */
  cents_prev: number | null;
  /** Current week total events. */
  events_this: number;
  /** Previous week total events. */
  events_prev: number;
}

/** End-of-month cost forecast included in weekly digests (cents). */
export interface WeeklyForecast {
  /** Median projected remaining cost for the rest of this month (cents). */
  remaining_p50: number;
  /** Lower band projected remaining cost (cents). */
  remaining_p10: number;
  /** Upper band projected remaining cost (cents). */
  remaining_p90: number;
  /** Day-of-month when the forecast was computed. */
  computed_dom: number;
}

export interface DigestPayload {
  user_id: string;
  email: string;
  /** Local-yesterday window in the user's digest_tz, e.g. "Wed, Apr 24". */
  dateLabel: string;
  self: DigestSelf;
  peers: DigestPeer[];
  /** True if there is literally nothing to report (no self, no peers). */
  empty: boolean;
  /** Present only on weekly digests. */
  weekly?: {
    wow: WeeklyWowDelta;
    /** Top 3 anomaly strings from the 7d window. */
    anomalies: string[];
    forecast: WeeklyForecast | null;
  };
}

/**
 * Should the digest cron fire for this granularity given the org's
 * digest_frequency setting?
 *
 *   frequency='daily'  → daily fires, weekly does not
 *   frequency='weekly' → weekly fires, daily does not
 *   frequency='both'   → both fire
 *
 * The `granularity` arg comes from the cron route ('daily' | 'weekly').
 */
export function shouldSendDigest(
  granularity: DigestFrequency,
  orgFrequency: "daily" | "weekly" | "both",
): boolean {
  if (orgFrequency === "both") return true;
  return orgFrequency === granularity;
}

interface UserPrefs {
  id: string;
  email: string;
  digest_email: string | null;
  digest_tz: string;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * Returns ISO-string bounds for "yesterday" in the user's TZ as a
 * UTC range we can hand to Postgres. Postgres is happy with these
 * literals against a TIMESTAMPTZ column.
 */
export function yesterdayWindow(
  tz: string,
  now: Date = new Date(),
): { startUtc: string; endUtc: string; label: string } {
  // Get "now" in the user's TZ as YYYY-MM-DD parts.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const todayLocal = `${get("year")}-${get("month")}-${get("day")}`; // YYYY-MM-DD

  // Yesterday = todayLocal - 1 day. Easy via Date arithmetic on UTC midnight
  // of todayLocal, since we want a 24h window in the user's TZ.
  const todayMidnightUtc = zonedDateToUtc(todayLocal, "00:00:00", tz);
  const yesterdayMidnightUtc = new Date(todayMidnightUtc.getTime() - 24 * 3600_000);

  const startUtc = yesterdayMidnightUtc.toISOString();
  const endUtc = todayMidnightUtc.toISOString();

  // Human label using the *yesterday* date.
  const yyy = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(yesterdayMidnightUtc);

  return { startUtc, endUtc, label: yyy };
}

/**
 * Convert a wall-clock date+time in `tz` to its UTC instant.
 * Uses Intl to find the offset at that moment (so DST is handled).
 */
function zonedDateToUtc(dateYmd: string, timeHms: string, tz: string): Date {
  // Probe: ask the browser/Node what UTC time corresponds to the wall
  // clock if we interpret the literal as UTC; subtract the offset.
  const guess = new Date(`${dateYmd}T${timeHms}Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = fmt.formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const wallMs = Date.UTC(
    get("year"), get("month") - 1, get("day"),
    get("hour"), get("minute"), get("second"),
  );
  // offset = wall - utc (positive east of UTC). To go from wall→utc, subtract.
  const offsetMs = wallMs - guess.getTime();
  return new Date(guess.getTime() - offsetMs);
}

/**
 * Returns the user's local hour right now (0-23) in their TZ. Used by the
 * cron sweep to decide whether to fire the 9am send.
 */
export function localHour(tz: string, now: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
  });
  return Number(fmt.format(now).replace(/[^0-9]/g, ""));
}

/**
 * Returns ISO-string bounds for "this week" and "previous week" in the
 * user's TZ, ending at the start of the current day (i.e. the 7-day window
 * Mon–Sun preceding today).
 *
 * "This week" = the 7 days ending at today's local midnight (the completed
 * Mon–Sun span that the Monday digest summarises).
 * "Prev week" = the 7 days before that.
 */
export function weekWindows(
  tz: string,
  now: Date = new Date(),
): {
  thisStart: string; thisEnd: string;
  prevStart: string; prevEnd: string;
  label: string;
} {
  // Find local Monday of the current ISO week (week starts Mon).
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const todayLocalYmd = `${get("year")}-${get("month")}-${get("day")}`;

  // We want Monday–Sunday of last week.
  const todayMidnightUtc = zonedDateToUtc(todayLocalYmd, "00:00:00", tz);
  // dow: 0=Sun,1=Mon...6=Sat. We want the Monday that started this week.
  const nowLocal = new Date(todayMidnightUtc.getTime());
  const fmtWd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
  const wdStr = fmtWd.format(now);
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[wdStr] ?? 0;

  // Days since last Monday. If today is Monday, dow=1 → daysToMon=0 (start of this week).
  // For the weekly digest we summarise the *completed* week: Mon(7 days ago)→Mon(today midnight).
  // So thisEnd = today's local midnight (= now's Monday midnight).
  // thisStart = thisEnd - 7 days.
  const daysToMon = dow === 0 ? 6 : dow - 1; // days since last Monday
  // Monday midnight UTC of the current week:
  const thisWeekMondayUtc = new Date(todayMidnightUtc.getTime() - daysToMon * 86_400_000);

  const thisEnd   = thisWeekMondayUtc.toISOString();                                  // this Mon 00:00 local
  const thisStart = new Date(thisWeekMondayUtc.getTime() - 7 * 86_400_000).toISOString(); // prev Mon 00:00 local
  const prevStart = new Date(thisWeekMondayUtc.getTime() - 14 * 86_400_000).toISOString();
  const prevEnd   = thisStart;

  // Week label: "week of Mon Apr 21"
  const weekStartDate = new Date(thisWeekMondayUtc.getTime() - 7 * 86_400_000);
  const labelFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric",
  });
  const label = `week of ${labelFmt.format(weekStartDate)}`;

  return { thisStart, thisEnd, prevStart, prevEnd, label };
}

/**
 * Returns the user's local weekday right now (0=Sunday..6=Saturday) and
 * day-of-month — used to decide whether weekly/monthly grants should fire.
 */
export function localCalendar(tz: string, now: Date = new Date()): { dow: number; dom: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const dom = Number(parts.find((p) => p.type === "day")?.value ?? "1");
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  return { dow, dom };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface ActivityRow {
  source: string;
  repo_name: string | null;
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  tokens_cache_5m_write: number | null;
  tokens_cache_1h_write: number | null;
  ts: string;
}

async function loadActivity(
  userId: string,
  startUtc: string,
  endUtc: string,
  repoFilter: { type: "all" } | { type: "like"; pattern: string } | { type: "project"; projectId: string },
): Promise<ActivityRow[]> {
  const db = sql();
  if (repoFilter.type === "all") {
    return db<ActivityRow[]>`
      SELECT source, repo_name, model,
             tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
             tokens_cache_5m_write, tokens_cache_1h_write,
             ts::text AS ts
      FROM activity_event
      WHERE user_id = ${userId}
        AND ts >= ${startUtc}::timestamptz
        AND ts <  ${endUtc}::timestamptz
    `;
  }
  if (repoFilter.type === "like") {
    return db<ActivityRow[]>`
      SELECT source, repo_name, model,
             tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
             tokens_cache_5m_write, tokens_cache_1h_write,
             ts::text AS ts
      FROM activity_event
      WHERE user_id = ${userId}
        AND ts >= ${startUtc}::timestamptz
        AND ts <  ${endUtc}::timestamptz
        AND repo_name LIKE ${repoFilter.pattern}
    `;
  }
  return db<ActivityRow[]>`
    SELECT ae.source, ae.repo_name, ae.model,
           ae.tokens_input, ae.tokens_output, ae.tokens_cache_read, ae.tokens_cache_write,
           ae.tokens_cache_5m_write, ae.tokens_cache_1h_write,
           ae.ts::text AS ts
    FROM activity_event ae
    JOIN project_repo pr ON pr.repo_name = ae.repo_name
    WHERE ae.user_id = ${userId}
      AND pr.project_id = ${repoFilter.projectId}::uuid
      AND ae.ts >= ${startUtc}::timestamptz
      AND ae.ts <  ${endUtc}::timestamptz
  `;
}

function aggregateBySource(rows: ActivityRow[]): DigestSelfBySource[] {
  const map = new Map<string, { events: number; tokens: number; cents: number | null }>();
  for (const r of rows) {
    const tokens = (r.tokens_input ?? 0) + (r.tokens_output ?? 0);
    const cents = costUsdCents({
      model: r.model,
      tokens_input: r.tokens_input,
      tokens_output: r.tokens_output,
      tokens_cache_read: r.tokens_cache_read,
      tokens_cache_write: r.tokens_cache_write,
      tokens_cache_5m_write: r.tokens_cache_5m_write,
      tokens_cache_1h_write: r.tokens_cache_1h_write,
      ts: new Date(r.ts),
    });
    const cur = map.get(r.source) ?? { events: 0, tokens: 0, cents: null };
    cur.events += 1;
    cur.tokens += tokens;
    if (cents != null) cur.cents = (cur.cents ?? 0) + cents;
    map.set(r.source, cur);
  }
  return [...map.entries()]
    .map(([source, v]) => ({ source, ...v }))
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * Pure-function anomaly detection over yesterday's already-aggregated
 * data. No SQL, no baselines — just composition checks meant to surface
 * "if you read only one line of the digest, it should be this one."
 *
 * Returned strings render as a banner at the top of the email. Order
 * matters — most-actionable first.
 */
function computeAnomalies(input: {
  bySource: DigestSelfBySource[];
  byRepo: DigestSelfByRepo[];
  missedRepos: string[];
}): string[] {
  const out: string[] = [];

  // Single-repo dominance: one repo is >60% of the day's billable tokens.
  // Flags "all my work yesterday went into client-x" so the user notices
  // when one engagement is eating the day.
  const totalTokens = input.byRepo.reduce((s, r) => s + r.tokens, 0);
  if (totalTokens > 0 && input.byRepo.length >= 2) {
    const top = input.byRepo[0];
    const share = top.tokens / totalTokens;
    if (share > 0.6) {
      out.push(
        `${top.repo} dominated yesterday — ${Math.round(share * 100)}% of tokens (${top.events} events).`,
      );
    }
  }

  // Single-source dominance: one tool drove >80% of activity. Worth a
  // callout in the multi-tool persona (Claude Code + Cursor + Copilot).
  const totalEvents = input.bySource.reduce((s, r) => s + r.events, 0);
  if (totalEvents > 0 && input.bySource.length >= 2) {
    const topSrc = input.bySource[0];
    const srcShare = topSrc.events / totalEvents;
    if (srcShare > 0.8) {
      out.push(
        `${topSrc.source} drove ${Math.round(srcShare * 100)}% of yesterday's events — your other tools were quiet.`,
      );
    }
  }

  // Missed-repo signal: GitHub commits landed for repos with zero AI
  // activity (someone else worked, or you worked without AI).
  if (input.missedRepos.length > 0) {
    const sample = input.missedRepos.slice(0, 3).join(", ");
    const more = input.missedRepos.length > 3 ? ` (+${input.missedRepos.length - 3} more)` : "";
    out.push(
      `Commits landed in ${input.missedRepos.length} repo${input.missedRepos.length === 1 ? "" : "s"} with no AI activity yesterday: ${sample}${more}.`,
    );
  }

  return out;
}

function aggregateByRepo(rows: ActivityRow[]): DigestSelfByRepo[] {
  const map = new Map<string, { events: number; tokens: number; cents: number | null }>();
  for (const r of rows) {
    if (!r.repo_name) continue;
    const tokens = (r.tokens_input ?? 0) + (r.tokens_output ?? 0);
    const cents = costUsdCents({
      model: r.model,
      tokens_input: r.tokens_input,
      tokens_output: r.tokens_output,
      tokens_cache_read: r.tokens_cache_read,
      tokens_cache_write: r.tokens_cache_write,
      tokens_cache_5m_write: r.tokens_cache_5m_write,
      tokens_cache_1h_write: r.tokens_cache_1h_write,
      ts: new Date(r.ts),
    });
    const cur = map.get(r.repo_name) ?? { events: 0, tokens: 0, cents: null };
    cur.events += 1;
    cur.tokens += tokens;
    if (cents != null) cur.cents = (cur.cents ?? 0) + cents;
    map.set(r.repo_name, cur);
  }
  return [...map.entries()]
    .map(([repo, v]) => ({ repo, ...v }))
    .sort((a, b) => b.tokens - a.tokens);
}

async function loadGitHubSummary(
  userId: string,
  startUtc: string,
  endUtc: string,
): Promise<{ summary: DigestSelfGitHub; reposWithCommits: Set<string> }> {
  const db = sql();
  const rows = await db<{ kind: string; full_name: string }[]>`
    SELECT ge.kind, gr.full_name
    FROM github_event ge
    JOIN github_repo    gr ON gr.id = ge.repo_id
    JOIN github_account ga ON ga.id = ge.account_id
    WHERE ga.user_id = ${userId}
      AND ge.ts >= ${startUtc}::timestamptz
      AND ge.ts <  ${endUtc}::timestamptz
  `;
  let commits = 0;
  let prs_opened = 0;
  let prs_merged = 0;
  const reposWithCommits = new Set<string>();
  for (const r of rows) {
    if (r.kind === "commit") {
      commits++;
      reposWithCommits.add(r.full_name);
    } else if (r.kind === "pr_opened") prs_opened++;
    else if (r.kind === "pr_merged") prs_merged++;
  }
  return { summary: { commits, prs_opened, prs_merged }, reposWithCommits };
}

// ---------------------------------------------------------------------------
// Peer-share scope mapping
// ---------------------------------------------------------------------------

interface PeerGrant {
  owner_id: string;
  owner_email: string;
  scope_type: "all" | "project" | "repo_pattern";
  scope_value: string | null;
  granularity: "realtime" | "daily" | "weekly" | "monthly";
  fields: string[];
}

async function loadActiveGrantsForViewer(viewerId: string): Promise<PeerGrant[]> {
  const db = sql();
  return db<PeerGrant[]>`
    SELECT
      ps.owner_id::text AS owner_id,
      o.email           AS owner_email,
      ps.scope_type, ps.scope_value, ps.granularity, ps.fields
    FROM peer_share ps
    JOIN "user" o ON o.id = ps.owner_id
    WHERE ps.viewer_id = ${viewerId}
      AND ps.revoked_at IS NULL
  `;
}

/** Should this grant fire on the given local calendar day? */
export function grantFires(
  granularity: PeerGrant["granularity"],
  cal: { dow: number; dom: number },
): boolean {
  if (granularity === "realtime" || granularity === "daily") return true;
  if (granularity === "weekly") return cal.dow === 1;   // Monday
  if (granularity === "monthly") return cal.dom === 1;
  return false;
}

function repoFilterFor(grant: PeerGrant): Parameters<typeof loadActivity>[3] {
  switch (grant.scope_type) {
    case "all":
      return { type: "all" };
    case "repo_pattern":
      return { type: "like", pattern: grant.scope_value ?? "%" };
    case "project":
      return { type: "project", projectId: grant.scope_value ?? "" };
  }
}

function tokensVisible(fields: string[]): boolean {
  return fields.includes("tokens_input") || fields.includes("tokens_output");
}
function repoVisible(fields: string[]): boolean {
  return fields.includes("repo_name");
}
function sourceVisible(fields: string[]): boolean {
  return fields.includes("source");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function loadUserPrefs(userId: string): Promise<UserPrefs | null> {
  const db = sql();
  const [row] = await db<UserPrefs[]>`
    SELECT id::text AS id, email, digest_email, digest_tz
    FROM "user"
    WHERE id = ${userId}::uuid
  `;
  return row ?? null;
}

export async function buildDigest(
  userId: string,
  now: Date = new Date(),
  limits?: PlanLimits,
  frequency: DigestFrequency = "daily",
): Promise<DigestPayload | null> {
  const prefs = await loadUserPrefs(userId);
  if (!prefs) return null;

  const cal = localCalendar(prefs.digest_tz, now);

  // For weekly digests use the 7-day window ending at this Monday's midnight;
  // for daily use yesterday's 24h window.
  let startUtc: string;
  let endUtc: string;
  let label: string;
  let weekWindowsForWow: ReturnType<typeof weekWindows> | null = null;

  if (frequency === "weekly") {
    const ww = weekWindows(prefs.digest_tz, now);
    weekWindowsForWow = ww;
    startUtc = ww.thisStart;
    endUtc   = ww.thisEnd;
    label    = ww.label;
  } else {
    const dw = yesterdayWindow(prefs.digest_tz, now);
    startUtc = dw.startUtc;
    endUtc   = dw.endUtc;
    label    = dw.label;
  }

  // Clamp startUtc to the retention cutoff when limits are provided.
  // Yesterday is typically within any plan's window, but this ensures
  // the digest never surfaces data older than the plan allows.
  const effectiveStart = limits
    ? new Date(Math.max(new Date(startUtc).getTime(), retentionCutoff(limits, now).getTime())).toISOString()
    : startUtc;

  // Self
  const selfRows = await loadActivity(userId, effectiveStart, endUtc, { type: "all" });
  const { summary: github, reposWithCommits } = await loadGitHubSummary(userId, effectiveStart, endUtc);
  const reposWithTokens = new Set(selfRows.map((r) => r.repo_name).filter((r): r is string => !!r));
  const missedRepos = [...reposWithCommits].filter((r) => !reposWithTokens.has(r)).sort();

  const byRepo = aggregateByRepo(selfRows);
  const byProject = await aggregateByProject(userId, byRepo);
  // If every repo lands in "(unassigned)" we hide the project section
  // entirely — it's just noise for users without projects defined.
  const projectsMeaningful = byProject.some((p) => p.project_id !== null);

  const bySource = aggregateBySource(selfRows);
  const self: DigestSelf = {
    bySource,
    byRepo,
    byProject: projectsMeaningful ? byProject : [],
    github,
    missedRepos,
    anomalies: computeAnomalies({ bySource, byRepo, missedRepos }),
  };

  // Peers
  const grants = await loadActiveGrantsForViewer(userId);
  const peerByOwner = new Map<string, DigestPeer>();
  for (const g of grants) {
    if (!grantFires(g.granularity, cal)) continue;

    const rows = await loadActivity(g.owner_id, effectiveStart, endUtc, repoFilterFor(g));
    const showTokens = tokensVisible(g.fields);
    const showRepo = repoVisible(g.fields);
    const showSource = sourceVisible(g.fields);

    // If neither tokens nor repo nor source are shareable, skip — there
    // is nothing the digest can render that the grant authorizes.
    if (!showTokens && !showRepo && !showSource) continue;

    const bySource = showSource ? aggregateBySource(rows) : [];
    const byRepoFull = aggregateByRepo(rows);
    const byRepo = showRepo ? byRepoFull : null;

    // Strip cost when tokens aren't shareable.
    const stripCost = <T extends { cents: number | null }>(arr: T[]): T[] =>
      showTokens ? arr : arr.map((r) => ({ ...r, cents: null, tokens: 0 } as T));

    // Merge with any earlier grant from the same owner (most permissive
    // fields win — already merged by Set semantics in the booleans above).
    const existing = peerByOwner.get(g.owner_id);
    const merged: DigestPeer = existing ?? {
      owner_id: g.owner_id,
      owner_email: g.owner_email,
      bySource: [],
      byRepo: null,
      showCost: false,
    };
    merged.bySource = bySource.length ? stripCost(bySource) : merged.bySource;
    merged.byRepo = byRepo ? stripCost(byRepo) : merged.byRepo;
    merged.showCost = merged.showCost || showTokens;
    peerByOwner.set(g.owner_id, merged);
  }
  const peers = [...peerByOwner.values()];

  const empty =
    self.bySource.length === 0 &&
    self.byRepo.length === 0 &&
    self.github.commits === 0 &&
    self.github.prs_opened === 0 &&
    self.github.prs_merged === 0 &&
    peers.every((p) => p.bySource.length === 0 && (p.byRepo ?? []).length === 0);

  // Weekly-only content: WoW deltas, top anomalies, EoM forecast.
  let weeklySection: DigestPayload["weekly"] | undefined;
  if (frequency === "weekly" && weekWindowsForWow) {
    const prevRows = await loadActivity(userId, weekWindowsForWow.prevStart, weekWindowsForWow.prevEnd, { type: "all" });
    const prevBySource = aggregateBySource(prevRows);

    const tokensThis  = selfRows.reduce((s, r) => s + (r.tokens_input ?? 0) + (r.tokens_output ?? 0), 0);
    const tokensPrev  = prevRows.reduce((s, r) => s + (r.tokens_input ?? 0) + (r.tokens_output ?? 0), 0);
    const centsThis   = self.bySource.reduce((s, r) => s + (r.cents ?? 0), 0);
    const centsPrev   = prevBySource.reduce((s, r) => s + (r.cents ?? 0), 0);
    const eventsThis  = selfRows.length;
    const eventsPrev  = prevRows.length;

    const wow: WeeklyWowDelta = {
      tokens_this: tokensThis,
      tokens_prev: tokensPrev,
      cents_this:  centsThis,
      cents_prev:  centsPrev,
      events_this: eventsThis,
      events_prev: eventsPrev,
    };

    // Top 3 anomalies from the 7-day window using same composition checks.
    const weeklyAnomalies = computeAnomalies({ bySource, byRepo, missedRepos }).slice(0, 3);

    // End-of-month cost forecast. Build a 30-day history ending at thisEnd
    // in daily buckets. We use the last 30 activity rows bucketed by day as
    // a coarse daily series — the forecast() function only needs daily cost
    // millicents so we compute them from the weekly window rows.
    let weeklyForecast: WeeklyForecast | null = null;
    try {
      // Fetch 30 days of daily cost for the forecast history.
      const thirtyDaysAgoUtc = new Date(new Date(weekWindowsForWow.thisEnd).getTime() - 30 * 86_400_000).toISOString();
      const histRows = await loadActivity(userId, thirtyDaysAgoUtc, weekWindowsForWow.thisEnd, { type: "all" });

      // Bucket into 30 daily millicent buckets (oldest first).
      const buckets = new Array<number>(30).fill(0);
      const endMs = new Date(weekWindowsForWow.thisEnd).getTime();
      for (const r of histRows) {
        const daysAgo = Math.floor((endMs - new Date(r.ts).getTime()) / 86_400_000);
        const idx = 29 - daysAgo;
        if (idx >= 0 && idx < 30) {
          const cents = costUsdCents({
            model: r.model,
            tokens_input: r.tokens_input,
            tokens_output: r.tokens_output,
            tokens_cache_read: r.tokens_cache_read,
            tokens_cache_write: r.tokens_cache_write,
            tokens_cache_5m_write: r.tokens_cache_5m_write,
            tokens_cache_1h_write: r.tokens_cache_1h_write,
            ts: new Date(r.ts),
          });
          buckets[idx] += (cents ?? 0) * 10; // cents → millicents
        }
      }

      const { dom: todayDom } = localCalendar(prefs.digest_tz, now);
      const daysLeft = 30 - todayDom; // rough days remaining in month

      if (daysLeft > 0) {
        const pts = forecast({ history: buckets, horizon: daysLeft });
        const remaining_p50 = Math.round(pts.reduce((s, p) => s + p.p50, 0) / 10); // millicents→cents
        const remaining_p10 = Math.round(pts.reduce((s, p) => s + p.p10, 0) / 10);
        const remaining_p90 = Math.round(pts.reduce((s, p) => s + p.p90, 0) / 10);
        weeklyForecast = { remaining_p50, remaining_p10, remaining_p90, computed_dom: todayDom };
      }
    } catch {
      // Forecast is best-effort; if it fails we just omit it.
      weeklyForecast = null;
    }

    weeklySection = {
      wow,
      anomalies: weeklyAnomalies,
      forecast: weeklyForecast,
    };
  }

  return {
    user_id: userId,
    email: prefs.digest_email ?? prefs.email,
    dateLabel: label,
    self,
    peers,
    empty,
    ...(weeklySection !== undefined ? { weekly: weeklySection } : {}),
  };
}

/**
 * Mark the user as "digest sent at <now>" — the cron uses this for
 * idempotency (we only fire if last_digest_sent_at < today_local_9am).
 */
export async function markDigestSent(userId: string, when: Date = new Date()): Promise<void> {
  const db = sql();
  await db`UPDATE "user" SET last_digest_sent_at = ${when.toISOString()}::timestamptz WHERE id = ${userId}::uuid`;
}

/**
 * Has the user already been sent today's digest (in their local TZ)?
 * "Today's 9am wall clock" is the cutoff — anything after counts.
 */
export function alreadySentToday(
  lastSentAtIso: string | null,
  tz: string,
  now: Date = new Date(),
): boolean {
  if (!lastSentAtIso) return false;
  // Today midnight (local), then 9am.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const todayLocalYmd = `${get("year")}-${get("month")}-${get("day")}`;
  const today9am = zonedDateToUtc(todayLocalYmd, "09:00:00", tz);
  return new Date(lastSentAtIso).getTime() >= today9am.getTime();
}

/**
 * Has the user already been sent a weekly digest this week (in their local TZ)?
 * Compares last_digest_sent_at against Monday 9am of the current local week.
 */
export function alreadySentThisWeek(
  lastSentAtIso: string | null,
  tz: string,
  now: Date = new Date(),
): boolean {
  if (!lastSentAtIso) return false;
  // Find Monday midnight (local) of the current week, then add 9h.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const todayLocalYmd = `${get("year")}-${get("month")}-${get("day")}`;
  const todayMidnightUtc = zonedDateToUtc(todayLocalYmd, "00:00:00", tz);

  const fmtWd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
  const wdStr = fmtWd.format(now);
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[wdStr] ?? 0;
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const mondayMidnightUtc = new Date(todayMidnightUtc.getTime() - daysToMon * 86_400_000);
  const monday9am = new Date(mondayMidnightUtc.getTime() + 9 * 3600_000);

  return new Date(lastSentAtIso).getTime() >= monday9am.getTime();
}

/**
 * Mark the user as "weekly digest sent at <now>".
 * Uses a separate column so daily and weekly sends don't clobber each other's
 * idempotency guards.
 */
export async function markWeeklyDigestSent(userId: string, when: Date = new Date()): Promise<void> {
  const db = sql();
  await db`UPDATE "user" SET last_weekly_digest_sent_at = ${when.toISOString()}::timestamptz WHERE id = ${userId}::uuid`;
}

/**
 * Pick all users who should be sent the weekly digest right now.
 * Fires only on Mondays at local >= 9am, guarded by last_weekly_digest_sent_at.
 */
export async function pickDueUsersWeekly(now: Date = new Date()): Promise<UserPrefs[]> {
  const db = sql();
  const nowIso = now.toISOString();
  return db<UserPrefs[]>`
    SELECT
      id::text     AS id,
      email,
      digest_email,
      digest_tz
    FROM "user"
    WHERE digest_enabled = TRUE
      AND EXTRACT(DOW  FROM (${nowIso}::timestamptz AT TIME ZONE digest_tz)) = 1
      AND EXTRACT(HOUR FROM (${nowIso}::timestamptz AT TIME ZONE digest_tz)) >= 9
      AND (
        last_weekly_digest_sent_at IS NULL
        OR last_weekly_digest_sent_at < (
          date_trunc('week', ${nowIso}::timestamptz AT TIME ZONE digest_tz)
          + interval '1 day 9 hours'
        ) AT TIME ZONE digest_tz
      )
  `;
}

/**
 * Pick all users who should be sent the digest right now. Filters in
 * SQL — both the "current local hour ≥ 9" gate and the "haven't sent
 * since today's local 9am" idempotency check — so we don't load the
 * whole user table per cron tick AND so users past an arbitrary LIMIT
 * never get silently skipped.
 *
 * `last_digest_sent_at` lives as TIMESTAMPTZ (UTC); we compare it
 * against today-9am-in-user-TZ which we convert back to UTC via
 * `(local_wall_clock) AT TIME ZONE digest_tz`.
 */
export async function pickDueUsers(now: Date = new Date()): Promise<UserPrefs[]> {
  const db = sql();
  const nowIso = now.toISOString();
  return db<UserPrefs[]>`
    SELECT
      id::text     AS id,
      email,
      digest_email,
      digest_tz
    FROM "user"
    WHERE digest_enabled = TRUE
      AND EXTRACT(HOUR FROM (${nowIso}::timestamptz AT TIME ZONE digest_tz)) >= 9
      AND (
        last_digest_sent_at IS NULL
        OR last_digest_sent_at < (
          date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE digest_tz)
          + interval '9 hours'
        ) AT TIME ZONE digest_tz
      )
  `;
}
