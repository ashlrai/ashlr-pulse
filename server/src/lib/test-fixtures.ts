/**
 * test-fixtures.ts — TEST-ONLY DB fixture helpers.
 *
 * Not imported by any production code path (route handlers, cron, CLI).
 * Exists solely so DB-integration tests build users the same,
 * schema-correct way instead of hand-rolling INSERTs against "user"
 * with columns that table has never had.
 *
 * Why this exists: "user" (db/migrations/0001_activity_event.sql) only
 * has id/email/name/created_at (+ digest prefs added later). GitHub
 * identity — github_login, avatar_url, scopes, the encrypted OAuth
 * token — lives on github_account (db/migrations/0004_github_integration.sql),
 * one row per user via github_account.user_id. A prior generation of the
 * peer-share privacy test fixtures inserted github_login/avatar_url (and
 * a github_node_id that has never existed anywhere in the schema)
 * straight into "user", which fails against the real schema.
 *
 * Real Pulse users are always provisioned user + github_account together
 * (GitHub OAuth is the only sign-up path), so tests that want a
 * realistic user should have both rows too — that's what
 * createTestUserWithGithub does. None of the current peer-share privacy
 * tests assert on github_login/avatar_url directly (they assert on
 * activity_event / peer_share_*_aggregate field projections), but
 * modeling the real user+github_account shape keeps the fixtures honest
 * about what a "user" actually looks like in production, which matters
 * for a test suite whose entire job is proving nothing crosses the
 * peer-share privacy boundary that shouldn't.
 *
 * access_token_enc is a placeholder bytea, not a real AES-GCM ciphertext
 * from token-crypto.ts's encryptToken(). These tests never decrypt it,
 * and requiring PULSE_TOKEN_ENC_KEY here would tie an unrelated secret
 * into every peer-share test's setup for no behavioral gain.
 */

import { sql } from "./db";

let counter = 0;

export interface TestUserFixture {
  id: string;
  githubAccountId: string;
}

/**
 * Insert a "user" row plus a linked github_account row.
 *
 * @param email        Unique email for the "user" row.
 * @param githubLogin  Unique-enough github_login for the github_account row
 *                      (caller supplies it so fixture data stays readable
 *                      in the DB, e.g. "ha-owner-<tag>").
 */
export async function createTestUserWithGithub(
  email: string,
  githubLogin: string,
): Promise<TestUserFixture> {
  const db = sql();
  // Unique per process without depending on wall-clock precision — Date.now()
  // alone can collide across users created in the same millisecond.
  const githubUserId = Date.now() * 1_000 + (counter++ % 1_000);

  const [user] = await db<{ id: string }[]>`
    INSERT INTO "user" (email) VALUES (${email}) RETURNING id::text AS id
  `;

  const [account] = await db<{ id: string }[]>`
    INSERT INTO github_account (
      user_id, github_user_id, github_login, avatar_url, scopes, access_token_enc
    )
    VALUES (
      ${user.id}::uuid, ${githubUserId}, ${githubLogin}, '',
      ${[]}, ${Buffer.from("test-fixture-placeholder-token")}
    )
    RETURNING id::text AS id
  `;

  return { id: user.id, githubAccountId: account.id };
}
