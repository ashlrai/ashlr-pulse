# Multi-stage Bun image for the Ashlr Pulse server.
#
# Build context = REPO ROOT (not server/). This lets us copy the sibling
# db/ directory which migrate.ts reads from. Railway is configured with
# rootDirectory="" + dockerfilePath="server/Dockerfile" to match.

# ---------------------------------------------------------------------------
# Stage 1: builder
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.10-alpine AS builder

WORKDIR /app

# Install deps first for layer caching.
COPY server/package.json server/bun.lock ./server/
WORKDIR /app/server
RUN bun install --frozen-lockfile

# Copy server source + the sibling db/ (migrations).
WORKDIR /app
COPY server ./server
COPY db ./db

# Build Next.js.
WORKDIR /app/server
RUN bun run build

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.10-alpine AS runtime

# Non-root user.
RUN addgroup -S pulse && adduser -S pulse -G pulse

WORKDIR /app/server

# Built artifacts + runtime deps.
COPY --from=builder /app/server/.next ./.next
COPY --from=builder /app/server/node_modules ./node_modules
COPY --from=builder /app/server/package.json ./package.json

# Source files needed at runtime by `bun run migrate && bun run start`:
#   - src/cli/migrate.ts (the migration runner)
#   - src/lib/* (imported by migrate.ts and the Next runtime in dev mode;
#     production Next.js standalone bundles its own copy in .next/)
COPY --from=builder /app/server/src ./src

# Migration SQL files referenced by src/cli/migrate.ts via
# `resolve(import.meta.dir, "..", "..", "..", "db", "migrations")`.
COPY --from=builder /app/db /app/db

# Drop privileges only after copying — chown via --chown to keep the image
# layer count low.
RUN chown -R pulse:pulse /app
USER pulse

EXPOSE 3000

# DATABASE_URL etc are injected at runtime.
CMD ["sh", "-c", "bun run migrate && bun run start"]
