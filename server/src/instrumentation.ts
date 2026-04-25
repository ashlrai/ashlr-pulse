/**
 * instrumentation.ts — Next.js 15 boot hook.
 *
 * Called once when the Next runtime starts. Used to register the
 * in-process hourly GitHub sync cron without a separate Railway
 * service.
 *
 * https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

export async function register(): Promise<void> {
  // Only run in the Node runtime (not edge).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startBackgroundCron } = await import("./lib/cron");
  startBackgroundCron();
}
