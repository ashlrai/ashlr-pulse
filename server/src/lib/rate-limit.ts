/**
 * rate-limit.ts — in-memory token-bucket per key.
 *
 * Per-PAT rate limiting for /api/otlp. Each key gets its own bucket.
 * Bucket state is in-process memory (good enough for a single-node deploy;
 * v0.3 can move to Redis if multi-node is needed).
 *
 * Config via PULSE_OTLP_RATE_LIMIT env: "<capacity>:<refillPerSec>"
 *   Default: "60:1" — 60 req/min, refill 1/sec.
 *
 * Algorithm: token bucket with lazy refill on each check call.
 *   tokens += (now - last_refill_ms) / 1000 * refillPerSec
 *   tokens  = min(tokens, capacity)
 *   if tokens >= 1 → allow, consume 1
 *   else           → deny, retryAfterSec = ceil((1 - tokens) / refillPerSec)
 */

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();

export interface AllowResult {
  ok: true;
  remaining: number;
}

export interface DenyResult {
  ok: false;
  retryAfterSec: number;
}

export type BucketResult = AllowResult | DenyResult;

function parseConfig(): { capacity: number; refillPerSec: number } {
  const raw = process.env.PULSE_OTLP_RATE_LIMIT ?? "60:1";
  const [capStr, refillStr] = raw.split(":");
  const capacity = Number(capStr);
  const refillPerSec = Number(refillStr);
  if (!Number.isFinite(capacity) || capacity <= 0) return { capacity: 60, refillPerSec: 1 };
  if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) return { capacity: 60, refillPerSec: 1 };
  return { capacity, refillPerSec };
}

/**
 * Check (and consume) one token from `key`'s bucket.
 *
 * @param key         Unique identifier for the rate-limit subject (e.g. PAT id).
 * @param capacity    Max tokens (burst ceiling). Defaults to PULSE_OTLP_RATE_LIMIT.
 * @param refillPerSec Tokens added per second. Defaults to PULSE_OTLP_RATE_LIMIT.
 */
export function checkBucket(
  key: string,
  capacity?: number,
  refillPerSec?: number,
): BucketResult {
  const cfg = parseConfig();
  const cap = capacity ?? cfg.capacity;
  const refill = refillPerSec ?? cfg.refillPerSec;

  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: cap, lastRefillMs: now };
    buckets.set(key, bucket);
  }

  // Lazy refill.
  const elapsedSec = (now - bucket.lastRefillMs) / 1000;
  bucket.tokens = Math.min(cap, bucket.tokens + elapsedSec * refill);
  bucket.lastRefillMs = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { ok: true, remaining: Math.floor(bucket.tokens) };
  }

  const retryAfterSec = Math.ceil((1 - bucket.tokens) / refill);
  return { ok: false, retryAfterSec };
}

/** Clear all buckets (for testing). */
export function clearBuckets(): void {
  buckets.clear();
}
