/**
 * current-user.ts — resolve the current request's local user_id.
 *
 * Bridges Supabase auth.users (cookie session) to our local "user" table.
 * On first sighting of a new email we upsert a row so peer-share grants
 * have a stable target.
 *
 * Returns null when:
 *   - no session AND no PULSE_DEV_USER fallback
 *   - Supabase session present but email is missing (shouldn't happen
 *     with magic-link auth, but the type system enforces the check)
 */

import { sql } from "./db";
import { server as supabaseServer } from "./supabase-server";

export interface CurrentUser {
  id: string;       // local user.id (UUID)
  email: string;
  name: string | null;
}

export async function currentUser(): Promise<CurrentUser | null> {
  // No Supabase env? Single-user dev mode — use the dev user shim.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    const dev = process.env.PULSE_DEV_USER;
    if (!dev) return null;
    return ensureLocalUser(`${dev}@dev.local`, dev);
  }

  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  const u = data.user;
  if (!u || !u.email) return null;

  return ensureLocalUser(u.email, (u.user_metadata?.name as string | undefined) ?? null);
}

/**
 * Ensure the user has at least one org. If none exists, auto-creates one
 * using the local-part of their email as the slug (lowercased, non-alnum
 * chars replaced with hyphens). Returns the org id.
 */
export async function ensureDefaultOrg(userId: string, email: string): Promise<string> {
  const db = sql();
  // Check if the user already has an org via membership.
  const [existing] = await db<{ org_id: string }[]>`
    SELECT org_id::text AS org_id
    FROM membership
    WHERE user_id = ${userId}
    LIMIT 1
  `;
  if (existing) return existing.org_id;

  // Derive slug from email local part.
  const localPart = email.split("@")[0] ?? email;
  const slug = localPart.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  // Upsert org (slug may collide if same email logs in on two concurrent
  // requests — ON CONFLICT keeps it idempotent).
  const [org] = await db<{ id: string }[]>`
    INSERT INTO org (name, slug)
    VALUES (${slug}, ${slug})
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id::text AS id
  `;

  await db`
    INSERT INTO membership (org_id, user_id, role)
    VALUES (${org.id}, ${userId}, 'owner')
    ON CONFLICT DO NOTHING
  `;
  return org.id;
}

/**
 * Upsert a local user row keyed on email and return it. Email is the
 * stable bridge between Supabase auth.users and our local user table —
 * Supabase guarantees email uniqueness within a project.
 */
export async function ensureLocalUser(
  email: string,
  name: string | null,
): Promise<CurrentUser> {
  const db = sql();
  const [row] = await db<{ id: string; email: string; name: string | null }[]>`
    INSERT INTO "user" (email, name)
    VALUES (${email}, ${name})
    ON CONFLICT (email) DO UPDATE
      SET name = COALESCE(EXCLUDED.name, "user".name)
    RETURNING id::text AS id, email, name
  `;
  return row;
}
