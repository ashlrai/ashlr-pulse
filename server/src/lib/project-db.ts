/**
 * project-db.ts — DB access for projects and project_repo.
 */

import { sql } from "./db";

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

export interface CreateProjectInput {
  org_id: string;
  name: string;
  kind: "saas" | "client" | "internal" | "experiment";
}

export async function createProject(input: CreateProjectInput): Promise<ProjectRow> {
  const db = sql();
  const [row] = await db<{ id: string; org_id: string; name: string; kind: string; created_at: string }[]>`
    INSERT INTO project (org_id, name, kind)
    VALUES (${input.org_id}, ${input.name}, ${input.kind})
    RETURNING id::text AS id, org_id::text AS org_id, name, kind, created_at
  `;
  return { ...row, repos: [] };
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
