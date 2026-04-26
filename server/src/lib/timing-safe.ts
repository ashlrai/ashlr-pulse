/**
 * timing-safe.ts — constant-time string comparison for HTTP secrets.
 *
 * JavaScript's `===` short-circuits on the first differing byte. For
 * secrets that an attacker can probe over the network (the cron secret
 * is the headline case), that lets them recover the secret one byte at
 * a time via response-time differences. Use this whenever comparing a
 * supplied token to an env-var token.
 */

import { timingSafeEqual } from "crypto";

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual requires equal-length inputs; the length check itself
  // is fast/safe and isn't a leak (length is structural, not secret).
  if (ab.byteLength !== bb.byteLength) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Pull the trustworthy client IP from a request behind a reverse proxy.
 *
 * On Railway / most reverse-proxy stacks, `x-forwarded-for` is a CSV
 * built up as the request traverses hops. The PLATFORM appends the
 * canonical client IP to the END of the list, while CLIENTS can put
 * anything in the front. Taking the leftmost element is the standard
 * mistake — it's attacker-controlled.
 *
 * Use the rightmost (platform-appended) value, falling back to
 * x-real-ip and finally a literal "unknown" so callers can still rate
 * limit on the placeholder rather than panic.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const last = xff.split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}
