# Research brief: OSS foundations to leverage

_Captured 2026-04-21. Verdicts use {FOUNDATION = build on top, INSPIRATION = borrow
ideas, SKIP = not useful}._

## Activity capture

### ActivityWatch — github.com/ActivityWatch/activitywatch
- MPL-2.0, 17.3k stars, active v0.13.2 (Oct 2024)
- Local-first, Rust server + multi-language clients
- Bucket/event data model, REST API, plugin-friendly watcher architecture
- **Verdict: FOUNDATION** — either fork the client ecosystem or build a server
  that speaks its protocol. The architecture is purpose-built for our case.

### wakatime-cli — github.com/wakatime/wakatime-cli
- BSD-3, Go, widely adopted (Homebrew formula, >100 editor plugins)
- Heartbeat struct: entity (file), language, project, line numbers, timestamp
- **Verdict: INSPIRATION / COMPAT LAYER** — don't fork. Make our server accept
  the wakatime heartbeat protocol. Every existing editor plugin will point at
  our URL instead of wakatime.com. Instant coverage.

## Terminal / shell

### Atuin — github.com/atuinsh/atuin
- MIT, 18k+ stars, Rust
- Shell hook pattern: preexec/precmd → SQLite (cmd, exit code, duration, cwd, ts)
- **Verdict: INSPIRATION** — steal the shell-hook pattern for terminal activity.
  Orthogonal to editor activity; complementary.

## LLM observability

### Langfuse — github.com/langfuse/langfuse
- MIT core (except /ee), 25.3k stars, TypeScript, ClickHouse + Kafka
- Teams/projects, span-based tracing, framework-agnostic SDKs
- **Verdict: FOUNDATION** — self-host it. Map Pulse activity events into its
  trace model where they overlap. Saves us building LLM observability from
  scratch.

### Helicone — github.com/Helicone/helicone
- Apache-2.0, processed 2B+ interactions, 50–80ms overhead
- Proxy-based architecture, Cloudflare Workers + ClickHouse
- **Verdict: INSPIRATION** — good if we want multi-provider routing later.
  Langfuse is simpler to start with.

### Arize Phoenix / Laminar
- Both active. Phoenix = evaluation + observability (Elastic v2).
  Laminar = Apache-2.0 observability.
- **Verdict: SKIP for v1.** Langfuse covers our needs.

## Standards

### OpenTelemetry GenAI Semantic Conventions
- opentelemetry.io/docs/specs/semconv/gen-ai
- CNCF-backed. Span attributes: `gen_ai.request.model`, `gen_ai.usage.input_tokens`,
  `tool.name`, `tool.result`, etc.
- Vendor support: Datadog (v1.37+), Grafana, Honeycomb
- **Verdict: FOUNDATION** — adopt on day one. Build our schema on top.
  Ensures portability and avoids vendor lock-in.

### MCP OpenTelemetry instrumentation
- github.com/theharithsa/opentelemetry-instrumentation-mcp
- Emerging but real. Auto-instruments MCP tool calls.
- **Verdict: FOUNDATION (emerging)** — we're early adopters. Every Claude Code
  MCP server tool call becomes a discrete activity event.

## Analytics / dashboards

### PostHog — github.com/PostHog/posthog
- MIT (OSS), enterprise features separate. ClickHouse + Kafka.
- **Verdict: INSPIRATION** — great for B2B SaaS product metrics; opinionated
  for us. Use Grafana if we want max flexibility, or build in-app.

### Grafana + Prometheus
- The obvious choice for self-host OSS visualization.
- **Verdict: FOUNDATION (optional)** — let users export to Grafana; ship our
  own dashboard as the default.

### Metabase / Superset
- Generic OSS BI.
- **Verdict: SKIP** — too generic; our UX should be purpose-built.

## Git analysis

### Hercules — github.com/src-d/hercules
- Apache-2.0, v9.3.0, DAG-based git analysis, plugin system
- Archived-ish but still maintained
- **Verdict: INSPIRATION** — for correlating git commits with activity
  (commits/hr, churn vs logged time). Run as a background job, don't integrate
  tightly.

## Pragmatic v1 stack

**Build on**:
1. ActivityWatch client ecosystem or protocol
2. WakaTime heartbeat protocol (accept, don't implement)
3. Langfuse (self-host, for LLM span layer)
4. OpenTelemetry GenAI conventions (canonical schema)

**Borrow from**:
- Atuin: shell hooks
- Hercules: git analysis pipeline pattern
- LSP: real-time editor event streaming (if we ever build our own plugin)

**Build from scratch**:
- Unified `activity_event` schema + Postgres store
- API layer (accepts heartbeats, OTel spans, MCP traces, shell events)
- Team dashboard
- Agent binary (Rust or Go)

## License compatibility matrix (for commercial SaaS)

| License | Foundation? | Notes |
|---|---|---|
| MIT | Yes | Default preferred. Langfuse core, PostHog core, Atuin, ActivityWatch-client. |
| BSD-3 | Yes | wakatime-cli. Fine. |
| Apache-2.0 | Yes | Helicone, Laminar, Hercules. Fine with attribution. |
| MPL-2.0 | Yes (careful) | ActivityWatch server. File-level copyleft — must release modifications to MPL'd files. |
| Elastic v2 | No for cloud reselling | Phoenix. Don't offer Phoenix-as-a-service. |
| AGPL | Avoid | Would contaminate closed-source server. |
