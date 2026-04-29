/**
 * cron-runs.ts — telemetry for the in-process scheduler.
 *
 * `recordCronRun` is called from cron.ts after every tick (success or
 * failure). `getLastCronRun` powers the dashboard footer's
 * "last digest tick: 4m ago" indicator so a user can tell at a glance
 * whether the cron is alive without reading Railway logs.
 */

import { sql } from "./db";

export type CronEndpoint = "digest" | "github-sync";

export interface RecordCronRunInput {
  endpoint: CronEndpoint;
  status: number;
  elapsedMs: number;
  error?: string | null;
}

export async function recordCronRun(input: RecordCronRunInput): Promise<void> {
  const db = sql();
  await db`
    INSERT INTO cron_runs (endpoint, status, elapsed_ms, error)
    VALUES (
      ${input.endpoint},
      ${input.status},
      ${input.elapsedMs},
      ${input.error ?? null}
    )
  `;
}

export interface CronRunSummary {
  endpoint: CronEndpoint;
  status: number;
  elapsed_ms: number;
  error: string | null;
  created_at: string;
  seconds_ago: number;
}

export async function getLastCronRun(
  endpoint: CronEndpoint,
  now: Date = new Date(),
): Promise<CronRunSummary | null> {
  const db = sql();
  const rows = await db<{
    endpoint: CronEndpoint;
    status: number;
    elapsed_ms: number;
    error: string | null;
    created_at: string;
  }[]>`
    SELECT endpoint, status, elapsed_ms, error, created_at::text AS created_at
    FROM cron_runs
    WHERE endpoint = ${endpoint}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    ...r,
    seconds_ago: Math.max(0, Math.floor((now.getTime() - new Date(r.created_at).getTime()) / 1000)),
  };
}
