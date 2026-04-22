# Architecture

## One-line summary

A local-first agent → standardized OTel events → central OSS-licensed server → dashboard.
Data schema is OpenTelemetry GenAI semantic conventions, so nothing is proprietary.

## High-level diagram

```
┌──────────────────────────┐
│ Developer laptop         │
│                          │
│  Claude Code ─┐          │
│  Cursor API ──┼──► Local │
│  VS Code ─────┤   agent  │──HTTPS (aggregates only, no prompts)──┐
│  cmux + aider ┤   (Rust  │                                       │
│  Git hooks ───┘    or Go)│                                       │
│                          │                                       │
└──────────────────────────┘                                       │
                                                                   ▼
                          ┌────────────────────────────────────────────┐
                          │ Ashlr Pulse server (self-host or cloud)    │
                          │                                            │
                          │  ┌────────────────────────────────────┐    │
                          │  │ OTel collector (accepts GenAI spans)│   │
                          │  │ WakaTime heartbeat endpoint         │   │
                          │  │ Cursor / Copilot API pollers        │   │
                          │  │ Git commit ingester                 │   │
                          │  └─────────────┬──────────────────────┘    │
                          │                ▼                           │
                          │  ┌────────────────────────────────────┐    │
                          │  │ Unified activity_event table       │    │
                          │  │ (Postgres, no prompts/code)        │    │
                          │  └─────────────┬──────────────────────┘    │
                          │                ▼                           │
                          │  ┌────────────────────────────────────┐    │
                          │  │ Next.js dashboard (team + ind)     │    │
                          │  └────────────────────────────────────┘    │
                          └────────────────────────────────────────────┘
```

## Data model — `activity_event`

```sql
CREATE TABLE activity_event (
  id            UUID PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL,
  user_id       TEXT NOT NULL,
  session_id    TEXT,

  -- where it came from
  source        TEXT NOT NULL,      -- 'claude_code' | 'cursor' | 'copilot' | 'wakatime' | 'git' | 'shell'
  provider      TEXT,               -- 'anthropic' | 'openai' | 'google' etc.
  model         TEXT,               -- 'claude-opus-4-7' | 'gpt-4o' etc.

  -- when/how long
  duration_ms   INT,

  -- token accounting (nullable — not all sources supply)
  tokens_input  INT,
  tokens_output INT,
  tokens_cache_read INT,
  tokens_cache_write INT,

  -- tool-call shape (counts only, not contents)
  tool_calls_count     INT,
  tool_calls_types     TEXT[],      -- ['bash', 'read', 'edit']

  -- acceptance (where applicable)
  accepted_count INT,
  rejected_count INT,

  -- context (hashed; never raw paths stored longer than necessary)
  project_hash   TEXT,              -- sha256(cwd)
  repo_name      TEXT,              -- 'AshlrAI/cotidie' if cwd is a git repo
  git_branch     TEXT,              -- OK to store
  language       TEXT,              -- 'typescript' | 'python' etc.

  -- cost (computed server-side from tokens × model price table)
  cost_usd_cents INT,

  raw_otel_span JSONB               -- optional, full OTel span for debugging
);

CREATE INDEX ON activity_event (user_id, ts DESC);
CREATE INDEX ON activity_event (repo_name, ts DESC);
CREATE INDEX ON activity_event (source, ts DESC);
```

**What we never store**: prompts, completions, user code, file contents, stdout/stderr.

## Collection paths

| Source | Method | License OK? |
|---|---|---|
| **Claude Code** | OTel export over OTLP/HTTP — the tool natively supports this via `OTEL_EXPORTER_OTLP_ENDPOINT` | N/A (Anthropic's feature) |
| **Cursor** | Poll `server.cursor.com` Admin API every 15m with team service key | T&C review needed |
| **GitHub Copilot Business** | Poll `GET /orgs/{org}/copilot/metrics` daily | Official API, no issue |
| **WakaTime-compatible IDEs** (VS Code, JetBrains, Sublime, Vim, etc.) | Run a small heartbeat-receiver endpoint with WakaTime-protocol parity. Devs point their plugin at `https://pulse.example.com/api/heartbeat` instead of WakaTime's cloud. | BSD-3, fine |
| **Windsurf / Codeium** | Poll Enterprise API (service key) | T&C review |
| **Tabnine** | Poll Usage Metrics API | T&C review |
| **Terminal / shell (aider, Claude Code CLI, etc.)** | `preexec`/`precmd` hooks (Atuin-style); capture `{cmd, cwd, duration, exit_code}` without content | N/A |
| **Git** | Server-side webhook OR local agent running `git log` on tracked repos | N/A |

## Stack

- **Language (agent)**: Rust (small binary, no runtime) or Go. Rust wins on binary size and no-runtime story.
- **Language (server)**: TypeScript + Next.js (faster iteration, shared types with dashboard).
- **Database**: Postgres (via Supabase for hosted; self-host supported).
- **LLM observability layer**: [Langfuse](https://langfuse.com) self-host, mapped as a consumer of our event stream.
- **Visualization**: Dashboard built in-app (Recharts). Export to Grafana for teams that want it.
- **Auth (cloud)**: Clerk or Supabase Auth. Team-based multi-tenancy.
- **Open source posture**: MIT core (agent + server + dashboard). Paid cloud hosting is the business.

## Key design decisions

### 1. OTel GenAI conventions as the schema

We do NOT invent our own event format. Every field name on `activity_event` maps to an
OpenTelemetry GenAI semantic convention where one exists. This gives us:
- Free interop with Datadog / Honeycomb / Grafana (customers can dual-send).
- A path for Anthropic / OpenAI / Cursor to add first-class support without changing their code.
- No vendor lock-in for customers.

### 2. Accept the WakaTime heartbeat protocol

Zero IDE plugins to ship. Every dev who already uses WakaTime just points their plugin at
our URL. This alone covers 600+ editors and is probably the highest-ROI compatibility
decision we'll ever make.

### 3. Local-first with aggregates-only upload

The agent runs on the dev's machine. It reads Claude Code transcripts, accepts OTel,
computes aggregates, and ships **only those aggregates** to the server. Dev can inspect
(and redact) what leaves their machine. This is the anti-bossware promise.

### 4. No heartbeat interval coupling

Some sources are heartbeat-based (WakaTime = one per 2 min of active typing); others
are event-based (Claude Code = one OTel span per tool call). We store both in the same
table and normalize in the query layer, not on the write path.

### 5. Cost computation at read time

We store tokens, not dollars. Model pricing changes; we keep a versioned price table
and compute cost at query time. Prevents data corruption if prices update.

## Deployment shapes

1. **Self-host (OSS)**: Docker Compose stack — Postgres + server + dashboard. For privacy-sensitive teams.
2. **Pulse Cloud**: Managed multi-tenant SaaS. Team creates org, invites devs, each dev installs the agent with a team key.
3. **BYO warehouse**: Teams with existing observability stacks (Datadog, Snowflake) can forward activity events directly via OTel exporter. No Pulse server needed.

## Non-goals (explicitly)

- No per-keystroke logging.
- No screenshots.
- No prompt/completion storage by default (opt-in only, never for team aggregates).
- No manager-facing "who's been away from keyboard" surveillance metric.
- No replacing Swarmia / LinearB / Jellyfish — we feed them.
