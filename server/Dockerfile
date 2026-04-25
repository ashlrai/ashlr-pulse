# Multi-stage image for the Ashlr Pulse server.
#
# Build with Bun (fast install + compile), run with Node (battle-tested
# net/http stack + Next.js standalone bundle). Build context = repo root
# so we can also ship the sibling db/ directory for migrations.
#
# Railway is configured via railway.json:
#   build.dockerfilePath = "server/Dockerfile"
#   build.builder        = "DOCKERFILE"

# ---------------------------------------------------------------------------
# Stage 1: builder (Bun)
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.10-alpine AS builder

WORKDIR /app

# Install deps first (layer cache).
COPY server/package.json server/bun.lock ./server/
WORKDIR /app/server
RUN bun install --frozen-lockfile

# Copy source + sibling db/ for migration runner.
WORKDIR /app
COPY server ./server
COPY db ./db

WORKDIR /app/server
RUN bun run build

# ---------------------------------------------------------------------------
# Stage 2: runtime (Node + Bun for one-shot migrations)
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# Install Bun for the migration runner. Migrations are infrequent + one-shot,
# so the extra binary is fine; keep node for the long-running Next server.
RUN apk add --no-cache curl bash && \
    curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.10" && \
    mv /root/.bun/bin/bun /usr/local/bin/bun && \
    chmod +x /usr/local/bin/bun

# Non-root user.
RUN addgroup -S pulse && adduser -S pulse -G pulse

WORKDIR /app/server

# Next.js standalone bundle: a self-contained Node server at server.js
# plus a trace of node_modules. Public assets and .next/static must be
# copied alongside per Next docs.
COPY --from=builder /app/server/.next/standalone ./
COPY --from=builder /app/server/.next/static ./.next/static
COPY --from=builder /app/server/public ./public

# Migration runner needs:
#   - src/cli/migrate.ts + src/lib/* (it imports @/lib/logger)
#   - tsconfig.json for the @/* path alias
#   - db/migrations/*.sql (sibling dir per migrate.ts MIGRATIONS_DIR resolve)
#   - postgres + pino in node_modules
COPY --from=builder /app/server/src ./src
COPY --from=builder /app/server/tsconfig.json ./tsconfig.json
COPY --from=builder /app/server/package.json ./package.json
COPY --from=builder /app/server/node_modules ./node_modules
COPY --from=builder /app/db /app/db

RUN chown -R pulse:pulse /app
USER pulse

ENV NODE_ENV=production
EXPOSE 3000

# server.js is Next.js's standalone entry. It binds to 0.0.0.0 by default
# and respects PORT (set by Railway).
CMD ["node", "server.js"]
