# Research brief: competitive landscape

_Captured 2026-04-21 during initial product discovery. Raw findings; see
`../COMPETITIVE.md` for the distilled version._

## Activity tracking

- **WakaTime** — wakatime.com/pricing. Editor plugins (600+), cloud-only,
  heartbeat protocol is BSD-3 via `wakatime-cli`. Free tier with 2-week history;
  Premium $9/mo; Team $18/dev/mo; Business $49/seat/mo. Loved for low friction;
  hated for not having AI or terminal awareness.
- **ActivityWatch** — activitywatch.net, github.com/ActivityWatch/activitywatch.
  MPL-2.0, 17.3k stars, local-first, Rust core, extensible watchers via REST
  API. No team features. Great foundation/inspiration.
- **CodeTime (Software.com)** — software.com/product/code-time. IDE plugins,
  flow state detection, calendar correlation. $9.95/mo Pro. No AI, no team.
- **Rize.io** — system-level activity (apps, URLs, metadata only). $9.99/mo
  Standard, $23.99/mo Pro. Manager dashboards exist. No git, no AI.
- **Code::Stats** — gamified coding stats. Minimal insights vs WakaTime.
- **Toggl Track** — manual timers + 100+ integrations. Not automated for devs.

## Team engineering metrics

- **Swarmia** — swarmia.com. DORA + SPACE + PR metrics. €20–€39/dev/mo. Free
  under 10 devs. Research-backed. Per-dev cost scales poorly. No AI signals.
- **LinearB** — linearb.io. 21 SDLC metrics, AI code review impact tracking,
  benchmarks from 8M+ PRs. Enterprise pricing. Heavy learning curve; "too much
  data, not enough insight" complaints.
- **Haystack** — usehaystack.io. DORA-focused, risk signals (large PRs, long
  branches, after-hours work). Delivery-focused.
- **Pluralsight Flow** (ex-GitPrime) — git analytics. Acquired by Appfire Feb
  2025. Consolidation risk.
- **Jellyfish** — jellyfish.co. DORA/SPACE + OKR alignment + recent "AI Impact"
  addition. Enterprise-only. Natural-language AI query assistant.
- **GitClear** — gitclear.com. 65+ metrics including **explicit AI-generated
  code tracking** via commit signature detection. Newer player. Closest
  existing competitor on the AI-attribution angle.
- **Code Climate Velocity** — 30+ metrics, "Impact" weighting. No AI.

## AI-code-assist specific

- **Cursor Admin API** — cursor.com/docs/account/teams/analytics. Team
  analytics: per-user acceptance rate, lines generated, AI share of committed
  code, spend tracking, weekly/monthly actives. Service-key auth. Very
  complete for Cursor-only teams.
- **GitHub Copilot for Business** — docs.github.com/en/copilot/concepts/copilot-usage-metrics.
  Public Metrics API, 28-day rolling window, per-user acceptance rate, agent
  adoption %, 2-day delay. Best-documented AI admin API.
- **Windsurf (Codeium)** — windsurf.com/team/analytics. % Code Written by AI,
  tool calls, credit consumption. Teams $30/user/mo.
- **Tabnine Enterprise** — Usage Metrics API via bearer token. Enterprise only.
- **Sourcegraph Cody** — cody-analytics.sourcegraph.com. Public dashboard with
  completion acceptance rate, retention, install counts by language. Cody only.
- **Continue.dev** — docs.continue.dev/customize/telemetry. Apache-2.0 OSS.
  PostHog-based anonymous telemetry. **No team analytics at all.**

## LLM observability (adjacent, not competitive)

- **Langfuse** — MIT core + `/ee`. 25.3k stars. Teams/projects, trace-centric,
  ClickHouse-backed. Self-host or cloud. Framework-agnostic.
- **Helicone** — Apache-2.0. Proxy-based, 2B+ interactions processed. 50–80ms
  overhead. Cloudflare Workers + ClickHouse.
- **Arize Phoenix** — Elastic v2. Evaluation + observability.
- **Laminar** — Apache-2.0.

## Anthropic / Claude Code telemetry

- `OTEL_EXPORTER_OTLP_ENDPOINT=...` enables OpenTelemetry export out of the box.
- `OTEL_LOG_TOOL_DETAILS=1` adds MCP server/tool names.
- <10ms async overhead.
- Exports to Honeycomb, Datadog, Grafana, Langfuse, or any OTLP collector.
- Local transcripts in `~/.claude/projects/{path-hash}/*.jsonl`.
  Contains session id, timestamps, tool names, durations, token usage (when
  present), cwd, git branch. **Does NOT record prompt/code content by default.**
- docs.anthropic.com/en/docs/claude-code/monitoring-usage

## Whitespace

1. **Cross-tool AI attribution** (GREENFIELD). Every AI-assist vendor has a
   silo dashboard; no unified view.
2. **Terminal / CLI agent visibility** (BARELY ADDRESSED). WakaTime + IDE
   telemetry miss aider, sgpt, Claude Code CLI, etc.
3. **AI cost → delivery outcome correlation** (EMERGING). GitClear closest,
   but doesn't ingest token costs.
4. **Privacy-first + team-ready** (SMALL GAP). ActivityWatch is privacy-first
   but solo; Swarmia/LinearB/Jellyfish are team-ready but require data sharing.
5. **Outcome-correlated metrics** (STRUCTURAL GAP). Everyone measures pace or
   activity; nobody reliably links AI adoption to shipped value.
