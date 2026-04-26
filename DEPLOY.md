# Deploy

End-to-end checklist for getting Ashlr Pulse from a fresh Railway project
to "Mason's cofounder pastes a curl command and is ingesting in 3 minutes."

Estimated time: 30–45 min (DNS propagation is the slowest step).

---

## 1. Server (Railway)

### 1.1 Create the project

```bash
railway login
railway init
railway add postgres
```

Hooks up a managed Postgres. The `entrypoint.sh` runs `psql` against
every `db/migrations/*.sql` on each container start — migrations are
idempotent (`IF NOT EXISTS` everywhere), so first deploy applies all
of them automatically.

### 1.2 Required env vars

Set in the Railway service settings. None of these have safe defaults
that work in production.

| Var | Purpose | How to generate |
|---|---|---|
| `DATABASE_URL` | Auto-injected by Railway when Postgres is linked. Use the **private** networking URL (`*.railway.internal`) so traffic stays inside the project. | Provided by Railway |
| `NEXT_PUBLIC_SUPABASE_URL` | Magic-link auth | From Supabase project settings |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same | Same |
| `NEXT_PUBLIC_APP_URL` | Where login + `/agent-onboard` callbacks redirect to. Must match the prod URL exactly (https + no trailing slash). | e.g. `https://pulse.ashlr.ai` |
| `PULSE_CRON_SECRET` | Without this, `lib/cron.ts` skips registration entirely → no digest, no scheduled GitHub sync | `openssl rand -hex 32` |
| `PULSE_TOKEN_ENC_KEY` | Encrypts GitHub OAuth tokens at rest via pgcrypto | `openssl rand -hex 32` |
| `SENDGRID_API_KEY` | Daily digest email | sendgrid.com → Settings → API Keys → Create API Key (Full Access or Mail Send only) |
| `PULSE_DIGEST_FROM_EMAIL` | Sender address on the digest. Must be a verified SendGrid sender on a domain you control | e.g. `support@ashlr.ai` |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | GitHub commit/PR sync at `/github` | github.com/settings/developers → New OAuth App; callback `https://<your-pulse>/api/github/oauth/callback`; scopes `repo:status user:email read:org` |
| `PULSE_OTLP_RATE_LIMIT` *(optional)* | Override OTLP per-PAT rate limit | default `60:1` (60 req/min, refill 1/sec) |
| `PULSE_OTLP_MAX_BYTES` *(optional)* | Cap OTLP body size | default `1048576` (1 MB) |

### 1.3 SendGrid domain authentication (DNS)

If your AshlrAI org already has a verified sending domain on SendGrid
(likely, since other projects use it), skip to 1.4 — Pulse can use the
same domain. Just confirm the domain shows green under Settings →
Sender Authentication.

If this is a new domain or you want a sub-domain (e.g. `pulse.ashlr.ai`
distinct from your other transactional senders so reputation issues
on one product don't poison the others):

1. SendGrid → Settings → Sender Authentication → **Authenticate Your Domain**
2. Pick your DNS host, enter the domain
3. SendGrid generates 3 CNAME records (DKIM keys + return-path). Add
   them in your DNS provider exactly as shown.
4. Click **Verify** — propagation is usually 5–30 min.

```
CNAME  em1234.pulse.ashlr.ai    u1234.wl.sendgrid.net
CNAME  s1._domainkey.pulse.ashlr.ai  s1.domainkey.u1234.wl.sendgrid.net
CNAME  s2._domainkey.pulse.ashlr.ai  s2.domainkey.u1234.wl.sendgrid.net
```

(Exact values come from SendGrid's UI — these are illustrative.)

Without authentication, digests land in spam or get rejected outright
by Gmail / Outlook.

### 1.4 GitHub OAuth app

- Application name: `Ashlr Pulse` (or whatever)
- Homepage URL: `https://<your-pulse>`
- Authorization callback URL: `https://<your-pulse>/api/github/oauth/callback`
- Scopes: `repo:status`, `user:email`, `read:org`

Copy the client ID + generated secret into Railway env vars.

### 1.5 Deploy + smoke test

`git push` to whatever branch Railway watches (usually `main`). On boot:

```bash
curl https://<your-pulse>/api/healthz
# → {"ok":true,"db":"ok",...}
```

If `db: down`, the migration step likely failed — check Railway logs
for `[entrypoint] applying 00XX_*.sql` lines.

Manually trigger the digest cron once to verify SendGrid works:

```bash
curl -X POST https://<your-pulse>/api/cron/digest \
  -H "x-cron-secret: $PULSE_CRON_SECRET"
# → {"ok":true,"candidates":N,"sent":...,"empty":...,"skipped":...}
```

If `skipped > 0` and you set `SENDGRID_API_KEY`: check SendGrid's
Activity Feed for the rejection reason (usually "from address not
verified" — re-check sender authentication).

---

## 2. Agent release

The `install.sh` one-liner downloads from the latest GitHub release. Push
a tag to trigger the cross-compile workflow:

```bash
git tag agent-v0.3.0 && git push --tags
```

Watch the run at `https://github.com/ashlrai/ashlr-pulse/actions`. It
takes ~5 minutes. When it finishes, three tarballs + sha256s are
attached to the release page.

For subsequent agent versions, bump `agent/Cargo.toml`'s `version`,
add an entry to `agent/CHANGELOG.md`, then `git tag agent-v<new>` and
push.

---

## 3. Onboarding (you, then your cofounder)

### 3.1 Sign in once

Visit `https://<your-pulse>/login`, magic-link to your email, land on
`/app`. This creates your row in the `user` table and assigns you a
default `org` via the `ensureDefaultOrg` flow.

### 3.2 Install the agent

```bash
curl -fsSL https://raw.githubusercontent.com/ashlrai/ashlr-pulse/main/agent/install.sh | sh
```

The script detects your platform (macOS arm64/x86_64, Linux x86_64),
downloads the matching binary, verifies the sha256, installs to
`~/.local/bin/pulse-agent`, and drops the shell-hook scripts into
`~/.local/share/pulse-agent/`. Idempotent — re-run to upgrade.

### 3.3 Mint a PAT (browser-mediated)

```bash
pulse-agent init --url https://<your-pulse>
```

Opens the approval page in your browser. Sign in if needed, click
**Approve agent**. The agent receives the PAT, stores it in your OS
keyring (`service=ashlr-pulse, username=<your-pulse>`), writes a stub
config to `~/.config/pulse/config.toml`. The PAT never lives at rest
on disk.

### 3.4 Configure repos

Edit `~/.config/pulse/config.toml`:

```toml
[server]
url = "https://<your-pulse>"

[[repos]]
path = "/Users/you/code/repo-a"
[[repos]]
path = "/Users/you/code/repo-b"
```

The agent polls each repo's `git log` every 60s and ingests new commits
as `source = git` activity.

### 3.5 Source the shell hook (optional but recommended)

Captures every `claude` / `codex` / `aider` / `sgpt` / etc. invocation
across all your terminals (cmux, VS Code's integrated terminal, plain
iTerm). Privacy floor: only the binary name leaves the shell, never
argv.

```bash
echo 'source ~/.local/share/pulse-agent/pulse-hook.zsh' >> ~/.zshrc
# bash equivalent: pulse-hook.bash
```

Open a new terminal so the hook loads.

### 3.6 Start the agent

```bash
pulse-agent doctor   # confirms PAT, repos, ingest reachable
pulse-agent run      # foreground; SIGTERM/Ctrl-C to stop
```

For a daemonized setup, write a launchd plist (macOS) or systemd user
service (Linux) — examples in `agent/README.md`.

### 3.7 Optional: backfill the last week

If you started using Pulse mid-day and want history:

```bash
pulse-agent backfill --since 7d
```

Idempotent — safe even if `pulse-agent run` is also active. Server
dedups via `(user_id, span_id)` unique index.

---

## 4. In-product setup

1. **`/github`** — click *Connect GitHub*, authorize the OAuth app.
   Within 60 min the cron pulls your commits + PRs, or click *Sync now*
   for instant.
2. **`/projects`** — *Suggested projects* offers one-click bulk-create
   from repo-name prefixes (`client-*`, `saas-*`, `experiments-*`). Use
   it; manually typing 25 repo names is the failure mode.
3. **`/settings`** — confirm digest is enabled, set TZ to your local
   IANA zone (e.g. `America/Los_Angeles`), click **Send test** to
   verify email arrives.
4. **`/share`** — invite your cofounder by email (they need to sign in
   once first), grant them the granularity + scope you want them to
   see (`realtime` on `client-*`, `weekly` on `saas-*`, etc.).

---

## 5. Verify

| Signal | Where | When |
|---|---|---|
| Server up | `curl /api/healthz` returns 200 | Immediately after deploy |
| Agent alive | `/app` shows green "alive" badge near "today" | Within 60s of `pulse-agent run` |
| Claude ingest | `/app` shows a `claude_code` row in the table | Within minutes of using Claude Code |
| Shell hook | `/app` shows a `shell` row | After running `claude`/`codex`/`aider` from a new terminal |
| GitHub | `/app` GitHub panel + `/github` last-synced timestamp | Within 60 min of *Connect*, or click *Sync now* |
| Digest | Email lands at 9am local time | Tomorrow morning (or click *Send test* now) |
| Project rollups | "by project" panel on `/app` and in the digest | After creating projects |
| Backfill works | Re-run `pulse-agent backfill --since 1d`, see "X seen / 0 emitted" on the second run | Right after the first backfill completes |

---

## 6. Common pitfalls

- **Digest goes to spam**: SendGrid domain authentication may be
  incomplete. Check Settings → Sender Authentication for "Failed" on
  any CNAME. Also check the Activity Feed for soft-bounce reasons.
- **Agent says "alive" but no activity rows**: `pulse-agent doctor`
  shows whether OTLP ingest succeeded. If yes, check that
  `[[repos]]` paths exist and are git repos.
- **Shell hook silent**: Run `pulse-agent run` with `RUST_LOG=debug`
  and try invoking `claude` — you should see `exported shell spans`
  log lines. If not, the hook script may not be sourced (verify with
  `echo $_PULSE_HOOK_LOADED` in a new shell).
- **GitHub sync error banner appears**: Token revoked. Click
  *Reconnect GitHub* on `/github`.
- **`pulse-agent init` times out**: Code has a 5-min TTL. Re-run the
  command, click Approve faster.

---

## 7. Quick reference: every secret you need to set

```bash
# Inside Railway env settings (replace each with real values)
NEXT_PUBLIC_APP_URL=https://pulse.example.com
NEXT_PUBLIC_SUPABASE_URL=https://abcd.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJh…
PULSE_CRON_SECRET=$(openssl rand -hex 32)
PULSE_TOKEN_ENC_KEY=$(openssl rand -hex 32)
SENDGRID_API_KEY=SG.…
PULSE_DIGEST_FROM_EMAIL=pulse@example.com
GITHUB_OAUTH_CLIENT_ID=Ov23li…
GITHUB_OAUTH_CLIENT_SECRET=…
```
