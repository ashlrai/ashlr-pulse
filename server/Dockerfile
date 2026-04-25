# Stage 1: builder
FROM oven/bun:1.3.10-alpine AS builder

WORKDIR /app/server

# Install dependencies first (layer-cache friendly)
COPY package.json ./
RUN bun install --frozen-lockfile

# Copy source and build
COPY . .
RUN bun run build

# Stage 2: runtime
FROM oven/bun:1.3.10-alpine AS runtime

# Create non-root user
RUN addgroup -S pulse && adduser -S pulse -G pulse

WORKDIR /app/server

# Copy only what's needed to run
COPY --from=builder /app/server/.next ./.next
COPY --from=builder /app/server/node_modules ./node_modules
COPY --from=builder /app/server/package.json ./package.json

USER pulse

EXPOSE 3000

# DATABASE_URL and other env vars are injected at runtime
CMD ["bun", "run", "start"]
