#!/usr/bin/env bun
/**
 * migrate.ts — apply db/migrations/*.sql in lexicographic order.
 *
 * Tracks applied migrations in a `schema_migrations` table. Idempotent:
 * re-running is a no-op when everything is already applied.
 *
 * v0.1 only needs forward migrations. Rollback tooling is a v0.3 concern.
 */

import postgres from "postgres";
import { readdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";

const MIGRATIONS_DIR = resolve(import.meta.dir, "..", "..", "..", "db", "migrations");

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1 });

  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const applied = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const name of files) {
    if (applied.has(name)) continue;
    const path = join(MIGRATIONS_DIR, name);
    const body = readFileSync(path, "utf-8");
    console.error(`[migrate] applying ${name} ...`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
    });
    count++;
  }

  console.error(`[migrate] ${count} migration(s) applied (${files.length - count} already current).`);
  await sql.end();
}

main().catch((err) => {
  console.error(`[migrate] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
