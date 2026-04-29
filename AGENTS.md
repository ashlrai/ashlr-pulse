# AGENTS.md

> Canonical instructions for AI coding agents (Claude Code, Codex, Cursor,
> Aider, Gemini CLI, Windsurf, etc.) working in or with the Ashlr Pulse
> codebase. Plain Markdown, read first, ask after.

Pulse is the shared mission control for agentic-engineering teams: ingests
OpenTelemetry GenAI spans + GitHub commits, renders a privacy-respecting
dashboard, sends a daily email digest. **The product itself is for agentic
teams; this doc exists so agentic users can drive setup + ongoing ops
without their human stopping to read a 4-page README.**

The single canonical user task this doc unblocks is:

> _"Set me up on Pulse."_

If you're an AI assistant and the user asked for that, jump to
[**Onboarding flow**](#onboarding-flow) below. Then stop reading.

---

## Project at a glance

- **Two top-level products in one repo** under a monorepo layout:
  - `server/` — Next.js 15 (React 19, Bun, App Router) hosted on Railway,
    Postgres backend, Supabase auth, SendGrid email
  - `agent/` — Rust binary (`pulse-agent`) that runs on the user's
    machine, tails Claude Code JSONL session files + git repos + an
    optional shell-hook buffer, emits OTLP/HTTP-JSON spans
- **`db/migrations/*.sql`** — applied automatically on every Railway boot
  via `server/scripts/entrypoint.sh`. Each migration is idempotent
  (`IF NOT EXISTS` everywhere).
- **Production URL**: `https://pulse.ashlr.ai`
- **License**: MIT. Branch is `main` (not `master`).

For everything-in-30-seconds:

```sh
ls -1 /Users/masonwyatt/Desktop/ashlr-pulse
# .github/  .gitignore  AGENTS.md  ARCHITECTURE.md  CLAUDE.md  COMPETITIVE.md
# DEPLOY.md  LICENSE  PERSONAS.md  QUICKSTART.md  README.md  ROADMAP.md
# agent/  db/  docker-compose.yml  railway.json  research/  server/
```

---

## Onboarding flow

There are two distinct things called "onboarding":

1. **First-time user setup** (sign in to Pulse, install agent, configure):
   one command — `pulse-agent onboard --url https://pulse.ashlr.ai`. _(Note:
   in a separate session this orchestrator command may still be in flight;
   if it doesn't exist yet, fall back to the per-step sequence in
   [Manual onboarding sequence](#manual-onboarding-sequence) below.)_
2. **Cofounder / teammate onboarding**: existing user runs
   `pulse-agent invite <email>` → invitee gets a one-shot link → they sign
   in via GitHub → peer-share is pre-suggested.

If you (the AI) are running this on the user's machine and any step needs
human action you cannot perform (passkey sudo, paste-into-Supabase-UI,
GitHub-OAuth-app provisioning), **print the structured handoff block, do
not try to bypass it**. See [Hard handoff points](#hard-handoff-points).

### Manual onboarding sequence

Use this when the unified orchestrator isn't ready or you need to retry a
single step. Run them in this order; each is idempotent.

```sh
# 1. Install the agent (skip if `which pulse-agent` already resolves)
curl -fsSL https://raw.githubusercontent.com/ashlrai/ashlr-pulse/main/agent/install.sh | sh

# 2. Mint a PAT via browser-mediated approval
pulse-agent init --url https://pulse.ashlr.ai

# 3. Verify connectivity + PAT
pulse-agent doctor

# 4. Source the shell hook to capture terminal AI-CLI invocations
echo 'source ~/.local/share/pulse-agent/pulse-hook.zsh' >> ~/.zshrc
# (use pulse-hook.bash for bash users)

# 5. Edit ~/.config/pulse/config.toml: add [[repos]] entries for repos to
#    track for git activity. The `init` step writes a stub.

# 6. Start the watcher (foreground; daemonize via launchd/systemd later)
pulse-agent run

# 7. (Optional) backfill the last week of Claude Code activity
pulse-agent backfill --since 7d

# 8. In the browser: visit /github → Connect GitHub → for commit/PR ingest
# 9. In the browser: visit /projects → suggested-clusters → bulk-add repos
# 10. In the browser: visit /settings → confirm digest enabled + tz set
# 11. Run `phantom init` to import any plaintext `.env.local` into the
#     Phantom vault before committing. This seals secrets at rest and
#     enables `phantom sync --platform railway` for future deploys.
```

After step 6, the dashboard at `https://pulse.ashlr.ai/app` should show a
green "agent: alive" badge within 60s. After steps 8–10, the daily digest
will arrive at 9am local in the user's TZ tomorrow.

### Hard handoff points

The AI MUST stop and wait for the human at each of these. Do not attempt
to bypass; do not paste secrets through your conversation.

| Step | Why human-only |
|---|---|
| Generating a GitHub OAuth client secret | Requires sudo passkey on github.com; secret is shown once and must not enter the AI transcript |
| Pasting a secret into Supabase's Auth → Providers UI | Supabase blocks iframe embedding; AI cannot DOM-inject; human pastes |
| Setting Railway env vars containing secrets | Historical hard handoff. Now mostly obsolete: use `phantom init` (or `stack add <provider>`) to land secrets in the Phantom vault from a TTY paste, then `phantom sync --platform railway` to push to Railway. The agent never sees values; the user pastes once at the TTY prompt. See `.phantom.toml` for the canonical sync target. |
| Approving a PAT mint at `/agent-onboard?code=…` | Requires the user's authenticated browser session; AI prints the URL, waits for the poll to return |
| Cofounder invitations | Delegation of consent — invitee completes their own onboarding in their own browser |
| Magic-link clicks in email | Cannot be automated; user clicks the link in their own inbox |

When you hit one of these, emit a clearly-labelled block:

```
=== HUMAN ACTION REQUIRED ===
Action:    <what to do>
Where:     <URL or app>
Expected:  <what changes in the world after action>
Resume:    <what to tell the AI when done, e.g. "say 'done'">
=============================
```

Then stop and wait for the user's "done" / "approved" / equivalent.

---

## Build / test / deploy

### Server (Next.js)

```sh
cd server
bun install            # never npm install — bun.lock is the lockfile
bun run typecheck      # tsc --noEmit
bun test               # bun test (NOT jest)
bun run dev            # http://localhost:3000
bun run migrate        # apply db/migrations/*.sql against $DATABASE_URL
bun run build          # next build, used by the Dockerfile
```

Test invariants: 116+ tests, 0 fail. Tests live under `server/tests/`.
Type-checking must be clean. **No lint/biome script exists** — don't add
one without confirmation.

### Agent (Rust)

```sh
cd agent
cargo build              # dev build
cargo test               # unit + integration
cargo build --release    # release binary at target/release/pulse-agent
```

Test invariants: 13 unit + 5 integration tests, 0 fail.

### Deployment

- **Server**: Railway, auto-deploy from `main` (currently broken — manual
  `railway up` from the local checkout works as fallback). Migrations apply
  on container start via `server/scripts/entrypoint.sh`.
- **Agent**: GitHub Releases via `.github/workflows/release-agent.yml`,
  triggered by `git tag agent-v*`. Cross-compiles macOS arm64/x86_64 +
  Linux x86_64. The `agent/install.sh` curl one-liner downloads from the
  latest release.

See `DEPLOY.md` for the full Railway env-var checklist.

---

## Conventions

**Privacy floor (immutable):** Pulse never stores prompts, completions,
user code, file contents, stdout/stderr, screenshots, or keystrokes.
Enforcement points:

- `server/src/lib/peer-share-guard.ts` — server-side whitelist on every
  insert path. Forbidden: `prompts`, `completions`, `raw_otel_span`.
- `server/src/app/api/otlp/v1/traces/route.ts` — body never logged
  (could contain prompts in raw_otel_span).
- `agent/src/claude.rs` — only numeric tokens + metadata leave the user's
  machine. Prompt/completion strings are never read or transmitted.
- `agent/scripts/pulse-hook.{zsh,bash}` — only the binary name is captured
  from shell invocations, NEVER argv (`claude "<prompt>"` would otherwise
  leak the prompt). The Rust tailer at `agent/src/shell.rs` rejects any
  record whose `cmd` contains a shell metachar.

**Idempotency:**
- Every DB migration uses `IF NOT EXISTS`, so re-running on every boot is
  safe.
- OTLP ingest dedupes by `(user_id, span_id)` partial unique index +
  `ON CONFLICT DO NOTHING` (migration 0007).
- Agent watermarks: never advance past a failed export; `last_good_offset`
  separate from `byte_cursor` in both `claude.rs` and `shell.rs`.
- All cron routes accept retries idempotently.

**Security:**
- Cron secrets compared via `safeEqual()` (`server/src/lib/timing-safe.ts`),
  never `===` (timing-attack).
- Client IPs read from rightmost `x-forwarded-for` (`clientIp()` helper),
  never leftmost (Railway proxy convention; left is client-controlled).
- Open-redirect prevention in `server/src/app/auth/callback/route.ts`
  rejects `\\`, `//`, control chars (0x00–0x1f).
- PATs stored as SHA-256 hashes (`server/src/lib/pat.ts`); plaintext
  shown once at mint, never persisted.
- GitHub OAuth tokens encrypted at rest via pgcrypto (`PULSE_TOKEN_ENC_KEY`).

**Code style:**
- TypeScript strict, no `any` unless commented why.
- Server uses postgres-js tagged templates; never raw SQL string interp
  except via `db.unsafe()` for SQL fragments that can't be parameterized
  (column names, intervals) — and ALWAYS gated by an explicit allowlist.
- Comments explain WHY (constraints, surprises), never WHAT.
- No new deps without a clear justification.

---

## Where to look for X

| Need | File path |
|---|---|
| **Database schema** | `db/migrations/*.sql` (each migration has a long header explaining its purpose) |
| **OTLP ingest entrypoint** | `server/src/app/api/otlp/v1/traces/route.ts` |
| **Span → row mapping** | `server/src/lib/otel-genai.ts` |
| **Peer-share rules** | `server/src/lib/peer-share-{db,guard}.ts`, `server/src/app/share/page.tsx` |
| **Daily digest pipeline** | `server/src/lib/digest.ts`, `digest-render.ts`, `email.ts`, `app/api/cron/digest/route.ts` |
| **Agent onboard / PAT mint** | `agent/src/onboard.rs`, `server/src/app/api/agent-onboard/{start,poll}/route.ts`, `server/src/app/agent-onboard/page.tsx` |
| **Heartbeat + agent status** | `server/src/lib/heartbeat.ts`, `agent/src/heartbeat.rs`, dashboard badge in `server/src/app/app/page.tsx` |
| **Project rollups** | `server/src/lib/project-db.ts`, `server/src/app/projects/page.tsx` |
| **GitHub OAuth (data-sync)** | `server/src/app/api/github/oauth/{start,callback}/route.ts`, `server/src/lib/github-{client,sync,account-db}.ts` |
| **Login (GitHub OAuth + magic-link)** | `server/src/app/login/page.tsx`, `server/src/app/auth/callback/route.ts` |
| **Cron infrastructure** | `server/src/lib/cron.ts` (in-process scheduler), routes under `server/src/app/api/cron/*` |
| **Claude Code JSONL tailer** | `agent/src/claude.rs` (parses `~/.claude/projects/*/*.jsonl`, cmux-friendly) |
| **Shell-hook ingester** | `agent/scripts/pulse-hook.{zsh,bash}` + `agent/src/shell.rs` |
| **Git poller** | `agent/src/git.rs` |
| **Backfill (re-tail Claude history)** | `agent/src/backfill.rs` |
| **CI (server tests + agent build)** | `.github/workflows/ci.yml` |
| **Agent release workflow** | `.github/workflows/release-agent.yml` |

For ROADMAP / PERSONAS / COMPETITIVE positioning, read `ROADMAP.md`,
`PERSONAS.md`, `COMPETITIVE.md`. They contain the product strategy and
must not be edited without confirmation.

---

## Things you (the AI) MUST NOT do

These are hard rules. Your tools are configured to block most of them at
the harness level, but the conventions are documented here so any agent
across any host respects them.

1. **Never read `server/.env*` or `agent/.env*`** — they contain secrets.
   The user's Claude Code permission rule already blocks this; respect
   the spirit even when running in a different harness.
2. **Never echo a secret to stdout / your conversation.** If you need to
   move a secret between two systems, write a config stub with
   `{{ paste here }}` and let the human paste. Bash commands that include
   a secret as a flag (`railway variables set X=$SECRET`) put the value in
   shell history + the process table — both are exfiltration surfaces.
3. **Never create OAuth apps, GitHub Apps, Supabase projects, or Railway
   services autonomously.** Generate the exact configuration the human
   should enter and emit a HUMAN ACTION REQUIRED block.
4. **Never run `git push --force`, `railway redeploy --override`,
   `git tag` for releases, `gh release create`, etc. without explicit
   confirmation in the same turn.** All of these are shared-state actions.
5. **Never amend an existing commit unless the user explicitly asks** —
   create a NEW commit instead. Pre-commit hook failures mean the commit
   didn't happen; `--amend` would modify the previous one.
6. **Never disable a hook (`--no-verify`, `--no-gpg-sign`)** to make
   something pass.
7. **Never widen `peer-share-guard.ts`'s `SHAREABLE_FIELDS` set or remove
   anything from `FORBIDDEN_FIELDS`.** This is the privacy floor.
8. **Never log request bodies in any OTLP ingest path.** Bodies may
   contain prompts.
9. **Never store prompts, completions, file contents, or full git diffs
   anywhere — DB, logs, or external services.** Even temporarily.

If you're unsure whether an action is safe, stop and ask the user.

---

## Glossary

- **OTel GenAI semantic conventions** — OpenTelemetry's standard for
  generative-AI spans (model, tokens, tool calls). Pulse ingests these
  natively at `/api/otlp/v1/traces` so any GenAI-shaped span source works
  without proprietary adapters.
- **Peer-share** — the per-user, per-peer, per-scope sharing model.
  `peer_share` rows have `(owner_id, viewer_id, scope_type, scope_value,
  granularity, fields)`. Granularity ∈ {realtime, daily, weekly, monthly}.
- **Granularity rollup** — the dashboard picks the most-permissive
  granularity across all matching grants when rendering.
- **Source enum** — `activity_event.source` is one of `claude_code`,
  `cursor`, `copilot`, `wakatime`, `git`, `shell`, `ashlr_plugin`. Map
  via `ashlr.source` attribute on incoming spans.
- **PAT** — personal access token, format `pulse_pat_<32 hex>`. Scoped
  to OTLP ingest only (no read scope). SHA-256 hashed in storage.
- **cmux** — a multiplexer that runs many concurrent Claude Code
  instances. The agent handles this transparently — every session.jsonl
  under `~/.claude/projects/*/` is tailed independently with per-file
  watermarks.
- **Hard floor** — colloquial term for the privacy floor (no prompts,
  completions, code, etc.).

---

## When you finish a task, leave the project in good shape

- Run `bun run typecheck && bun test` from `server/` after server changes.
- Run `cargo build && cargo test` from `agent/` after agent changes.
- If you changed migrations, apply them locally:
  `DATABASE_URL=postgres://pulse:pulse@localhost:55432/pulse bun run migrate`
- If you changed agent code that affects the OTLP wire shape, verify
  with `pulse-agent doctor` against a local pulse server.
- If you added new tests, ensure they actually run (look for them in the
  test runner output count).
- Don't leave commented-out code; either delete or land it.
- Commit messages: `<type>(<scope>): <summary>` — see `git log --oneline -10`
  for the style. Body explains WHY, wraps at 72.

If multiple commits are appropriate, group them by feature area, not by
file. Each commit should leave the codebase in a working state.
