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
}

export interface DigestPeerTotals {
  events: number;
  tokens: number;
  cents: number | null;
  /** Distinct repo count, or null when the grant doesn't share repo_name. */
  repos: number | null;
  /** Distinct tool/source count, or null when the grant doesn't share source. */
  tools: number | null;
}

export interface DigestPeer {
  owner_id: string;
  owner_email: string;
  /** One-line summary derived from already-authorized fields. */
  totals: DigestPeerTotals;
  bySource: DigestSelfBySource[];
  byRepo: DigestSelfByRepo[] | null; // null when grant doesn't share repo_name
  /** Project rollup, or [] when projects can't be resolved or repo_name isn't shared. */
  byProject: ProjectAgg[];
  showCost: boolean;                 // true iff token fields are visible
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

function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
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
): Promise<DigestPayload | null> {
  const prefs = await loadUserPrefs(userId);
  if (!prefs) return null;

  const { startUtc, endUtc, label } = yesterdayWindow(prefs.digest_tz, now);
  const cal = localCalendar(prefs.digest_tz, now);

  // Self
  const selfRows = await loadActivity(userId, startUtc, endUtc, { type: "all" });
  const { summary: github, reposWithCommits } = await loadGitHubSummary(userId, startUtc, endUtc);
  const reposWithTokens = new Set(selfRows.map((r) => r.repo_name).filter((r): r is string => !!r));
  const missedRepos = [...reposWithCommits].filter((r) => !reposWithTokens.has(r)).sort();

  const byRepo = aggregateByRepo(selfRows);
  const byProject = await aggregateByProject(userId, byRepo);
  // If every repo lands in "(unassigned)" we hide the project section
  // entirely — it's just noise for users without projects defined.
  const projectsMeaningful = byProject.some((p) => p.project_id !== null);

  const self: DigestSelf = {
    bySource: aggregateBySource(selfRows),
    byRepo,
    byProject: projectsMeaningful ? byProject : [],
    github,
    missedRepos,
  };

  // Peers
  const grants = await loadActiveGrantsForViewer(userId);
  const peerByOwner = new Map<string, DigestPeer>();
  for (const g of grants) {
    if (!grantFires(g.granularity, cal)) continue;

    const rows = await loadActivity(g.owner_id, startUtc, endUtc, repoFilterFor(g));
    const showTokens = tokensVisible(g.fields);
    const showRepo = repoVisible(g.fields);
    const showSource = sourceVisible(g.fields);

    // If neither tokens nor repo nor source are shareable, skip — there
    // is nothing the digest can render that the grant authorizes.
    if (!showTokens && !showRepo && !showSource) continue;

    const bySource = showSource ? aggregateBySource(rows) : [];
    const byRepoFull = aggregateByRepo(rows);
    const byRepo = showRepo ? byRepoFull : null;
    // byProject only resolves names for projects the *owner* has membership
    // for — non-shared projects resolve to "(unassigned)" automatically.
    // We render it only when repo_name is in the grant; otherwise the
    // project labels would leak repo names indirectly via project membership.
    const byProject = showRepo ? await aggregateByProject(g.owner_id, byRepoFull) : [];

    // Strip cost when tokens aren't shareable.
    const stripCost = <T extends { cents: number | null }>(arr: T[]): T[] =>
      showTokens ? arr : arr.map((r) => ({ ...r, cents: null, tokens: 0 } as T));

    // Totals: derived only from authorized data — events count is always
    // safe; tokens/cents are zeroed when tokens aren't shareable.
    const totalEvents = rows.length;
    const totalTokens = showTokens
      ? rows.reduce((s, r) => s + (r.tokens_input ?? 0) + (r.tokens_output ?? 0), 0)
      : 0;
    const totalCents = showTokens
      ? byRepoFull.reduce((s, r) => s + (r.cents ?? 0), 0)
      : 0;
    const distinctRepos = showRepo ? new Set(rows.map((r) => r.repo_name).filter(Boolean)).size : null;
    const distinctTools = showSource ? new Set(rows.map((r) => r.source)).size : null;
    const totals: DigestPeerTotals = {
      events: totalEvents,
      tokens: totalTokens,
      cents: showTokens ? totalCents : null,
      repos: distinctRepos,
      tools: distinctTools,
    };

    // Merge with any earlier grant from the same owner (most permissive
    // fields win — already merged by Set semantics in the booleans above).
    const existing = peerByOwner.get(g.owner_id);
    const merged: DigestPeer = existing ?? {
      owner_id: g.owner_id,
      owner_email: g.owner_email,
      totals: { events: 0, tokens: 0, cents: null, repos: null, tools: null },
      bySource: [],
      byRepo: null,
      byProject: [],
      showCost: false,
    };
    merged.bySource = bySource.length ? stripCost(bySource) : merged.bySource;
    merged.byRepo = byRepo ? stripCost(byRepo) : merged.byRepo;
    merged.byProject = byProject.length ? (showTokens ? byProject : byProject.map((p) => ({ ...p, tokens: 0, cents: null }))) : merged.byProject;
    merged.showCost = merged.showCost || showTokens;
    // Most-permissive merge: take the larger of each totals field.
    merged.totals = {
      events: Math.max(merged.totals.events, totals.events),
      tokens: Math.max(merged.totals.tokens, totals.tokens),
      cents: maxNullable(merged.totals.cents, totals.cents),
      repos: maxNullable(merged.totals.repos, totals.repos),
      tools: maxNullable(merged.totals.tools, totals.tools),
    };
    peerByOwner.set(g.owner_id, merged);
  }
  const peers = [...peerByOwner.values()];

  const empty =
    self.bySource.length === 0 &&
    self.byRepo.length === 0 &&
    self.github.commits === 0 &&
    self.github.prs_opened === 0 &&
    self.github.prs_merged === 0 &&
    peers.every((p) => p.bySource.length === 0 && (p.byRepo ?? []).length === 0 && p.totals.events === 0);

  return {
    user_id: userId,
    email: prefs.digest_email ?? prefs.email,
    dateLabel: label,
    self,
    peers,
    empty,
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
