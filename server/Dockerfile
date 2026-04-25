# Multi-stage image for Ashlr Pulse.
# Build with Bun (fast), run with Node + Next.js's regular `next start`
# (no standalone gymnastics). Build context = repo root so we can ship the
# sibling db/ directory used by the migration runner.

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

# Verify build output exists — fail loud if Next dropped something.
RUN test -d .next || (echo "BUILD FAILED: no .next directory" && exit 1)

# ---------------------------------------------------------------------------
# Stage 2: runtime (Node 22 + Bun for one-shot migrations)
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# Bun for the migration script (TS + path aliases). Small extra binary.
RUN apk add --no-cache curl bash unzip libstdc++ && \
    curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.10" && \
    mv /root/.bun/bin/bun /usr/local/bin/bun && \
    chmod +x /usr/local/bin/bun

RUN addgroup -S pulse && adduser -S pulse -G pulse

WORKDIR /app/server

# Full Next build output + the dev node_modules (postgres-js + pino + supabase
# all live there). Trade some image size for a build that just works.
COPY --from=builder /app/server/.next ./.next
COPY --from=builder /app/server/node_modules ./node_modules
COPY --from=builder /app/server/package.json ./package.json
COPY --from=builder /app/server/src ./src
COPY --from=builder /app/server/tsconfig.json ./tsconfig.json
COPY --from=builder /app/server/next.config.ts ./next.config.ts

# Migrations: db/ at /app/db (sibling of /app/server) so the path-resolve
# in src/cli/migrate.ts (../../../db/migrations) lands correctly.
COPY --from=builder /app/db /app/db

RUN chown -R pulse:pulse /app
USER pulse

ENV NODE_ENV=production HOSTNAME=0.0.0.0

EXPOSE 3000

# Bun runs migrate (TS-aware via tsconfig paths). Then we exec into Node so
# Next can manage its own signal handling — no shell wrapper around the
# long-running server.
CMD ["sh", "-c", "bun run migrate && exec node ./node_modules/.bin/next start -H 0.0.0.0 -p ${PORT:-3000}"]
