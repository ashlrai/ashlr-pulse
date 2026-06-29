/**
 * anomaly-grouper.ts — Root-cause fingerprint clustering for anomaly incidents.
 *
 * Extends the basic kind-based grouping in anomaly-incident-grouping.ts with:
 *   1. A tighter 30-minute sliding window (vs 2-hour merge window).
 *   2. Root-cause fingerprinting: clusters anomalies by (repo, model, source)
 *      to determine whether co-occurring anomaly kinds share a common cause.
 *   3. Automatic root_cause_signal classification.
 *   4. Description narrative generation.
 *   5. severity_score computation (0-100 composite).
 *
 * Design
 * ──────
 *   All functions are pure (no DB, no network, no side effects).
 *   The caller (anomaly-persist cron or anomaly-remediation-db) passes the
 *   raw anomaly batch and gets back enriched incident metadata to persist.
 *
 * Root-cause signals
 * ──────────────────
 *   new_model_thrashing           — model_thrash present in cluster
 *   cost_spike_with_high_rejection_rate — cost_spike + tool_failure_rate together
 *   cache_miss_storm              — cache_miss_storm present (without cost spike)
 *   token_explosion_single_repo   — token_explosion scoped to a single repo
 *   peer_cost_divergence          — peer_divergence present
 *   tool_failure_cascade          — tool_failure_rate without cost spike
 *   generic_cost_spike            — cost_spike alone
 *
 * Privacy
 * ───────
 *   Only numeric/enum metadata is used. No user-content fields are read.
 */

import type { RealtimeAnomaly } from "./realtime-anomaly";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RootCauseSignal =
  | "new_model_thrashing"
  | "cost_spike_with_high_rejection_rate"
  | "cache_miss_storm"
  | "token_explosion_single_repo"
  | "peer_cost_divergence"
  | "tool_failure_cascade"
  | "generic_cost_spike";

/** All valid root_cause_signal values (for runtime validation). */
export const ROOT_CAUSE_SIGNAL_VALUES: RootCauseSignal[] = [
  "new_model_thrashing",
  "cost_spike_with_high_rejection_rate",
  "cache_miss_storm",
  "token_explosion_single_repo",
  "peer_cost_divergence",
  "tool_failure_cascade",
  "generic_cost_spike",
];

/**
 * A fingerprint identifies a cluster of related anomalies.
 * Two anomalies share a fingerprint when their (repo_name, model, source_key)
 * overlap sufficiently to suggest a common root cause.
 */
export interface AnomalyFingerprint {
  repo_name:  string | null;
  model:      string | null;
  source_key: string; // "org-wide" | repo_name | model
}

/**
 * Enriched incident metadata produced by the grouper.
 * The caller merges this into the anomaly_incident row before upserting.
 */
export interface IncidentEnrichment {
  description:       string;
  root_cause_signal: RootCauseSignal;
  severity_score:    number; // 0-100
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Sliding window for fingerprint clustering (ms). */
export const GROUPER_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/** Severity base scores. */
const SEVERITY_BASE: Record<string, number> = {
  high:   100,
  medium:  50,
  low:     20,
};

// ─── Fingerprint helpers ──────────────────────────────────────────────────────

/**
 * Build a stable fingerprint for a RealtimeAnomaly.
 *
 * The fingerprint captures the narrowest scope available:
 *   - repo_name when non-null (repo-scoped anomaly)
 *   - model from context when available (model-scoped)
 *   - "org-wide" otherwise
 */
export function buildFingerprint(anomaly: RealtimeAnomaly): AnomalyFingerprint {
  const model = typeof anomaly.context["model"] === "string"
    ? anomaly.context["model"] as string
    : null;

  const source_key = anomaly.repo_name ?? model ?? "org-wide";

  return {
    repo_name:  anomaly.repo_name,
    model,
    source_key,
  };
}

/**
 * Return true if two fingerprints are compatible for grouping.
 *
 * Compatible when:
 *   - Either is org-wide (source_key === "org-wide"), OR
 *   - Same repo_name, OR
 *   - Same model
 */
export function fingerprintsCompatible(a: AnomalyFingerprint, b: AnomalyFingerprint): boolean {
  if (a.source_key === "org-wide" || b.source_key === "org-wide") return true;
  if (a.repo_name !== null && a.repo_name === b.repo_name) return true;
  if (a.model !== null && a.model === b.model) return true;
  return false;
}

// ─── Clustering ───────────────────────────────────────────────────────────────

/**
 * A cluster is a group of anomalies that share a compatible fingerprint
 * and occurred within the 30-minute window.
 */
export interface AnomalyCluster {
  fingerprint: AnomalyFingerprint;
  anomalies:   RealtimeAnomaly[];
}

/**
 * Cluster a batch of anomalies by root-cause fingerprint within the
 * 30-minute sliding window.
 *
 * Algorithm:
 *   1. For each anomaly, build its fingerprint.
 *   2. Try to assign it to an existing cluster where all current members
 *      have compatible fingerprints.
 *   3. If no match, start a new cluster.
 *
 * Returns the list of clusters, each with >= 1 anomaly.
 *
 * @param anomalies  Anomalies from a single detection run (same timestamp window).
 */
export function clusterAnomalies(anomalies: RealtimeAnomaly[]): AnomalyCluster[] {
  const clusters: AnomalyCluster[] = [];

  for (const anomaly of anomalies) {
    const fp = buildFingerprint(anomaly);

    // Find existing cluster compatible with this anomaly's fingerprint.
    const match = clusters.find((c) => fingerprintsCompatible(c.fingerprint, fp));

    if (match) {
      match.anomalies.push(anomaly);
      // Narrow the cluster's fingerprint toward the most specific common scope.
      if (match.fingerprint.source_key === "org-wide" && fp.source_key !== "org-wide") {
        match.fingerprint = fp;
      }
    } else {
      clusters.push({ fingerprint: fp, anomalies: [anomaly] });
    }
  }

  return clusters;
}

// ─── Root-cause classification ────────────────────────────────────────────────

/**
 * Classify the root-cause signal for a cluster of anomalies.
 *
 * Priority order (first match wins):
 *   1. model_thrash present → new_model_thrashing
 *   2. cost_spike + tool_failure_rate → cost_spike_with_high_rejection_rate
 *   3. cache_miss_storm present → cache_miss_storm
 *   4. token_explosion, scoped to one repo → token_explosion_single_repo
 *   5. peer_divergence present → peer_cost_divergence
 *   6. tool_failure_rate (without cost spike) → tool_failure_cascade
 *   7. cost_spike alone → generic_cost_spike
 */
export function classifyRootCause(cluster: AnomalyCluster): RootCauseSignal {
  const kinds = new Set(cluster.anomalies.map((a) => a.kind));

  if (kinds.has("model_thrash")) return "new_model_thrashing";

  if (kinds.has("cost_spike") && kinds.has("tool_failure_rate")) {
    return "cost_spike_with_high_rejection_rate";
  }

  if (kinds.has("cache_miss_storm")) return "cache_miss_storm";

  if (kinds.has("token_explosion")) {
    // Check if all token_explosion anomalies are scoped to a single repo.
    const tokenExplosions = cluster.anomalies.filter((a) => a.kind === "token_explosion");
    const repos = new Set(tokenExplosions.map((a) => a.repo_name).filter(Boolean));
    if (repos.size === 1) return "token_explosion_single_repo";
  }

  if (kinds.has("peer_divergence")) return "peer_cost_divergence";

  if (kinds.has("tool_failure_rate")) return "tool_failure_cascade";

  return "generic_cost_spike";
}

// ─── Severity score ───────────────────────────────────────────────────────────

/**
 * Compute a 0-100 composite severity score for a cluster.
 *
 * Formula: max(member base scores) * min(1 + log2(event_count) * 0.1, 2.0)
 * capped at 100.
 *
 * Rationale: a single high-severity anomaly scores 100. Additional events
 * nudge the score up slightly (logarithmic) but can't exceed 100.
 */
export function computeSeverityScore(cluster: AnomalyCluster): number {
  if (cluster.anomalies.length === 0) return 0;

  const maxBase = Math.max(
    ...cluster.anomalies.map((a) => SEVERITY_BASE[a.severity] ?? 20),
  );

  const eventCount = cluster.anomalies.length;
  const scaleFactor = Math.min(1 + Math.log2(eventCount) * 0.1, 2.0);

  return Math.min(Math.round(maxBase * scaleFactor), 100);
}

// ─── Narrative generation ─────────────────────────────────────────────────────

/**
 * Generate a human-readable description for the incident cluster.
 *
 * The description follows the pattern:
 *   "<N> anomalies [in <repo>] [on <model>]: <signal description>"
 *
 * This is the text ops teams read to understand why an incident fired
 * without hunting through raw detection records.
 */
export function generateDescription(
  cluster: AnomalyCluster,
  signal: RootCauseSignal,
): string {
  const count = cluster.anomalies.length;
  const kinds = [...new Set(cluster.anomalies.map((a) => a.kind))];
  const repo  = cluster.fingerprint.repo_name;
  const model = cluster.fingerprint.model;

  const scope = repo
    ? ` in ${repo}`
    : model
      ? ` on ${model}`
      : "";

  const kindSummary = kinds.length === 1
    ? kindLabel(kinds[0])
    : `${kinds.slice(0, -1).map(kindLabel).join(", ")} and ${kindLabel(kinds[kinds.length - 1])}`;

  const signalNarrative = signalDescription(signal, cluster);

  return `${count} ${count === 1 ? "anomaly" : "anomalies"}${scope}: ${kindSummary}. ${signalNarrative}`;
}

function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    cost_spike:        "cost spike",
    token_explosion:   "token explosion",
    tool_failure_rate: "tool failures",
    model_thrash:      "model thrashing",
    cache_miss_storm:  "cache misses",
    peer_divergence:   "peer divergence",
  };
  return labels[kind] ?? kind;
}

function signalDescription(signal: RootCauseSignal, cluster: AnomalyCluster): string {
  switch (signal) {
    case "new_model_thrashing":
      return "Rapid model switching detected — likely router misconfiguration or unstable model selection logic.";

    case "cost_spike_with_high_rejection_rate":
      return "Cost is spiking alongside elevated tool-call failures — agents may be retrying failed calls, amplifying cost.";

    case "cache_miss_storm": {
      const missRate = cluster.anomalies
        .filter((a) => a.kind === "cache_miss_storm")
        .map((a) => typeof a.context["miss_rate"] === "number" ? a.context["miss_rate"] as number : null)
        .filter((r): r is number => r !== null)[0];
      const pct = missRate !== undefined ? ` (${Math.round(missRate * 100)}% miss rate)` : "";
      return `Cache reads are absent${pct} — prompts may lack static prefix structure or cache TTL has expired.`;
    }

    case "token_explosion_single_repo": {
      const repo = cluster.fingerprint.repo_name ?? "the repo";
      return `Unusually large context detected in ${repo} — check for runaway context accumulation or missing truncation.`;
    }

    case "peer_cost_divergence": {
      const outlier = cluster.anomalies
        .filter((a) => a.kind === "peer_divergence")
        .map((a) => a.context["outlier_owner"])
        .filter(Boolean)[0];
      const who = typeof outlier === "string" ? ` (${outlier})` : "";
      return `One team member${who} is consuming significantly more than peers — review their model selection and context size.`;
    }

    case "tool_failure_cascade":
      return "Tool-call failures are elevated — check API connectivity, rate limits, or tool configuration.";

    case "generic_cost_spike":
    default:
      return "Cost is elevated above the 7-day rolling average — review recent model selection and context lengths.";
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Enrich a cluster with root-cause signal, severity score, and description.
 *
 * This is the primary entry point called by the anomaly-persist cron after
 * groupAnomaliesToIncidents() to fill in the new enrichment columns.
 */
export function enrichCluster(cluster: AnomalyCluster): IncidentEnrichment {
  const signal         = classifyRootCause(cluster);
  const severity_score = computeSeverityScore(cluster);
  const description    = generateDescription(cluster, signal);

  return { description, root_cause_signal: signal, severity_score };
}

/**
 * Cluster and enrich a full batch of anomalies.
 *
 * Convenience wrapper used by unit tests and the persist cron.
 * Returns one enrichment per cluster in the same order as clusterAnomalies().
 */
export function clusterAndEnrich(
  anomalies: RealtimeAnomaly[],
): Array<{ cluster: AnomalyCluster; enrichment: IncidentEnrichment }> {
  const clusters = clusterAnomalies(anomalies);
  return clusters.map((cluster) => ({
    cluster,
    enrichment: enrichCluster(cluster),
  }));
}
