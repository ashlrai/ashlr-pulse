/**
 * team-velocity-profiler.ts — pure functions that profile team velocity
 * from peer-share daily aggregate data.
 *
 * Computes:
 *   • Per-user hourly cost/event density (from the heatmap implicit in daily
 *     aggregates — we spread daily sums across the user's activity hours and
 *     use the org-level heatmap as the distribution key when available).
 *   • Overlap windows: hours where all org members show non-trivial activity.
 *   • High-productivity zones: hours in the 90th percentile by cost/hour.
 *   • A human-readable recommendation string.
 *   • Per-developer 7-day rolling velocity vectors (commits/tokens/cost trend).
 *   • Pairwise compatibility scores (% time pairing, model preference alignment,
 *     cost-per-event divergence).
 *   • 2-hour-bucket "who was active with whom" heatmap (privacy-safe: only
 *     aggregate event counts per pair, no content).
 *
 * Input type mirrors PeerShareDailyAggregate from peer-share-aggregate-refresh.
 * All functions are pure (no DB calls) so they are easy to test and compose.
 *
 * Privacy floor: only aggregate cost/event counts per hour/user are used.
 * Individual events never flow through this function.
 */

/** A minimal subset of PeerShareDailyAggregate needed here. */
export interface AggregateInput {
  ownerId: string;
  date: string;           // "YYYY-MM-DD"
  costMillicents: number;
  eventCount: number;
}

/**
 * Per-user hourly profile: 24 slots (UTC hours 0–23), each containing
 * normalised activity weight derived from date-level aggregates distributed
 * by a flat prior (equal probability across all hours with activity).
 *
 * When heatmapWeights is provided it is used as the distribution key so
 * the spread respects the user's observed hour-of-day pattern.
 *
 * Shape: userHourlyWeight[userId][hour] = weight ∈ [0, 1].
 */
export interface UserHourlyProfile {
  userId: string;
  /** 24-element array; index = UTC hour. */
  costPerHour: number[];
  /** Total cost in millicents across the window. */
  totalCostMillicents: number;
  /** Total events across the window. */
  totalEvents: number;
}

export interface OverlapHour {
  hour: number;
  dayOfWeek: number;
  /** Probability that both (all) users are active (0–1). */
  prob: number;
  /** Sum of all users' cost/hour for this slot (millicents). */
  costPerHour: number;
}

export interface VelocityZone {
  /** UTC hour (0–23). */
  hour: number;
  /** Cost/hour in millicents. */
  costPerHour: number;
  /** True when this slot is in the 90th-percentile tier. */
  isHighProductivity: boolean;
}

export interface TeamVelocityProfile {
  /** Per-user hourly profiles. */
  userProfiles: UserHourlyProfile[];
  /** Hours (UTC) where ≥2 users show >0 activity probability (overlap). */
  overlaps: OverlapHour[];
  /** All 24 hourly slots, annotated with high-productivity flag. */
  zones: VelocityZone[];
  /** Human-readable window label, e.g. "10:00–15:00 UTC". */
  highProductivityWindow: string;
  /** Human-readable recommendation. */
  recommendation: string;
}

/**
 * Build a flat hourly distribution from daily aggregates.
 *
 * Without per-event timestamps we cannot know which hour within a day
 * a user was active. We distribute the daily cost/event count evenly
 * across the ACTIVE_HOURS window (09:00–18:00 UTC as a sensible prior)
 * unless the caller provides heatmapWeights[hour] (a 24-element array
 * where values sum to 1.0).
 *
 * When heatmapWeights is provided (derived from DashboardData.heatmap),
 * the distribution respects the user's observed hour-of-day pattern, which
 * significantly improves overlap accuracy for users in non-standard timezones.
 */
function buildHourlyProfile(
  userId: string,
  aggregates: AggregateInput[],
  windowDays: number,
  heatmapWeights?: number[],
): UserHourlyProfile {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000);
  const relevant = aggregates.filter(
    (a) => a.ownerId === userId && new Date(a.date) >= cutoff,
  );

  const totalCostMillicents = relevant.reduce((s, a) => s + a.costMillicents, 0);
  const totalEvents = relevant.reduce((s, a) => s + a.eventCount, 0);

  // Build weights: prefer caller-supplied heatmap, else uniform over 9–18.
  const weights = heatmapWeights ?? buildUniformWeights();
  const wSum = weights.reduce((s, w) => s + w, 0);
  const normalised = wSum > 0 ? weights.map((w) => w / wSum) : weights.map(() => 1 / 24);

  const costPerHour = normalised.map((w) => totalCostMillicents * w);

  return { userId, costPerHour, totalCostMillicents, totalEvents };
}

/** Uniform weight across the 9–18 UTC business window. */
function buildUniformWeights(): number[] {
  const w = Array(24).fill(0);
  for (let h = 9; h < 18; h++) w[h] = 1;
  return w;
}

/**
 * Find hours where every user in `profiles` has a non-zero cost/hour
 * weight. The overlap probability is the geometric mean of each user's
 * normalised per-hour weight, capped at 1.0.
 *
 * dayOfWeek is set to -1 (all days) because daily aggregates don't retain
 * per-day-of-week granularity.
 */
function computeOverlaps(profiles: UserHourlyProfile[]): OverlapHour[] {
  if (profiles.length < 2) return [];

  // Normalise each profile's cost vector to a probability vector [0,1].
  const probVectors: number[][] = profiles.map((p) => {
    const max = Math.max(...p.costPerHour, 1e-9);
    return p.costPerHour.map((c) => c / max);
  });

  const overlaps: OverlapHour[] = [];
  for (let hour = 0; hour < 24; hour++) {
    // Geometric mean of per-user probabilities.
    let logSum = 0;
    let anyZero = false;
    for (const pv of probVectors) {
      const p = pv[hour];
      if (p <= 0) { anyZero = true; break; }
      logSum += Math.log(p);
    }
    if (anyZero) continue;

    const prob = Math.exp(logSum / probVectors.length);
    if (prob < 0.05) continue; // below 5% — not meaningful overlap

    const costPerHour = profiles.reduce((s, p) => s + p.costPerHour[hour], 0);
    overlaps.push({ hour, dayOfWeek: -1, prob: Math.min(prob, 1), costPerHour });
  }

  return overlaps.sort((a, b) => b.prob - a.prob);
}

/**
 * Detect high-productivity zones: hours whose cost/hour exceeds the 90th
 * percentile across all 24 slots (considering the team aggregate).
 */
function computeZones(profiles: UserHourlyProfile[]): VelocityZone[] {
  const teamCostPerHour = Array(24).fill(0);
  for (const p of profiles) {
    for (let h = 0; h < 24; h++) teamCostPerHour[h] += p.costPerHour[h];
  }

  // 90th percentile threshold.
  const sorted = [...teamCostPerHour].sort((a, b) => a - b);
  const p90Index = Math.floor(sorted.length * 0.9);
  const p90Threshold = sorted[p90Index] ?? 0;

  return teamCostPerHour.map((cost, hour) => ({
    hour,
    costPerHour: cost,
    isHighProductivity: cost >= p90Threshold && cost > 0,
  }));
}

/** Format a UTC hour as "HH:00". */
function fmtHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

/** Build a contiguous window label from a sorted list of hours. */
function buildWindowLabel(hours: number[]): string {
  if (hours.length === 0) return "no clear window";
  const sorted = [...hours].sort((a, b) => a - b);
  const start = sorted[0];
  const end = sorted[sorted.length - 1] + 1;
  return `${fmtHour(start)}–${fmtHour(end)} UTC`;
}

/**
 * profileTeamVelocity — pure top-level function.
 *
 * @param aggregates  PeerShareDailyAggregate rows for all members of the org.
 * @param windowDays  Rolling window for analysis (default 30).
 * @param heatmapByUser  Optional map from userId → 24-element hourly weight
 *                       array (derived from DashboardData.heatmap per user).
 *                       When provided, overlap accuracy improves significantly.
 */
export function profileTeamVelocity(
  aggregates: AggregateInput[],
  windowDays = 30,
  heatmapByUser?: Map<string, number[]>,
): TeamVelocityProfile {
  // Collect unique user IDs present in the data.
  const userIds = [...new Set(aggregates.map((a) => a.ownerId))];

  // Build per-user hourly profiles.
  const userProfiles: UserHourlyProfile[] = userIds.map((uid) =>
    buildHourlyProfile(uid, aggregates, windowDays, heatmapByUser?.get(uid)),
  );

  const overlaps = computeOverlaps(userProfiles);
  const zones = computeZones(userProfiles);

  const highProdHours = zones
    .filter((z) => z.isHighProductivity)
    .map((z) => z.hour);
  const highProductivityWindow = buildWindowLabel(highProdHours);

  // Build recommendation.
  const overlapHours = overlaps.map((o) => o.hour).sort((a, b) => a - b);
  let recommendation: string;
  if (userProfiles.length < 2) {
    recommendation = "Add more team members to Pulse to see pairing recommendations.";
  } else if (overlaps.length === 0) {
    recommendation =
      "No clear overlap detected in the last " +
      windowDays +
      " days. Team members may be working in non-overlapping timezones — consider an async handoff window.";
  } else {
    const topOverlap = overlaps[0];
    const overlapWindow = buildWindowLabel(overlapHours.slice(0, 5));
    const probPct = Math.round(topOverlap.prob * 100);
    recommendation =
      `Best pairing window: ${overlapWindow} (${probPct}% co-activity probability). ` +
      `High-productivity zone: ${highProductivityWindow}. ` +
      (overlapHours.length >= 2
        ? `${overlapHours.length}h of daily overlap available for synchronous work.`
        : "Limited overlap — async-first workflow recommended.");
  }

  return { userProfiles, overlaps, zones, highProductivityWindow, recommendation };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extended types: velocity vectors, pairwise compatibility, pairing heatmap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extended aggregate input that carries optional per-day commit count,
 * dominant model, and repo slug for richer vector/compat computation.
 *
 * Fields are optional so callers that only have basic cost/event data still
 * work — missing fields are treated as zero / unknown.
 */
export interface ExtendedAggregateInput extends AggregateInput {
  /** Number of git commits for this owner on this date (optional). */
  commitCount?: number;
  /** Dominant model slug used on this date (e.g. "claude-opus-4-5"). */
  model?: string;
  /** Repository slug "org/repo" the events were attributed to. */
  repo?: string;
  /** Token count (input + output, raw) for the day. */
  tokenCount?: number;
}

/**
 * 7-day rolling velocity vector for a single developer.
 *
 * Each field is a 7-element array where index 0 = most recent day, 6 = oldest.
 * Suitable for rendering a sparkline or computing a trend slope.
 */
export interface VelocityVector {
  userId: string;
  /** Daily commit counts for the last 7 days (index 0 = most recent). */
  commits: number[];
  /** Daily token counts for the last 7 days. */
  tokens: number[];
  /** Daily cost in millicents for the last 7 days. */
  costMillicents: number[];
  /** Linear trend slope for cost (millicents/day). Positive = increasing. */
  costTrendSlope: number;
  /** Linear trend slope for tokens (tokens/day). */
  tokenTrendSlope: number;
  /** Average daily events over the window. */
  avgDailyEvents: number;
}

/**
 * Pairwise compatibility score between two developers.
 *
 * "Compatibility" is a composite of:
 *   1. Temporal overlap: % of 2h time buckets where both were active.
 *   2. Model preference alignment: 1 - Jensen-Shannon divergence of their
 *      model-usage distributions (0 = opposite, 1 = identical).
 *   3. Cost-per-event divergence: normalised absolute difference in their
 *      average cost-per-event (lower = more similar working style).
 *
 * compositeScore = 0.5 * overlapPct + 0.3 * modelAlignment + 0.2 * costSimilarity
 */
export interface PairCompatibility {
  userA: string;
  userB: string;
  /** Fraction of 2h buckets (over the analysis window) where both were active. */
  overlapPct: number;
  /** Model preference alignment score 0–1. */
  modelAlignment: number;
  /** Cost-per-event similarity score 0–1 (1 = identical avg cost). */
  costSimilarity: number;
  /** Composite compatibility score 0–1. */
  compositeScore: number;
  /** Top repos both users were active in (by combined event count). */
  sharedRepos: string[];
  /** Combined cost trend (millicents/day slope) for the pair. */
  combinedCostTrendSlope: number;
}

/**
 * A single cell in the pairing heatmap.
 *
 * The heatmap is indexed by (userA, userB, bucketIndex).
 * bucketIndex = Math.floor(utcHour / 2) ∈ 0..11 (12 two-hour buckets per day).
 * We aggregate across all days in the window so the value is the total
 * number of days where both users had events in that 2h slot.
 *
 * Privacy floor: only the count of co-active days is stored — no content.
 */
export interface PairingHeatmapCell {
  userA: string;
  userB: string;
  /** 2-hour bucket index 0–11. bucketStart = bucketIndex * 2 (UTC hour). */
  bucketIndex: number;
  /** Number of distinct dates where both userA and userB had activity in this bucket. */
  coActiveDays: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Velocity vector computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a simple linear trend slope via ordinary least squares.
 * Returns slope in units-per-day. Returns 0 if fewer than 2 points.
 */
function olsSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * computeVelocityVectors — pure function.
 *
 * For each unique owner in `aggregates`, build a 7-day rolling velocity
 * vector. Days with no data are treated as zero.
 *
 * @param aggregates  Extended aggregate rows (any window; only last 7d used).
 * @param referenceDate  Anchor date for "today" — defaults to now. Used in tests.
 */
export function computeVelocityVectors(
  aggregates: ExtendedAggregateInput[],
  referenceDate: Date = new Date(),
): VelocityVector[] {
  const userIds = [...new Set(aggregates.map((a) => a.ownerId))];
  const refMs = referenceDate.getTime();

  return userIds.map((uid) => {
    const commits = Array(7).fill(0);
    const tokens  = Array(7).fill(0);
    const costs   = Array(7).fill(0);
    let totalEvents = 0;

    for (const a of aggregates) {
      if (a.ownerId !== uid) continue;
      const dayMs = new Date(a.date).getTime();
      const daysAgo = Math.floor((refMs - dayMs) / 86_400_000);
      // index 0 = most recent day, 6 = 7 days ago
      if (daysAgo < 0 || daysAgo >= 7) continue;
      commits[daysAgo] += a.commitCount ?? 0;
      tokens[daysAgo]  += a.tokenCount ?? 0;
      costs[daysAgo]   += a.costMillicents;
      totalEvents      += a.eventCount;
    }

    // Reverse so oldest → newest for OLS (index 0 = oldest day).
    const costsAsc  = [...costs].reverse();
    const tokensAsc = [...tokens].reverse();

    return {
      userId:            uid,
      commits,
      tokens,
      costMillicents:    costs,
      costTrendSlope:    olsSlope(costsAsc),
      tokenTrendSlope:   olsSlope(tokensAsc),
      avgDailyEvents:    totalEvents / 7,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing heatmap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * binToPairingHeatmap — pure function.
 *
 * Groups activity by 2-hour UTC bucket per user per date, then counts
 * distinct dates where each ordered pair (userA < userB alphabetically)
 * were both active in the same bucket.
 *
 * Privacy floor: only aggregate event presence (boolean per bucket per day)
 * is used — event content, prompts, and individual counts never appear.
 *
 * @param aggregates  Rows that carry the date and ownerId. The 2h-bucket
 *                    assignment is derived from heatmapWeights when provided,
 *                    otherwise we use the same uniform 09–18 UTC prior as the
 *                    hourly profiler (bucket index = floor(hour/2)).
 * @param heatmapByUser  Optional map from userId → 24-element hourly weight.
 *                       Used to determine which 2h buckets the user was active
 *                       in on a given day (bucket active if weight > threshold).
 */
export function binToPairingHeatmap(
  aggregates: ExtendedAggregateInput[],
  heatmapByUser?: Map<string, number[]>,
): PairingHeatmapCell[] {
  // Build a set: for each (userId, date, bucketIndex) → was active?
  // active = has events on that date AND (bucket has weight or default business hours).

  const ACTIVE_THRESHOLD = 0.04; // min normalised weight to count as "active" in bucket

  // Gather unique (userId, date) pairs.
  type Key = string; // `${userId}:${date}:${bucketIndex}`
  const activeSet = new Set<Key>();

  // Collect distinct (userId, date) combos with non-zero events.
  const dateCombos = new Map<string, { uid: string; date: string; events: number }>();
  for (const a of aggregates) {
    if (a.eventCount <= 0) continue;
    const key = `${a.ownerId}::${a.date}`;
    const existing = dateCombos.get(key);
    if (!existing || a.eventCount > existing.events) {
      dateCombos.set(key, { uid: a.ownerId, date: a.date, events: a.eventCount });
    }
  }

  for (const { uid, date } of dateCombos.values()) {
    const weights = heatmapByUser?.get(uid) ?? buildUniformWeights24();
    const wSum = weights.reduce((s, w) => s + w, 0);
    const normalised = wSum > 0 ? weights.map((w) => w / wSum) : weights.map(() => 1 / 24);

    // Aggregate weight per 2h bucket.
    for (let bucket = 0; bucket < 12; bucket++) {
      const bucketWeight = normalised[bucket * 2] + normalised[bucket * 2 + 1];
      if (bucketWeight >= ACTIVE_THRESHOLD) {
        activeSet.add(`${uid}:${date}:${bucket}`);
      }
    }
  }

  // Collect all unique userIds and dates.
  const userIds = [...new Set(aggregates.map((a) => a.ownerId))].sort();
  const dates   = [...new Set(aggregates.map((a) => a.date))];

  // For each ordered pair, count co-active days per bucket.
  const cells: PairingHeatmapCell[] = [];

  for (let i = 0; i < userIds.length; i++) {
    for (let j = i + 1; j < userIds.length; j++) {
      const userA = userIds[i];
      const userB = userIds[j];

      for (let bucket = 0; bucket < 12; bucket++) {
        let coActiveDays = 0;
        for (const date of dates) {
          if (
            activeSet.has(`${userA}:${date}:${bucket}`) &&
            activeSet.has(`${userB}:${date}:${bucket}`)
          ) {
            coActiveDays++;
          }
        }
        if (coActiveDays > 0) {
          cells.push({ userA, userB, bucketIndex: bucket, coActiveDays });
        }
      }
    }
  }

  return cells;
}

/** Uniform weight across the 9–18 UTC business window (24 elements). */
function buildUniformWeights24(): number[] {
  const w = Array(24).fill(0);
  for (let h = 9; h < 18; h++) w[h] = 1;
  return w;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairwise compatibility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Jensen-Shannon divergence between two discrete probability distributions.
 * Both arrays must have the same length and sum to ~1.
 * Returns a value in [0, 1] (0 = identical, 1 = maximally different).
 */
function jsDivergence(p: number[], q: number[]): number {
  const n = p.length;
  if (n === 0) return 0;
  let jsd = 0;
  for (let i = 0; i < n; i++) {
    const pi = p[i];
    const qi = q[i];
    const m  = (pi + qi) / 2;
    if (m > 0) {
      if (pi > 0) jsd += pi * Math.log2(pi / m);
      if (qi > 0) jsd += qi * Math.log2(qi / m);
    }
  }
  // JSD is in [0, 1] when using log2; clamp to handle floating-point drift.
  return Math.min(Math.max(jsd / 2, 0), 1);
}

/**
 * computePairCompatibility — pure function.
 *
 * For every ordered pair (userA < userB) in the aggregate data, compute a
 * composite compatibility score using:
 *   - temporal overlap (from the pairing heatmap cells)
 *   - model preference alignment (JSD of model distributions)
 *   - cost-per-event divergence
 *
 * @param aggregates  Extended aggregate rows; repos and models used if present.
 * @param heatmapCells  Pre-computed heatmap cells (from binToPairingHeatmap).
 * @param windowDays  Rolling window used for the analysis (for total bucket count).
 */
export function computePairCompatibility(
  aggregates: ExtendedAggregateInput[],
  heatmapCells: PairingHeatmapCell[],
  windowDays = 30,
): PairCompatibility[] {
  const userIds = [...new Set(aggregates.map((a) => a.ownerId))].sort();
  if (userIds.length < 2) return [];

  // Total possible co-active bucket-days (12 buckets × windowDays).
  const totalBuckets = 12 * windowDays;

  // Build per-user model distribution.
  const modelDist = new Map<string, Map<string, number>>();
  // Build per-user cost-per-event.
  const userTotals = new Map<string, { cost: number; events: number }>();
  // Build per-user active repos.
  const userRepos = new Map<string, Map<string, number>>();

  for (const a of aggregates) {
    if (!modelDist.has(a.ownerId)) modelDist.set(a.ownerId, new Map());
    if (!userTotals.has(a.ownerId)) userTotals.set(a.ownerId, { cost: 0, events: 0 });
    if (!userRepos.has(a.ownerId))  userRepos.set(a.ownerId, new Map());

    const totals = userTotals.get(a.ownerId)!;
    totals.cost   += a.costMillicents;
    totals.events += a.eventCount;

    if (a.model) {
      const dist = modelDist.get(a.ownerId)!;
      dist.set(a.model, (dist.get(a.model) ?? 0) + (a.tokenCount ?? a.eventCount));
    }
    if (a.repo) {
      const repos = userRepos.get(a.ownerId)!;
      repos.set(a.repo, (repos.get(a.repo) ?? 0) + a.eventCount);
    }
  }

  // Normalise model distributions.
  function normaliseModelDist(uid: string): Map<string, number> {
    const dist = modelDist.get(uid) ?? new Map<string, number>();
    const total = [...dist.values()].reduce((s, v) => s + v, 0);
    if (total === 0) return dist;
    const out = new Map<string, number>();
    for (const [m, v] of dist) out.set(m, v / total);
    return out;
  }

  // Build pairwise cells index.
  type PairKey = string;
  const pairCells = new Map<PairKey, number>();
  for (const cell of heatmapCells) {
    const key: PairKey = `${cell.userA}::${cell.userB}`;
    pairCells.set(key, (pairCells.get(key) ?? 0) + cell.coActiveDays);
  }

  const results: PairCompatibility[] = [];

  for (let i = 0; i < userIds.length; i++) {
    for (let j = i + 1; j < userIds.length; j++) {
      const userA = userIds[i];
      const userB = userIds[j];

      // 1. Temporal overlap.
      const pairKey: PairKey = `${userA}::${userB}`;
      const coActiveBuckets = pairCells.get(pairKey) ?? 0;
      const overlapPct = Math.min(coActiveBuckets / totalBuckets, 1);

      // 2. Model alignment.
      const distA = normaliseModelDist(userA);
      const distB = normaliseModelDist(userB);
      const allModels = [...new Set([...distA.keys(), ...distB.keys()])].sort();
      let modelAlignment = 1; // default: identical (both may have no model data)
      if (allModels.length > 0) {
        const pVec = allModels.map((m) => distA.get(m) ?? 0);
        const qVec = allModels.map((m) => distB.get(m) ?? 0);
        modelAlignment = 1 - jsDivergence(pVec, qVec);
      }

      // 3. Cost-per-event similarity.
      const tA = userTotals.get(userA) ?? { cost: 0, events: 0 };
      const tB = userTotals.get(userB) ?? { cost: 0, events: 0 };
      const cpeA = tA.events > 0 ? tA.cost / tA.events : 0;
      const cpeB = tB.events > 0 ? tB.cost / tB.events : 0;
      const cpeMax = Math.max(cpeA, cpeB, 1e-9);
      const costSimilarity = 1 - Math.abs(cpeA - cpeB) / cpeMax;

      // 4. Composite.
      const compositeScore = 0.5 * overlapPct + 0.3 * modelAlignment + 0.2 * costSimilarity;

      // 5. Shared repos (union of repos both users touched, sorted by combined count).
      const reposA = userRepos.get(userA) ?? new Map<string, number>();
      const reposB = userRepos.get(userB) ?? new Map<string, number>();
      const sharedRepoCounts = new Map<string, number>();
      for (const [repo, cnt] of reposA) {
        if (reposB.has(repo)) sharedRepoCounts.set(repo, cnt + (reposB.get(repo) ?? 0));
      }
      const sharedRepos = [...sharedRepoCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([repo]) => repo);

      // 6. Combined cost trend slope (sum of individual slopes).
      const vecA = computeVelocityVectors(aggregates.filter((a) => a.ownerId === userA));
      const vecB = computeVelocityVectors(aggregates.filter((a) => a.ownerId === userB));
      const combinedCostTrendSlope = (vecA[0]?.costTrendSlope ?? 0) + (vecB[0]?.costTrendSlope ?? 0);

      results.push({
        userA, userB,
        overlapPct,
        modelAlignment,
        costSimilarity,
        compositeScore,
        sharedRepos,
        combinedCostTrendSlope,
      });
    }
  }

  return results.sort((a, b) => b.compositeScore - a.compositeScore);
}
