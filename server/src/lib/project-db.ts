/**
 * project-db.ts — DB access for projects and project_repo.
 */

import { sql } from "./db";
import { countProjects } from "./org-db";
import { limitsFor, PlanGateError, type OrgPlanRef } from "./plan-gate";

export interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  kind: string;
  created_at: string;
  repos: string[];
}

/** List all projects the user is a member of (via membership → org → project). */
export async function listProjects(userId: string): Promise<ProjectRow[]> {
  const db = sql();
  const rows = await db<{ id: string; org_id: string; name: string; kind: string; created_at: string; repos: string[] | null }[]>`
    SELECT
      p.id::text     AS id,
      p.org_id::text AS org_id,
      p.name,
      p.kind,
      p.created_at,
      COALESCE(
        ARRAY_AGG(pr.repo_name ORDER BY pr.repo_name) FILTER (WHERE pr.repo_name IS NOT NULL),
        ARRAY[]::text[]
      ) AS repos
    FROM project p
    JOIN membership m ON m.org_id = p.org_id AND m.user_id = ${userId}
    LEFT JOIN project_repo pr ON pr.project_id = p.id
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `;
  return rows.map((r) => ({ ...r, repos: r.repos ?? [] }));
}

/**
 * Load a single project the user has visibility into (membership in
 * the same org). Returns null when no such project exists or the user
 * isn't a member — both look like 404 to the caller.
 */
export async function getProjectByIdForUser(
  projectId: string,
  userId: string,
): Promise<ProjectRow | null> {
  const db = sql();
  const rows = await db<{ id: string; org_id: string; name: string; kind: string; created_at: string; repos: string[] | null }[]>`
    SELECT
      p.id::text     AS id,
      p.org_id::text AS org_id,
      p.name,
      p.kind,
      p.created_at,
      COALESCE(
        ARRAY_AGG(pr.repo_name ORDER BY pr.repo_name) FILTER (WHERE pr.repo_name IS NOT NULL),
        ARRAY[]::text[]
      ) AS repos
    FROM project p
    JOIN membership m ON m.org_id = p.org_id AND m.user_id = ${userId}::uuid
    LEFT JOIN project_repo pr ON pr.project_id = p.id
    WHERE p.id = ${projectId}::uuid
    GROUP BY p.id
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  return { ...r, repos: r.repos ?? [] };
}

export interface ProjectDetailRepoRow {
  repo: string;
  events: number;
  tokens: number;
  cents: number;
}

export interface ProjectDetailDayRow {
  bucket: string;
  cents: number;
  tokens: number;
}

export interface ProjectDetailModelRow {
  model: string;
  events: number;
  tokens: number;
  cents: number;
}

/**
 * Load the per-project drill-down: per-repo, per-day, per-model
 * aggregates over the last `days` days. Filtered by both project_repo
 * membership AND user_id so a peer's spans don't leak in.
 */
export async function loadProjectDetail(
  projectId: string,
  userId: string,
  days: number,
): Promise<{
  byRepo: ProjectDetailRepoRow[];
  byDay: ProjectDetailDayRow[];
  byModel: ProjectDetailModelRow[];
}> {
  const db = sql();
  const byRepo = await db<ProjectDetailRepoRow[]>`
    SELECT
      ae.repo_name AS repo,
      COUNT(*)::int AS events,
      COALESCE(SUM(COALESCE(ae.tokens_input,0) + COALESCE(ae.tokens_output,0)), 0)::int AS tokens,
      ROUND(COALESCE(SUM(ae.cost_millicents),0) / 1000.0)::int AS cents
    FROM activity_event ae
    JOIN project_repo pr ON pr.repo_name = ae.repo_name AND pr.project_id = ${projectId}::uuid
    WHERE ae.user_id = ${userId}::uuid
      AND ae.ts >= NOW() - (${days}::int || ' days')::interval
    GROUP BY ae.repo_name
    ORDER BY cents DESC NULLS LAST
  `;
  const byDay = await db<ProjectDetailDayRow[]>`
    SELECT
      to_char(date_trunc('day', ae.ts), 'YYYY-MM-DD') AS bucket,
      ROUND(COALESCE(SUM(ae.cost_millicents),0) / 1000.0)::int AS cents,
      COALESCE(SUM(COALESCE(ae.tokens_input,0) + COALESCE(ae.tokens_output,0)), 0)::int AS tokens
    FROM activity_event ae
    JOIN project_repo pr ON pr.repo_name = ae.repo_name AND pr.project_id = ${projectId}::uuid
    WHERE ae.user_id = ${userId}::uuid
      AND ae.ts >= NOW() - (${days}::int || ' days')::interval
    GROUP BY 1
    ORDER BY 1 ASC
  `;
  const byModel = await db<ProjectDetailModelRow[]>`
    SELECT
      COALESCE(ae.model, '(unknown)') AS model,
      COUNT(*)::int AS events,
      COALESCE(SUM(COALESCE(ae.tokens_input,0) + COALESCE(ae.tokens_output,0)), 0)::int AS tokens,
      ROUND(COALESCE(SUM(ae.cost_millicents),0) / 1000.0)::int AS cents
    FROM activity_event ae
    JOIN project_repo pr ON pr.repo_name = ae.repo_name AND pr.project_id = ${projectId}::uuid
    WHERE ae.user_id = ${userId}::uuid
      AND ae.ts >= NOW() - (${days}::int || ' days')::interval
    GROUP BY 1
    ORDER BY cents DESC NULLS LAST
    LIMIT 10
  `;
  return { byRepo, byDay, byModel };
}

export interface CreateProjectInput {
  org_id: string;
  name: string;
  kind: "saas" | "client" | "internal" | "experiment";
}

/**
 * Create a project. Pass `org` to enforce the plan-gate cap before
 * inserting. When `org` is omitted the cap is skipped (used internally
 * from server actions that already validated the limit upstream).
 *
 * Throws PlanGateError (HTTP 402) when the org is on a plan whose
 * max_projects limit is already reached.
 */
export async function createProject(
  input: CreateProjectInput,
  org?: OrgPlanRef,
): Promise<ProjectRow> {
  // Gate 2: project cap.
  if (org) {
    const limits = limitsFor(org);
    if (Number.isFinite(limits.max_projects)) {
      const existing = await countProjects(input.org_id);
      if (existing >= limits.max_projects) {
        throw new PlanGateError(
          `Free tier capped at ${limits.max_projects} project. Upgrade to Pro at /billing.`,
          402,
        );
      }
    }
  }

  const db = sql();
  const [row] = await db<{ id: string; org_id: string; name: string; kind: string; created_at: string }[]>`
    INSERT INTO project (org_id, name, kind)
    VALUES (${input.org_id}, ${input.name}, ${input.kind})
    RETURNING id::text AS id, org_id::text AS org_id, name, kind, created_at
  `;
  return { ...row, repos: [] };
}

/**
 * Create a project AND attach a list of repos in a single transaction.
 * Used by the "create project from prefix" one-click flow.
 *
 * Pass `org` to enforce the plan-gate cap before inserting.
 */
export async function createProjectWithRepos(
  input: CreateProjectInput,
  repoNames: string[],
  org?: OrgPlanRef,
): Promise<ProjectRow> {
  // Gate 2: project cap — check before opening the transaction.
  if (org) {
    const limits = limitsFor(org);
    if (Number.isFinite(limits.max_projects)) {
      const existing = await countProjects(input.org_id);
      if (existing >= limits.max_projects) {
        throw new PlanGateError(
          `Free tier capped at ${limits.max_projects} project. Upgrade to Pro at /billing.`,
          402,
        );
      }
    }
  }

  const db = sql();
  return db.begin(async (tx) => {
    const [proj] = await tx<{ id: string; org_id: string; name: string; kind: string; created_at: string }[]>`
      INSERT INTO project (org_id, name, kind)
      VALUES (${input.org_id}, ${input.name}, ${input.kind})
      RETURNING id::text AS id, org_id::text AS org_id, name, kind, created_at
    `;
    if (repoNames.length > 0) {
      const rows = repoNames.map((repo_name) => ({ project_id: proj.id, repo_name }));
      await tx`
        INSERT INTO project_repo ${tx(rows, ["project_id", "repo_name"])}
        ON CONFLICT DO NOTHING
      `;
    }
    return { ...proj, repos: repoNames.slice().sort() };
  });
}

/** Add a repo to a project. Returns false if the membership check fails. */
export async function addProjectRepo(
  projectId: string,
  repoName: string,
  userId: string,
): Promise<boolean> {
  const db = sql();
  // Verify the user is a member of the project's org.
  const [check] = await db<{ ok: boolean }[]>`
    SELECT TRUE AS ok
    FROM project p
    JOIN membership m ON m.org_id = p.org_id AND m.user_id = ${userId}
    WHERE p.id = ${projectId}
    LIMIT 1
  `;
  if (!check) return false;

  await db`
    INSERT INTO project_repo (project_id, repo_name)
    VALUES (${projectId}, ${repoName})
    ON CONFLICT DO NOTHING
  `;
  return true;
}

/** Remove a repo from a project. Returns false if not found or not authorized. */
export async function removeProjectRepo(
  projectId: string,
  repoName: string,
  userId: string,
): Promise<boolean> {
  const db = sql();
  // Verify the user is a member of the project's org.
  const [check] = await db<{ ok: boolean }[]>`
    SELECT TRUE AS ok
    FROM project p
    JOIN membership m ON m.org_id = p.org_id AND m.user_id = ${userId}
    WHERE p.id = ${projectId}
    LIMIT 1
  `;
  if (!check) return false;

  const result = await db`
    DELETE FROM project_repo
    WHERE project_id = ${projectId} AND repo_name = ${repoName}
  `;
  return result.count === 1;
}

/**
 * All repos this user has activity in OR has connected via GitHub, that
 * aren't already assigned to any project. The driver of the
 * "unassigned repos" panel on /projects so users don't have to remember
 * + retype repo names.
 */
export async function listUnassignedRepos(userId: string): Promise<string[]> {
  const db = sql();
  const rows = await db<{ repo_name: string }[]>`
    WITH known AS (
      SELECT DISTINCT repo_name
      FROM activity_event
      WHERE user_id = ${userId} AND repo_name IS NOT NULL
      UNION
      SELECT DISTINCT gr.full_name AS repo_name
      FROM github_repo gr
      JOIN github_account ga ON ga.id = gr.account_id
      WHERE ga.user_id = ${userId}::uuid
    ),
    assigned AS (
      SELECT DISTINCT pr.repo_name
      FROM project_repo pr
      JOIN project p     ON p.id = pr.project_id
      JOIN membership m  ON m.org_id = p.org_id AND m.user_id = ${userId}
    )
    SELECT k.repo_name
    FROM known k
    LEFT JOIN assigned a ON a.repo_name = k.repo_name
    WHERE a.repo_name IS NULL
    ORDER BY k.repo_name
  `;
  return rows.map((r) => r.repo_name);
}

/**
 * Cluster unassigned repos by their common prefix (the part before the
 * first `-`, `_`, or `/owner/`-strip). Returns groups of >= 2 repos so
 * we can suggest "create a project + bulk-add these N repos" without
 * spamming single-repo suggestions.
 *
 * Examples (repo names):
 *   client-foo, client-bar, client-baz   → "client" → 3
 *   saas-api, saas-web                   → "saas" → 2
 *   ashlr-pulse, ashlr-cotidie           → "ashlr" → 2  (org-prefix; user can ignore)
 *   one-off-thing                        → not grouped (n=1)
 */
export interface PrefixCluster {
  prefix: string;
  repos: string[];
}

export function clusterByPrefix(repos: string[]): PrefixCluster[] {
  const buckets = new Map<string, string[]>();
  for (const full of repos) {
    // Strip "org/" if present so prefixes match across forks/orgs.
    const local = full.includes("/") ? full.split("/").slice(1).join("/") : full;
    const m = local.match(/^([a-z0-9]{2,})[-_]/i);
    const prefix = m ? m[1].toLowerCase() : null;
    if (!prefix) continue;
    if (!buckets.has(prefix)) buckets.set(prefix, []);
    buckets.get(prefix)!.push(full);
  }
  return [...buckets.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([prefix, list]) => ({ prefix, repos: list.sort() }))
    .sort((a, b) => b.repos.length - a.repos.length);
}

/**
 * Aggregate yesterday's per-repo data into per-project buckets. Repos
 * not assigned to any project bubble up under "(unassigned)". Used by
 * the digest's optional "by project" section.
 */
export interface ProjectAgg {
  project_id: string | null;
  project_name: string;
  repos: { repo: string; events: number; tokens: number; cents: number | null }[];
  events: number;
  tokens: number;
  cents: number | null;
}

export async function aggregateByProject(
  userId: string,
  byRepo: { repo: string; events: number; tokens: number; cents: number | null }[],
): Promise<ProjectAgg[]> {
  if (byRepo.length === 0) return [];
  const db = sql();
  const repoNames = byRepo.map((r) => r.repo);
  const map = await db<{ repo_name: string; project_id: string; project_name: string }[]>`
    SELECT pr.repo_name, p.id::text AS project_id, p.name AS project_name
    FROM project_repo pr
    JOIN project p    ON p.id = pr.project_id
    JOIN membership m ON m.org_id = p.org_id AND m.user_id = ${userId}
    WHERE pr.repo_name = ANY(${repoNames})
  `;
  const repoToProject = new Map<string, { id: string; name: string }>();
  for (const r of map) repoToProject.set(r.repo_name, { id: r.project_id, name: r.project_name });

  const agg = new Map<string, ProjectAgg>();
  for (const r of byRepo) {
    const proj = repoToProject.get(r.repo);
    const key = proj?.id ?? "__unassigned__";
    const cur = agg.get(key) ?? {
      project_id: proj?.id ?? null,
      project_name: proj?.name ?? "(unassigned)",
      repos: [],
      events: 0,
      tokens: 0,
      cents: null,
    };
    cur.repos.push(r);
    cur.events += r.events;
    cur.tokens += r.tokens;
    if (r.cents != null) cur.cents = (cur.cents ?? 0) + r.cents;
    agg.set(key, cur);
  }
  return [...agg.values()].sort((a, b) => b.tokens - a.tokens);
}
