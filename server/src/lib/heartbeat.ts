/**
 * heartbeat.ts — agent liveness tracking.
 *
 * The Rust agent POSTs /api/agent/heartbeat every ~60s with its PAT.
 * We upsert the agent_heartbeat row (PK on pat_hash). The dashboard
 * reads getAgentStatus() to render the "alive 30s ago" / "SILENT 4h"
 * badge.
 */

import { sql } from "./db";

export interface RecordHeartbeatInput {
  patHash: string;
  userId: string;
  agentLabel?: string | null;
  agentVersion?: string | null;
}

export async function recordHeartbeat(input: RecordHeartbeatInput): Promise<void> {
  const db = sql();
  await db`
    INSERT INTO agent_heartbeat (pat_hash, user_id, agent_label, agent_version, last_heartbeat_at)
    VALUES (
      ${input.patHash},
      ${input.userId}::uuid,
      ${input.agentLabel ?? null},
      ${input.agentVersion ?? null},
      NOW()
    )
    ON CONFLICT (pat_hash) DO UPDATE
      SET last_heartbeat_at = NOW(),
          agent_label       = COALESCE(EXCLUDED.agent_label,   agent_heartbeat.agent_label),
          agent_version     = COALESCE(EXCLUDED.agent_version, agent_heartbeat.agent_version)
  `;
}

export interface AgentStatus {
  /** Most recent heartbeat across all of this user's agents, or null. */
  last_heartbeat_at: string | null;
  /** Seconds since `last_heartbeat_at`. Null when no heartbeats ever. */
  seconds_ago: number | null;
  /** All agents the user has, newest-first. */
  agents: Array<{
    label: string | null;
    version: string | null;
    last_heartbeat_at: string;
    seconds_ago: number;
  }>;
}

export async function getAgentStatus(
  userId: string,
  now: Date = new Date(),
): Promise<AgentStatus> {
  const db = sql();
  const rows = await db<{
    agent_label: string | null;
    agent_version: string | null;
    last_heartbeat_at: string;
  }[]>`
    SELECT agent_label, agent_version, last_heartbeat_at::text AS last_heartbeat_at
    FROM agent_heartbeat
    WHERE user_id = ${userId}::uuid
    ORDER BY last_heartbeat_at DESC
  `;
  if (rows.length === 0) {
    return { last_heartbeat_at: null, seconds_ago: null, agents: [] };
  }
  const nowMs = now.getTime();
  const agents = rows.map((r) => ({
    label: r.agent_label,
    version: r.agent_version,
    last_heartbeat_at: r.last_heartbeat_at,
    seconds_ago: Math.max(0, Math.floor((nowMs - new Date(r.last_heartbeat_at).getTime()) / 1000)),
  }));
  return {
    last_heartbeat_at: agents[0].last_heartbeat_at,
    seconds_ago: agents[0].seconds_ago,
    agents,
  };
}

/**
 * Bucket agents by health state for the dashboard color code.
 *   alive: < 5 min
 *   stale: 5–30 min
 *   silent: > 30 min OR never seen
 */
export type HealthBucket = "alive" | "stale" | "silent";

export function bucketFor(secondsAgo: number | null): HealthBucket {
  if (secondsAgo == null) return "silent";
  if (secondsAgo < 5 * 60) return "alive";
  if (secondsAgo < 30 * 60) return "stale";
  return "silent";
}

/** Human-readable "30s" / "4m" / "2h" / "3d". */
export function fmtAgo(secondsAgo: number | null): string {
  if (secondsAgo == null) return "never";
  if (secondsAgo < 60) return `${secondsAgo}s`;
  if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)}m`;
  if (secondsAgo < 86400) return `${Math.floor(secondsAgo / 3600)}h`;
  return `${Math.floor(secondsAgo / 86400)}d`;
}
