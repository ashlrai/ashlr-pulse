/**
 * intent-db.ts — read/write the weekly intent note.
 *
 * One row per (user, week_start). Upsert on user_id+week_start; the
 * /attention page renders the current week's note and shows the diff
 * against where effort actually landed.
 */

import { sql } from "./db";

export interface IntentNote {
  id: string;
  week_start: string; // YYYY-MM-DD (UTC date)
  body: string;
  created_at: string;
  updated_at: string;
}

/**
 * UTC Monday of the week containing `now`. We use UTC so notes line up
 * across timezones; users on different timezones will see the same
 * "this week" boundary on Sunday afternoon vs. early Monday — close
 * enough for an intent note that's lifetime is days, not minutes.
 */
export function weekStartUtc(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay: 0 = Sunday, 1 = Monday, …, 6 = Saturday.
  const dow = d.getUTCDay();
  const offsetToMonday = (dow + 6) % 7; // Mon=0, Tue=1, …, Sun=6
  d.setUTCDate(d.getUTCDate() - offsetToMonday);
  return d.toISOString().slice(0, 10);
}

export async function getIntentForWeek(
  userId: string,
  weekStart: string,
): Promise<IntentNote | null> {
  const db = sql();
  const [row] = await db<IntentNote[]>`
    SELECT id::text AS id, week_start::text AS week_start, body,
           created_at::text AS created_at, updated_at::text AS updated_at
    FROM intent_note
    WHERE user_id = ${userId}::uuid
      AND week_start = ${weekStart}::date
  `;
  return row ?? null;
}

export async function upsertIntent(
  userId: string,
  weekStart: string,
  body: string,
): Promise<IntentNote> {
  const trimmed = body.trim().slice(0, 280);
  if (trimmed.length === 0) {
    throw new Error("intent body cannot be empty");
  }
  const db = sql();
  const [row] = await db<IntentNote[]>`
    INSERT INTO intent_note (user_id, week_start, body)
    VALUES (${userId}::uuid, ${weekStart}::date, ${trimmed})
    ON CONFLICT (user_id, week_start) DO UPDATE
      SET body = EXCLUDED.body, updated_at = NOW()
    RETURNING id::text AS id, week_start::text AS week_start, body,
              created_at::text AS created_at, updated_at::text AS updated_at
  `;
  return row;
}

export async function listRecentIntents(
  userId: string,
  limit = 8,
): Promise<IntentNote[]> {
  const db = sql();
  return db<IntentNote[]>`
    SELECT id::text AS id, week_start::text AS week_start, body,
           created_at::text AS created_at, updated_at::text AS updated_at
    FROM intent_note
    WHERE user_id = ${userId}::uuid
    ORDER BY week_start DESC
    LIMIT ${limit}
  `;
}
