/**
 * dashboard-view-db.ts — CRUD for the per-user "saved views" tab strip
 * at the top of /app.
 *
 * View filters are persisted as JSONB. We validate the shape both ways:
 * inputs from the API are coerced into a canonical object before
 * INSERT; outputs are typed at the boundary so the page component sees
 * a clean shape.
 *
 * Privacy: dashboard_view rows are user-scoped (FK to user.id with
 * ON DELETE CASCADE). They never appear in peer_share or any
 * cross-user surface.
 */

import { sql } from "@/lib/db";

export interface ViewFilter {
  /** Window in days; mirrors the ?win= query string. */
  win: "7" | "14" | "30" | "90";
  repos: string[];
  models: string[];
  sources: string[];
  project: string | null;
}

export interface DashboardView {
  id: string;
  user_id: string;
  name: string;
  filter: ViewFilter;
  created_at: string;
}

const ALLOWED_WIN = new Set(["7", "14", "30", "90"]);
const ALLOWED_SOURCES = new Set([
  "claude_code", "cursor", "copilot", "wakatime", "git", "shell", "ashlr_plugin", "codex",
]);

/**
 * Coerce arbitrary JSON input into a canonical ViewFilter. Unknown
 * fields are dropped. Bad types are coerced or replaced with safe
 * defaults so the function never throws.
 */
export function normalizeFilter(input: unknown): ViewFilter {
  const obj = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const win = typeof obj.win === "string" && ALLOWED_WIN.has(obj.win) ? obj.win as ViewFilter["win"] : "14";
  const repos   = strArray(obj.repos);
  const models  = strArray(obj.models);
  const sources = strArray(obj.sources).filter((s) => ALLOWED_SOURCES.has(s));
  const project = typeof obj.project === "string" && obj.project.length > 0 ? obj.project : null;
  return { win, repos, models, sources, project };
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 32);
}

/** All saved views for a user, oldest first (left-to-right in the tab strip). */
export async function listViews(userId: string): Promise<DashboardView[]> {
  const db = sql();
  const rows = await db<{
    id: string;
    user_id: string;
    name: string;
    filter_json: ViewFilter;
    created_at: string;
  }[]>`
    SELECT id::text, user_id::text, name, filter_json, created_at::text
    FROM dashboard_view
    WHERE user_id = ${userId}::uuid
    ORDER BY created_at ASC
    LIMIT 32
  `;
  return rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    name: r.name,
    filter: normalizeFilter(r.filter_json),
    created_at: r.created_at,
  }));
}

export async function getView(userId: string, id: string): Promise<DashboardView | null> {
  const db = sql();
  const rows = await db<{
    id: string; user_id: string; name: string; filter_json: ViewFilter; created_at: string;
  }[]>`
    SELECT id::text, user_id::text, name, filter_json, created_at::text
    FROM dashboard_view
    WHERE user_id = ${userId}::uuid AND id = ${id}::uuid
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return {
    id: rows[0].id,
    user_id: rows[0].user_id,
    name: rows[0].name,
    filter: normalizeFilter(rows[0].filter_json),
    created_at: rows[0].created_at,
  };
}

/** Create a view. Returns the row, or null if the name conflicts. */
export async function createView(
  userId: string,
  name: string,
  rawFilter: unknown,
): Promise<DashboardView | null> {
  if (typeof name !== "string" || name.trim().length === 0) return null;
  const trimmed = name.trim().slice(0, 48);
  const filter = normalizeFilter(rawFilter);
  const db = sql();
  try {
    const rows = await db<{
      id: string; user_id: string; name: string; filter_json: ViewFilter; created_at: string;
    }[]>`
      INSERT INTO dashboard_view (user_id, name, filter_json)
      VALUES (${userId}::uuid, ${trimmed}, ${JSON.stringify(filter)}::jsonb)
      RETURNING id::text, user_id::text, name, filter_json, created_at::text
    `;
    if (rows.length === 0) return null;
    return {
      id: rows[0].id,
      user_id: rows[0].user_id,
      name: rows[0].name,
      filter: normalizeFilter(rows[0].filter_json),
      created_at: rows[0].created_at,
    };
  } catch {
    // Unique violation (name conflict) or any other constraint error —
    // null lets the route render a 409 cleanly.
    return null;
  }
}

export async function deleteView(userId: string, id: string): Promise<boolean> {
  const db = sql();
  const rows = await db`
    DELETE FROM dashboard_view
    WHERE user_id = ${userId}::uuid AND id = ${id}::uuid
    RETURNING id
  `;
  return rows.count > 0;
}

/** Build a /app URL from a filter. The query keys mirror page.tsx's
 *  searchParams — keep them in sync. */
export function viewToHref(filter: ViewFilter): string {
  const qs = new URLSearchParams();
  if (filter.win !== "14") qs.set("win", filter.win);
  for (const r of filter.repos)   qs.append("repo", r);
  for (const m of filter.models)  qs.append("model", m);
  for (const s of filter.sources) qs.append("source", s);
  if (filter.project) qs.set("project", filter.project);
  const s = qs.toString();
  return s ? `/app?${s}` : "/app";
}
