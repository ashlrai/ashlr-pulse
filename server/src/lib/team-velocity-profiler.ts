/**
 * team-velocity-profiler.ts — pure function that profiles team velocity
 * from peer-share daily aggregate data.
 *
 * Computes:
 *   • Per-user hourly cost/event density (from the heatmap implicit in daily
 *     aggregates — we spread daily sums across the user's activity hours and
 *     use the org-level heatmap as the distribution key when available).
 *   • Overlap windows: hours where all org members show non-trivial activity.
 *   • High-productivity zones: hours in the 90th percentile by cost/hour.
 *   • A human-readable recommendation string.
 *
 * Input type mirrors PeerShareDailyAggregate from peer-share-aggregate-refresh.
 * The function is pure (no DB calls) so it is easy to test and compose.
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
