/**
 * db.ts — singleton Postgres pool.
 *
 * DATABASE_URL selects the connection. In docker-compose dev the server
 * reaches postgres at postgres://pulse:pulse@localhost:5432/pulse.
 *
 * postgres-js rather than pg because it's sharper on types and has a
 * smaller surface for what we need (simple parameterized queries +
 * JSON handling for raw_otel_span).
 */

import postgres from "postgres";

let _sql: postgres.Sql | null = null;

export function sql(): postgres.Sql {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. In dev: `docker-compose up postgres` and set " +
      "DATABASE_URL=postgres://pulse:pulse@localhost:5432/pulse",
    );
  }
  _sql = postgres(url, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    // OTel uses nanosecond timestamps; keep JSON as string here so we don't
    // lose precision when we route through the `raw_otel_span` column.
    types: {
      bigint: postgres.BigInt,
    },
  });
  return _sql;
}
