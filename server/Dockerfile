# Multi-stage image for Ashlr Pulse.
# Build with Bun (fast install + compile), run with Node 22 + psql for
# migrations. No bun in the runtime image — fewer moving parts.

# ---------------------------------------------------------------------------
# Stage 1: builder (Bun)
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.10-alpine AS builder

WORKDIR /app
COPY server/package.json server/bun.lock ./server/
WORKDIR /app/server
RUN bun install --frozen-lockfile

WORKDIR /app
COPY server ./server
COPY db ./db

WORKDIR /app/server
RUN bun run build
RUN test -d .next || (echo "BUILD FAILED: no .next directory" && exit 1)

# ---------------------------------------------------------------------------
# Stage 2: runtime (Node + psql)
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# postgresql-client gives us psql for the one-shot migration runner.
RUN apk add --no-cache postgresql16-client

RUN addgroup -S pulse && adduser -S pulse -G pulse

WORKDIR /app/server

COPY --from=builder /app/server/.next ./.next
COPY --from=builder /app/server/node_modules ./node_modules
COPY --from=builder /app/server/package.json ./package.json
COPY --from=builder /app/server/next.config.ts ./next.config.ts
# public/ is served by next start at runtime (favicon, etc.)
COPY --from=builder /app/server/public ./public
# Migration SQL files. Each migration uses IF NOT EXISTS so re-running
# is a no-op; no schema_migrations bookkeeping needed at this scale.
COPY --from=builder /app/db /app/db
# entrypoint.sh — applies migrations then exec's into Next.
COPY --from=builder /app/server/scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

RUN chown -R pulse:pulse /app
USER pulse

ENV NODE_ENV=production HOSTNAME=0.0.0.0
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
