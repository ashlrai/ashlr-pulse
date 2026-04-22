# Research brief: AI/agent usage data surface

_Captured 2026-04-21. What's actually capturable, per tool._

## Claude Code (CLI / claude.com/code)

**Local transcripts**:
- `~/.claude/projects/{path-hash}/*.jsonl` — one file per session
- Each line: `timestamp`, `sessionId`, `uuid`, `type`, `userType`, `cwd`, `version`, `gitBranch`
- Contains tool names, command text, durationMs, stdout/stderr, token usage (when available)
- **No prompt/code content by default** — privacy-safe to read
- `~/.claude/history.jsonl` aggregates all sessions

**Built-in OTel**:
- `OTEL_EXPORTER_OTLP_ENDPOINT=<url>` — standard OTLP receiver works
- `OTEL_LOG_TOOL_DETAILS=1` adds MCP server/tool names
- Async, <10ms overhead
- Export to Honeycomb, Datadog, Langfuse, Grafana, our own collector
- docs.anthropic.com/en/docs/claude-code/monitoring-usage

**No public API** beyond OTel — local files + OTel stream is the data surface.

## Cursor

**Admin API** — docs.cursor.com/account/teams/admin-api
- Daily Usage Metrics endpoint: code edits, AI assistance, acceptance rate per user/team
- Spend Tracking: monthly cents spent, fast premium requests
- Usage Events: timestamps, model info, token counts (input, output, cache_read, cache_write)
- Max 90 days per request (pagination for longer)
- Auth: team service keys

## GitHub Copilot

**Metrics API** — docs.github.com/en/rest/copilot/copilot-metrics
- Per-user: acceptance rate, suggestion count, daily/weekly active
- Team/org: language breakdown, agent mode adoption %, LoC, PR lifecycle
- 28-day rolling window
- Granularity: daily / weekly / aggregated
- Auth: OAuth or PAT (classic) with `manage_billing:copilot` or `read:enterprise`
- 2-day data delay

## Codeium / Windsurf

**Enterprise API** — docs.windsurf.com
- `https://server.codeium.com/api/v1/`
- CascadeAnalytics endpoint, date ranges + user email filters
- Enterprise-only
- Less mature docs than Cursor/Copilot

## Continue.dev

- docs.continue.dev/customize/telemetry
- PostHog-based anonymized telemetry
- Suggestion interactions (accept/reject), model/command used, token counts, OS/IDE info
- Local logs: `~/.continue/logs/core.log`
- `level: noCode` config strips prompts/completions
- **No team analytics at all** — individual opt-in telemetry only

## Tabnine

**Usage Metrics API** — docs.tabnine.com/main/administering-tabnine/managing-your-team/tabnine-apis/usage-metrics-api-2
- Active users, chat activity, productivity factor, automation factor
- Bearer token auth
- Date range + granularity filters
- Enterprise SaaS + private installations

## Sourcegraph Cody

- cody-analytics.sourcegraph.com — public dashboard
- DAU, Completion Acceptance Rate (CAR), retention, installations by language/user
- Looker + Amplitude; public CSV exports
- Cody-only

## Zed

- zed.dev/agent-metrics — public weekly-refresh dashboard, anonymized
- Telemetry every 5 min or 50 events → Snowflake
- Does NOT store prompts/code unless explicitly shared
- Team-level visibility coming

## Aider / shell agents

- No built-in telemetry/admin API
- Options:
  1. PTY recording (asciinema or `script(1)` wrapper) — captures I/O, not token counts
  2. LLM provider logs (Anthropic Console etc.) — weak per-tool granularity
  3. Process-level: wrapper script counting invocations + duration

## OpenTelemetry GenAI semantic conventions

- opentelemetry.io/docs/specs/semconv/gen-ai
- Experimental (not stable yet) but widely adopted
- Spans for agent creation, invocation, tool calls, LLM calls
- Attributes: `gen_ai.request.model`, `gen_ai.request.temperature`,
  `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `tool.name`, `tool.result`
- Events/metrics/logs all covered

## MCP protocol

- modelcontextprotocol.io
- Notifications for tool list changes, resource changes
- No built-in telemetry event stream; OTel instrumentation via third-party pkg

## Privacy denominator (safe across all tools)

```json
{
  "duration_ms": 3200,
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "tokens": { "input": 450, "output": 280, "cache_read": 0, "cache_write": 0 },
  "tool_calls": { "count": 3, "types": ["bash", "read", "edit"] },
  "accepted_count": 5,
  "rejected_count": 1,
  "project_hash": "sha256(cwd)",
  "repo_name": "AshlrAI/cotidie",
  "git_branch": "main",
  "language": "typescript",
  "cost_usd_cents": 47
}
```

This set is obtainable from every tool above (with varying precision) and
contains no prompt/code content. It's the canonical Pulse schema.

## Highest-ROI integration order

1. **Claude Code OTel** — free telemetry, Mason dogfoods this immediately.
2. **WakaTime heartbeat protocol** — instant coverage for 600+ editor plugins.
3. **Cursor Admin API** — high-value for teams using Cursor.
4. **Copilot Metrics API** — high-value for teams on GitHub Enterprise.
5. **Windsurf / Tabnine** — lower priority, niche.
6. **Claude Code local JSONL** — optional, for fuller fidelity beyond what OTel emits.
7. **Shell hooks (aider, sgpt)** — fills the CLI-agent gap.
8. **Git ingester** — correlation layer.
