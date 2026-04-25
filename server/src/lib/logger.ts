/**
 * logger.ts — structured logging via pino.
 *
 * Level from LOG_LEVEL env (default "info").
 * Import this instead of console.log/console.error in route handlers and CLI.
 *
 * Privacy floor: never log request bodies — they may contain prompts in
 * OTLP shape. Log metadata only (path, status, user_id, request_id).
 *
 * request_id: pass through x-request-id if present, else generate one.
 * Echo it back in responses via the `x-request-id` header.
 */

import pino from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Pretty-print in dev; structured JSON in production.
  ...(process.env.NODE_ENV !== "production"
    ? { transport: { target: "pino/file", options: { destination: 1 } } }
    : {}),
});

/**
 * Extract or generate a request_id from the incoming Request.
 * Use this at the top of each route handler and include it in all log calls.
 */
export function requestId(req: Request): string {
  return req.headers.get("x-request-id") ?? crypto.randomUUID();
}
