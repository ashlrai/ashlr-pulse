#!/usr/bin/env bun
/**
 * mint-pat.ts — generate a personal access token for the given user.
 *
 *   bun run src/cli/mint-pat.ts <user_id> <name>
 *
 * Prints the token to stdout exactly once. We persist only the SHA-256
 * hash, so this is the only chance to capture it. Pipe to a file or paste
 * into your agent's config — there is no recovery flow.
 */

import { mintPat } from "../lib/pat";

async function main(): Promise<void> {
  const [userId, name] = process.argv.slice(2);
  if (!userId || !name) {
    console.error("usage: bun run src/cli/mint-pat.ts <user_id> <name>");
    process.exit(1);
  }
  const { token, id } = await mintPat(userId, name);
  console.log(`pat_id: ${id}`);
  console.log(`token:  ${token}`);
  console.log("\nstore this — we cannot show it again.");
  process.exit(0);
}

main().catch((err) => {
  console.error(`[mint-pat] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
