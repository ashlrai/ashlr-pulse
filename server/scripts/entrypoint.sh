#!/bin/sh
# entrypoint.sh — apply DB migrations, then exec into Next.
#
# Each .sql file in /app/db/migrations is idempotent (uses IF NOT EXISTS
# / ADD COLUMN IF NOT EXISTS). Running them on every container start is
# safe and obviates the need for a schema_migrations ledger at this scale.
#
# stdout from psql shows up in Railway logs unbuffered. ON_ERROR_STOP
# kills the container fast on a real failure (Railway's restart policy
# then surfaces the error).

set -e

echo "[entrypoint] running database migrations"

for f in /app/db/migrations/*.sql; do
  echo "[entrypoint] applying $(basename "$f")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo "[entrypoint] migrations done; starting next on port ${PORT:-3000}"
exec node ./node_modules/.bin/next start -H 0.0.0.0 -p "${PORT:-3000}"
